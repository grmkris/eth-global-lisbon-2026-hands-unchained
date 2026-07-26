#!/usr/bin/env python3
"""Derive the working asset set from the final `logo.png`.

`logo.png` is a finished artwork, not a toolkit: neon cyan artwork sitting on a
dark navy plate with a grid and registration corners baked in, no alpha, raster
only. Three different places need three different things from it, so this cuts
them all from the one source.

    logo-plate.png   the whole thing, downscaled       README hero, cover slide
    logo-art.png     artwork only, transparent          dark grounds
    logo-mask.pbm    1-bit mask for potrace             -> trace-logo.py -> SVG

The plate separates on luminance alone: the artwork sits around 5% of pixels
above L=80 with a flat gap either side, so a single threshold lifts the strokes
and leaves the plate, its grid and its corner marks behind. The threshold has to
land above the glow halo, or the trace picks up a fuzzy outline around every
stroke — hence --threshold and the coverage report.

Usage:
    python3 presentation/extract-logo.py                    # all three
    python3 presentation/extract-logo.py --threshold 105    # tighter on glow
"""

import argparse
from pathlib import Path

from PIL import Image, ImageOps

HERE = Path(__file__).parent
ROOT = HERE.parent

parser = argparse.ArgumentParser()
parser.add_argument("--src", default=str(ROOT / "logo.png"))
parser.add_argument("--threshold", type=int, default=95,
                    help="luminance cutoff separating artwork from plate (0-255)")
parser.add_argument("--plate-width", type=int, default=1024)
parser.add_argument("--pad", type=float, default=0.06,
                    help="margin around the artwork in logo-art.png, as a fraction")
args = parser.parse_args()

src = Image.open(args.src).convert("RGB")
print(f"source: {args.src}  {src.size[0]}x{src.size[1]}")

# ── 1. the plate, downscaled ──────────────────────────────────────────────────
plate = src.copy()
plate.thumbnail((args.plate_width, args.plate_width), Image.LANCZOS)
plate_path = HERE / "logo-plate.png"
plate.save(plate_path, "PNG", optimize=True)
print(f"✓ {plate_path.name}  {plate.size[0]}x{plate.size[1]}  "
      f"{plate_path.stat().st_size // 1024} KB")

# ── 2. artwork only, transparent ──────────────────────────────────────────────
# Alpha ramps from 0 at the threshold to opaque a little above it, so the strokes
# keep their soft edge instead of going hard and jagged.
lum = src.convert("L")
lo, hi = args.threshold, min(255, args.threshold + 45)
alpha = lum.point(lambda v: 0 if v <= lo else (255 if v >= hi else int(255 * (v - lo) / (hi - lo))))

coverage = 100 * sum(1 for p in alpha.getdata() if p > 0) / (src.width * src.height)
print(f"  threshold {args.threshold}: artwork covers {coverage:.2f}% of the canvas")

art = src.copy()
art.putalpha(alpha)
bbox = alpha.getbbox()
if bbox is None:
    raise SystemExit("nothing above the threshold — lower --threshold")
art = art.crop(bbox)
pad = int(max(art.size) * args.pad)
art = ImageOps.expand(art, border=pad, fill=(0, 0, 0, 0))
art_path = HERE / "logo-art.png"
art.save(art_path, "PNG", optimize=True)
ratio = art.size[0] / art.size[1]
print(f"✓ {art_path.name}  {art.size[0]}x{art.size[1]}  ratio {ratio:.2f}:1  "
      f"{art_path.stat().st_size // 1024} KB")

# ── 3. the small cut: the worker's arm alone ──────────────────────────────────
# The full lockup is ~1.7:1 and illustrative, so at nav and favicon sizes it
# turns to mush — measured, not assumed. Cropping to the arm spends the whole
# height budget on one form and still reads as a flexed arm at 22px. Kept as
# raster rather than traced: the antialiasing and the cyan gradient are doing
# real legibility work down there, and the app is permanently dark so there is
# nothing for currentColor to buy.
arm = art.crop((0, 0, int(art.width * 0.42), art.height))
arm_box = arm.split()[3].getbbox()
if arm_box:
    arm = arm.crop(arm_box)
arm.thumbnail((256, 256), Image.LANCZOS)
arm_path = HERE / "logo-arm.png"
arm.save(arm_path, "PNG", optimize=True)
print(f"✓ {arm_path.name}  {arm.size[0]}x{arm.size[1]}  "
      f"{arm_path.stat().st_size // 1024} KB  (app nav + favicon)")

# ── 4. 1-bit mask for potrace ─────────────────────────────────────────────────
# potrace traces black on white, so the artwork has to be the black.
mask = alpha.point(lambda v: 0 if v > 110 else 255, "L").convert("1")
mask_box = ImageOps.invert(mask.convert("L")).getbbox()
if mask_box:
    mask = mask.crop(mask_box)
pad = int(max(mask.size) * args.pad)
mask = ImageOps.expand(mask, border=pad, fill=1)
mask_path = HERE / "logo-mask.pbm"
mask.save(mask_path)
print(f"✓ {mask_path.name}  {mask.size[0]}x{mask.size[1]}  → feed to trace-logo.py --input")
