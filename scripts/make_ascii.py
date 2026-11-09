"""One-time helper: turn assets/avatar.png into the ASCII portrait on the card.

Writes assets/ascii.txt (dark pixels = dense glyphs). The same text is used in
both the light and dark SVG; on dark it reads as a light drawing, which looks
better than a true negative.

Needs Pillow locally (pip install pillow). The GitHub Action never runs this,
it only reads assets/ascii.txt, so re-run it by hand when the photo changes
(and re-trace SILHOUETTE for the new photo).

    python scripts/make_ascii.py [--rows 26] [--ramp short|medium|long] [--no-equalize]
"""

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageOps

ROOT = Path(__file__).resolve().parent.parent
RAMPS = {  # light -> dense
    "short": " .:-=+*#%@",
    "medium": " .,:;-~=+*ox#%@",
    "long": " .'`^\",:;!i~+_-?]{1)|/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@",
}
# Width / height of one glyph cell (16px monospace, 20px line height).
CELL_ASPECT = 8.8 / 20
# Head-and-shoulders crop of the 346x346 avatar.
CROP = (62, 8, 292, 318)
# Hand-traced head-and-shoulders outline in avatar pixel coordinates. The photo's
# sunlit background is as bright as the face, so without it the outline is lost.
SILHOUETTE = [
    (76, 100), (95, 58), (120, 35), (165, 24), (205, 32), (228, 52), (235, 100),
    (246, 128), (240, 150), (232, 165), (226, 195), (220, 215), (225, 232),
    (240, 245), (275, 268), (330, 295), (346, 305), (346, 346), (0, 346),
    (0, 320), (40, 292), (95, 268), (112, 245), (116, 220), (102, 195),
    (88, 165), (78, 135),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rows", type=int, default=26)
    ap.add_argument("--ramp", choices=RAMPS, default="medium")
    ap.add_argument("--no-equalize", action="store_true")
    ap.add_argument("--blur", type=float, default=1.2)
    ap.add_argument("--out", default=str(ROOT / "assets" / "ascii.txt"))
    args = ap.parse_args()

    gray = ImageOps.grayscale(
        Image.open(ROOT / "assets" / "avatar.png").convert("RGB").crop(CROP))
    w, h = gray.size
    hard = Image.new("L", (w, h), 0)
    ImageDraw.Draw(hard).polygon(
        [(x - CROP[0], y - CROP[1]) for x, y in SILHOUETTE], fill=255)
    soft = hard.filter(ImageFilter.GaussianBlur(2))

    if args.no_equalize:
        gray = ImageOps.autocontrast(gray, cutoff=1, mask=hard)
    else:
        gray = ImageOps.equalize(gray, mask=hard)
    gray = gray.filter(ImageFilter.GaussianBlur(args.blur))
    gray = Image.composite(gray, Image.new("L", (w, h), 255), soft)

    rows = args.rows
    cols = round(rows * (w / h) / CELL_ASPECT)
    ramp = RAMPS[args.ramp]
    px = gray.resize((cols, rows), Image.LANCZOS).load()
    lines = []
    for y in range(rows):
        line = "".join(
            ramp[min(len(ramp) - 1, int((1.0 - px[x, y] / 255.0) * len(ramp)))]
            for x in range(cols))
        lines.append(line.rstrip())
    Path(args.out).write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {args.out} ({cols}x{rows})")


if __name__ == "__main__":
    main()
