#!/usr/bin/env python3
"""Trace a flat-colour logo concept into a multi-path, multi-colour SVG.

`trace-logo.py` handles black line art: one potrace pass, one path, one colour,
tintable with currentColor. A colour mark cannot work that way — potrace is a
bitmap tracer and only ever sees ink/no-ink.

So this separates first: snap every pixel to the nearest colour in a supplied
palette, then run potrace once PER COLOUR over that colour's mask, and stack the
results as one <path fill="..."> per layer. Background is dropped, and the layers
are emitted darkest-last so small dark details (chain, outlines) sit on top of
the big light shapes rather than being swallowed by them.

Usage:
    python3 presentation/trace-color.py hu6-colour-1 \\
        --palette E4E8ED:bg C0552B:arm 3E6183:robot 1C2530:chain E3A008:burst \\
        --out presentation/logo-colour.svg
"""

import argparse
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

HERE = Path(__file__).parent
SRC_DIR = HERE / "logo-concepts"

parser = argparse.ArgumentParser()
parser.add_argument("concept", help="stem in logo-concepts/, e.g. hu6-colour-1")
parser.add_argument(
    "--palette",
    nargs="+",
    required=True,
    help="HEX:name entries; the FIRST is treated as the background and dropped",
)
parser.add_argument("--out", default=None)
parser.add_argument("--width", type=int, default=900, help="bitmap width per layer")
parser.add_argument("--smooth", type=float, default=1.3)
parser.add_argument("--tolerance", type=float, default=0.8)
parser.add_argument("--min-share", type=float, default=0.15,
                    help="drop a layer covering less than this %% of the canvas")
args = parser.parse_args()

if shutil.which("potrace") is None:
    sys.exit("potrace not found — install it (apt install potrace)")

matches = sorted(SRC_DIR.glob(f"{args.concept}.*"))
if not matches:
    sys.exit(f"no source image for {args.concept!r} in {SRC_DIR}")
src = matches[0]

palette = []
for entry in args.palette:
    hexpart, _, name = entry.partition(":")
    hexpart = hexpart.lstrip("#")
    rgb = tuple(int(hexpart[i:i + 2], 16) for i in (0, 2, 4))
    palette.append((rgb, name or hexpart, f"#{hexpart.lower()}"))

img = Image.open(src).convert("RGB")
side = max(img.size)
square = Image.new("RGB", (side, side), palette[0][0])
square.paste(img, ((side - img.width) // 2, (side - img.height) // 2))
square = square.resize((args.width, args.width), Image.LANCZOS)
px = square.load()

# Snap every pixel to its nearest palette entry — the generator is asked for flat
# colour but still returns soft edges, and this is what makes the layers clean.
W = args.width
assign = [[0] * W for _ in range(W)]
for y in range(W):
    row = assign[y]
    for x in range(W):
        r, g, b = px[x, y]
        best, bestd = 0, None
        for i, (pr, pg, pb) in enumerate(c[0] for c in palette):
            d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2
            if bestd is None or d < bestd:
                best, bestd = i, d
        row[x] = best

layers = []
with tempfile.TemporaryDirectory() as tmp:
    # index 0 is the background — never drawn
    for i in range(1, len(palette)):
        mask = Image.new("1", (W, W), 1)
        mp = mask.load()
        count = 0
        for y in range(W):
            row = assign[y]
            for x in range(W):
                if row[x] == i:
                    mp[x, y] = 0  # potrace traces black
                    count += 1
        share = 100 * count / (W * W)
        if share < args.min_share:
            print(f"· {palette[i][1]:8} {share:5.2f}% — below --min-share, dropped")
            continue

        pbm = Path(tmp) / f"{i}.pbm"
        out = Path(tmp) / f"{i}.svg"
        mask.save(pbm)
        subprocess.run(
            ["potrace", str(pbm), "-s", "-o", str(out),
             "--alphamax", str(args.smooth), "--opttolerance", str(args.tolerance),
             "--turdsize", "6", "--unit", "10", "--flat"],
            check=True,
        )
        text = out.read_text()
        paths = re.findall(r'<path[^>]*\sd="([^"]+)"', text, re.S)
        if not paths:
            print(f"· {palette[i][1]:8} {share:5.2f}% — traced empty, dropped")
            continue
        vb = re.search(r'viewBox="([^"]+)"', text)
        tf = re.search(r'<g[^>]*transform="([^"]+)"', text)
        layers.append({
            "name": palette[i][1], "hex": palette[i][2], "share": share,
            "d": "".join(paths), "vb": vb.group(1) if vb else f"0 0 {W} {W}",
            "t": tf.group(1) if tf else "",
        })
        print(f"✓ {palette[i][1]:8} {share:5.2f}%  {len(paths)} path(s)")

if not layers:
    sys.exit("every layer was empty — check the palette matches the image")

# Darkest last: small dark details (chain, outlines) must sit above big fills.
lum = lambda h: (int(h[1:3], 16) * 299 + int(h[3:5], 16) * 587 + int(h[5:7], 16) * 114) / 1000
layers.sort(key=lambda l: -lum(l["hex"]))

vb = layers[0]["vb"]
body = "".join(
    f'<g transform="{l["t"]}"><path fill="{l["hex"]}" fill-rule="evenodd" d="{l["d"]}"/></g>'
    if l["t"] else f'<path fill="{l["hex"]}" fill-rule="evenodd" d="{l["d"]}"/>'
    for l in layers
)
svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" role="img" '
       f'aria-label="Hands Unchained">{body}</svg>')

dest = Path(args.out) if args.out else HERE / "logo-colour.svg"
dest.write_text(svg)
print(f"\n✓ {dest} — {len(layers)} layers, {len(svg) // 1024} KB, from {src.name}")
