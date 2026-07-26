#!/usr/bin/env python3
"""Trace a generated logo concept into a clean, currentColor-tintable SVG.

The concepts come out of Gemini as raster line art, which is the wrong end state
for a mark that has to sit in a slide corner at 20px and inherit the deck's
accent. potrace turns the black strokes into filled outlines — those scale
perfectly and take `fill: currentColor`, so the mark tints itself exactly like
the rest of the blueprint system.

Usage:
    python3 presentation/trace-logo.py split-4              # -> logo.svg
    python3 presentation/trace-logo.py split-4 --out mark.svg
    python3 presentation/trace-logo.py split-4 --threshold 150 --smooth 1.2
"""

import argparse
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageOps

HERE = Path(__file__).parent
SRC_DIR = HERE / "logo-concepts"

parser = argparse.ArgumentParser()
parser.add_argument("concept", nargs="?", default=None,
                    help="stem in logo-concepts/, e.g. split-4")
parser.add_argument("--input", default=None,
                    help="trace this image instead (e.g. the mask from extract-logo.py)")
parser.add_argument("--out", default=None, help="output .svg (default logo.svg beside this script)")
parser.add_argument("--threshold", type=int, default=140, help="ink cutoff, 0-255")
parser.add_argument("--smooth", type=float, default=1.0, help="potrace --alphamax (corner smoothing)")
parser.add_argument("--tolerance", type=float, default=0.35, help="potrace --opttolerance")
parser.add_argument("--width", type=int, default=1200, help="bitmap width fed to potrace")
args = parser.parse_args()

if shutil.which("potrace") is None:
    sys.exit("potrace not found — install it (apt install potrace)")

if args.input is not None:
    src = Path(args.input)
    if not src.exists():
        sys.exit(f"no such file: {src}")
elif args.concept is not None:
    matches = sorted(SRC_DIR.glob(f"{args.concept}.*"))
    if not matches:
        sys.exit(f"no source image for {args.concept!r} in {SRC_DIR}")
    src = matches[0]
else:
    sys.exit("give a concept stem or --input")

# ── prepare a clean 1-bit bitmap ──────────────────────────────────────────────
# Trim the generator's own margin so the mark fills its viewBox predictably,
# then square it up. A hard threshold (not dithering) keeps strokes solid.
img = Image.open(src).convert("L")
mono = img.point(lambda v: 0 if v < args.threshold else 255, "L")
bbox = ImageOps.invert(mono).getbbox()
if bbox:
    mono = mono.crop(bbox)

side = max(mono.size)
square = Image.new("L", (side, side), 255)
square.paste(mono, ((side - mono.width) // 2, (side - mono.height) // 2))
scale = args.width / side
square = square.resize((args.width, args.width), Image.LANCZOS)
square = square.point(lambda v: 0 if v < 128 else 255, "1")

with tempfile.TemporaryDirectory() as tmp:
    pbm = Path(tmp) / "mark.pbm"
    svg = Path(tmp) / "mark.svg"
    square.save(pbm)

    subprocess.run(
        [
            "potrace", str(pbm), "-s", "-o", str(svg),
            "--alphamax", str(args.smooth),
            "--opttolerance", str(args.tolerance),
            "--turdsize", "4",          # drop specks from the threshold pass
            "--unit", "10",             # coarser coordinate grid = smaller path data
            "--flat",                   # one <path>, no per-shape <g>
        ],
        check=True,
    )
    traced = svg.read_text()

# ── rewrite potrace's output as a lean, tintable mark ─────────────────────────
paths = re.findall(r'<path[^>]*\sd="([^"]+)"', traced, re.S)
if not paths:
    sys.exit("potrace produced no paths — try a different --threshold")

vb = re.search(r'viewBox="([^"]+)"', traced)
transform = re.search(r'<g[^>]*transform="([^"]+)"', traced)

body = "".join(f'<path d="{d}" />' for d in paths)
if transform:
    body = f'<g transform="{transform.group(1)}">{body}</g>'

view_box = vb.group(1) if vb else f"0 0 {args.width} {args.width}"
out_svg = (
    '<svg xmlns="http://www.w3.org/2000/svg" '
    f'viewBox="{view_box}" fill="currentColor" fill-rule="evenodd" '
    'role="img" aria-label="Hands Unchained">'
    f"{body}</svg>"
)

dest = Path(args.out) if args.out else HERE / "logo.svg"
dest.write_text(out_svg)
print(f"✓ {dest}  —  {len(paths)} path(s), {len(out_svg) // 1024} KB, from {src.name}")
