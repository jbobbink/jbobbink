// Builds dark_mode.svg and light_mode.svg: the ASCII portrait on the left, a
// neofetch-style info panel on the right with live GitHub stats.
//
//   node scripts/update.mjs            # needs ACCESS_TOKEN or GITHUB_TOKEN
//   node scripts/update.mjs --offline  # no token: public REST numbers + cache
//
// No dependencies; runs on the Node that ships with GitHub's runners.
// Lines of code: for every repo the token can read, sums additions/deletions of
// the commits you authored on the default branch. Results are cached per repo
// (keyed by a hash of the repo name, so private repo names never land in the
// public cache file) and only recounted when that branch's head moves.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cfg = JSON.parse(readFileSync(join(ROOT, "profile.config.json"), "utf8"));
const OFFLINE = process.argv.includes("--offline");
const TOKEN = process.env.ACCESS_TOKEN || process.env.GITHUB_TOKEN || "";
const CACHE_FILE = join(ROOT, "cache", "stats.json");

// ---------- GitHub API ----------

async function gql(query, variables = {}, attempt = 0) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "profile-card",
    },
    body: JSON.stringify({ query, variables }),
  });
  // History queries with additions/deletions time out on big pages; retry.
  if ((res.status === 502 || res.status === 504) && attempt < 4) {
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    return gql(query, variables, attempt + 1);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.errors) {
    throw new Error(`GraphQL ${res.status}: ${JSON.stringify(body.errors || body).slice(0, 500)}`);
  }
  return body.data;
}

async function rest(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { "User-Agent": "profile-card", Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`REST ${path}: ${res.status}`);
  return res.json();
}

const hash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

async function fetchUser() {
  const d = await gql(
    `query($login: String!) {
      user(login: $login) {
        id createdAt
        followers { totalCount }
        repositoriesContributedTo(includeUserRepositories: true,
          contributionTypes: [COMMIT, PULL_REQUEST, REPOSITORY]) { totalCount }
      }
    }`,
    { login: cfg.login },
  );
  return d.user;
}

async function fetchRepos() {
  // OWNER for the repo count and stars; collaborator/org repos only feed LOC.
  const all = [];
  let after = null;
  do {
    const d = await gql(
      `query($login: String!, $after: String) {
        user(login: $login) {
          repositories(first: 100, after: $after,
            ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]) {
            pageInfo { hasNextPage endCursor }
            nodes {
              nameWithOwner stargazerCount isFork
              owner { login }
              defaultBranchRef { target { ... on Commit { oid } } }
            }
          }
        }
      }`,
      { login: cfg.login, after },
    );
    const page = d.user.repositories;
    all.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return all;
}

async function fetchCommitTotal(createdAt) {
  // contributionsCollection spans at most one year, so ask per year via aliases.
  const start = new Date(createdAt).getUTCFullYear();
  const now = new Date();
  const parts = [];
  for (let y = start; y <= now.getUTCFullYear(); y++) {
    const to = y === now.getUTCFullYear() ? now.toISOString() : `${y}-12-31T23:59:59Z`;
    parts.push(`y${y}: contributionsCollection(from: "${y}-01-01T00:00:00Z", to: "${to}") { totalCommitContributions }`);
  }
  const d = await gql(`query($login: String!) { user(login: $login) { ${parts.join("\n")} } }`, {
    login: cfg.login,
  });
  return Object.values(d.user).reduce((s, c) => s + c.totalCommitContributions, 0);
}

async function countRepoLoc(nameWithOwner, authorId) {
  const [owner, name] = nameWithOwner.split("/");
  let additions = 0, deletions = 0, commits = 0, after = null, pageSize = 50;
  do {
    let d;
    try {
      d = await gql(
        `query($owner: String!, $name: String!, $after: String, $author: ID!, $n: Int!) {
          repository(owner: $owner, name: $name) {
            defaultBranchRef { target { ... on Commit {
              history(first: $n, after: $after, author: { id: $author }) {
                pageInfo { hasNextPage endCursor }
                nodes { additions deletions }
              }
            } } }
          }
        }`,
        { owner, name, after, author: authorId, n: pageSize },
      );
    } catch (e) {
      if (pageSize > 10) { pageSize = Math.floor(pageSize / 2); continue; }
      throw e;
    }
    const h = d.repository?.defaultBranchRef?.target?.history;
    if (!h) break;
    for (const c of h.nodes) {
      // Skip giant commits (vendored code, lockfiles, generated output).
      if (c.additions + c.deletions > cfg.locSkipCommitsOver) continue;
      additions += c.additions;
      deletions += c.deletions;
      commits++;
    }
    after = h.pageInfo.hasNextPage ? h.pageInfo.endCursor : null;
  } while (after);
  return { additions, deletions, commits };
}

async function collectStats(cache) {
  if (OFFLINE || !TOKEN) {
    console.log(OFFLINE ? "offline mode" : "no token: offline mode");
    const user = await rest(`/users/${cfg.login}`);
    const repos = await rest(`/users/${cfg.login}/repos?per_page=100&type=owner`);
    return {
      ...cache.stats,
      repos: user.public_repos,
      stars: repos.reduce((s, r) => s + r.stargazers_count, 0),
      followers: user.followers,
    };
  }

  const user = await fetchUser();
  const repos = await fetchRepos();
  const owned = repos.filter((r) => r.owner.login.toLowerCase() === cfg.login.toLowerCase());
  const commits = await fetchCommitTotal(user.createdAt);

  const loc = cache.loc || {};
  const seen = new Set();
  for (const r of repos) {
    const oid = r.defaultBranchRef?.target?.oid;
    if (!oid) continue;
    const key = hash(r.nameWithOwner);
    seen.add(key);
    if (loc[key]?.oid === oid) continue;
    console.log(`counting ${key} ...`);
    try {
      loc[key] = { oid, ...(await countRepoLoc(r.nameWithOwner, user.id)) };
    } catch (e) {
      // Keep the previous count rather than failing the whole run.
      console.warn(`skip ${key}: ${e.message}`);
    }
  }
  for (const k of Object.keys(loc)) if (!seen.has(k)) delete loc[k];
  cache.loc = loc;

  const vals = Object.values(loc);
  return {
    repos: owned.length,
    contributed: user.repositoriesContributedTo.totalCount,
    stars: owned.reduce((s, r) => s + r.stargazerCount, 0),
    followers: user.followers.totalCount,
    commits,
    additions: vals.reduce((s, v) => s + v.additions, 0),
    deletions: vals.reduce((s, v) => s + v.deletions, 0),
  };
}

// ---------- layout ----------

function uptime(since) {
  const a = new Date(since + "T00:00:00Z");
  const b = new Date();
  let y = b.getUTCFullYear() - a.getUTCFullYear();
  let m = b.getUTCMonth() - a.getUTCMonth();
  let d = b.getUTCDate() - a.getUTCDate();
  if (d < 0) {
    m--;
    d += new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), 0)).getUTCDate();
  }
  if (m < 0) { y--; m += 12; }
  const p = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  return `${p(y, "year")}, ${p(m, "month")}, ${p(d, "day")}`;
}

const fmt = (n) => (n == null ? "?" : n.toLocaleString("en-US"));
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// A line is a list of [text, class] spans; class null = plain foreground.
function kv(key, value, width, valueSpans) {
  const head = `. ${key}:`;
  const vlen = valueSpans ? valueSpans.reduce((s, [t]) => s + t.length, 0) : value.length;
  const dots = width - head.length - vlen - 2;
  if (dots < 1) throw new Error(`line too long for width ${width}: ${key}: ${value ?? ""}`);
  return [
    [". ", "cc"], [key, "key"], [":", null], [" " + ".".repeat(dots) + " ", "cc"],
    ...(valueSpans || [[value, "value"]]),
  ];
}

function rule(title, width) {
  const head = title ? `- ${title} ` : "";
  return [[head, null], ["─".repeat(width - head.length - 3), "cc"], ["-—-", "cc"]];
}

function buildLines(stats) {
  const W = cfg.width;
  const lines = [];
  lines.push([[cfg.header, null], [" ", null], ...rule("", W - cfg.header.length - 1)]);
  cfg.sections.forEach((section, i) => {
    if (i) lines.push([]);
    for (const [k, v] of section) {
      lines.push(kv(k, v.replace("{uptime}", uptime(cfg.uptimeSince)), W));
    }
  });
  lines.push([]);
  lines.push(rule("Contact", W));
  for (const [k, v] of cfg.contact) lines.push(kv(k, v, W));
  lines.push([]);
  lines.push(rule("GitHub Stats", W));

  // Two columns: left half is fixed width so the "|" separators line up.
  const half = 33;
  const pair = (lk, lv, rk, rv) => {
    const left = kv(lk, lv, half);
    // " | " is 3 chars and the dropped ". " frees 2, so the right side gets W - half - 1.
    const right = kv(rk, rv, W - half - 1).slice(1);
    return [...left, [" | ", null], ...right];
  };
  lines.push(pair("Repos", `${fmt(stats.repos)} {Contributed: ${fmt(stats.contributed)}}`, "Stars", fmt(stats.stars)));
  lines.push(pair("Commits", fmt(stats.commits), "Followers", fmt(stats.followers)));
  const total = stats.additions == null ? null : stats.additions - stats.deletions;
  lines.push(kv("Lines of Code on GitHub", null, W, [
    [fmt(total), "value"], [" ( ", null], [fmt(stats.additions), "add"], ["++", "addColor"],
    [", ", null], [fmt(stats.deletions), "del"], ["--", "delColor"], [" )", null],
  ]));
  return lines;
}

const THEMES = {
  dark: { bg: "#161b22", fg: "#c9d1d9", key: "#ffa657", value: "#a5d6ff", cc: "#616e7f", add: "#3fb950", del: "#f85149", border: "#30363d" },
  light: { bg: "#f6f8fa", fg: "#24292f", key: "#953800", value: "#0a3069", cc: "#c2cfde", add: "#1a7f37", del: "#cf222e", border: "#d0d7de" },
};

function svg(theme, ascii, lines) {
  const t = THEMES[theme];
  const LH = 20, TOP = 30;
  const rows = Math.max(ascii.length, lines.length);
  const H = TOP + rows * LH + 10;
  const W = 1040;
  const INFO_X = 470;
  const art = ascii
    .map((l, i) => `<tspan x="15" y="${TOP + i * LH}">${esc(l)}</tspan>`)
    .join("\n");
  const info = lines
    .map((spans, i) => {
      const inner = spans
        .map(([text, cls]) => {
          const c = cls === "addColor" ? "add" : cls === "delColor" ? "del" : cls;
          return c ? `<tspan class="${c}">${esc(text)}</tspan>` : esc(text);
        })
        .join("");
      return `<tspan x="${INFO_X}" y="${TOP + i * LH}">${inner}</tspan>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" font-family="ConsolasFallback,Consolas,'DejaVu Sans Mono',Menlo,monospace" width="${W}px" height="${H}px" font-size="16px">
<style>
.key {fill: ${t.key};}
.value {fill: ${t.value};}
.cc {fill: ${t.cc};}
.add {fill: ${t.add};}
.del {fill: ${t.del};}
text, tspan {white-space: pre;}
</style>
<rect width="${W}px" height="${H}px" fill="${t.bg}" stroke="${t.border}" rx="15"/>
<text x="15" y="${TOP}" fill="${t.fg}" class="ascii">
${art}
</text>
<text x="${INFO_X}" y="${TOP}" fill="${t.fg}">
${info}
</text>
</svg>
`;
}

// ---------- main ----------

const cache = existsSync(CACHE_FILE)
  ? JSON.parse(readFileSync(CACHE_FILE, "utf8"))
  : { stats: {}, loc: {} };
const stats = await collectStats(cache);
cache.stats = stats;
mkdirSync(dirname(CACHE_FILE), { recursive: true });
writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2) + "\n");

const ascii = readFileSync(join(ROOT, "assets", "ascii.txt"), "utf8").replace(/\r/g, "").replace(/\n+$/, "").split("\n");
const lines = buildLines(stats);
writeFileSync(join(ROOT, "dark_mode.svg"), svg("dark", ascii, lines));
writeFileSync(join(ROOT, "light_mode.svg"), svg("light", ascii, lines));
console.log("stats", stats);
