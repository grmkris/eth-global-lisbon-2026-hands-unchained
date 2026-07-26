#!/usr/bin/env python3
"""Downscale the 2K generated photos to deck-sized JPEGs.

The generator writes ~3 MB 2K frames; the deck only ever paints them into a
fixed slot on a 1920x1080 stage. Resize each to 2x its slot's short side so a
retina projector still has pixels to spare, and the design project stays light.

Usage: python3 presentation/optimize.py
"""

from pathlib import Path

from PIL import Image

HERE = Path(__file__).parent
SRC = HERE / "originals"
OUT = HERE / "images"

# id -> the slot's box on the 1920x1080 stage; output is 2x the box.
SLOTS = {
    "photo-chess": (936, 1080),
    "photo-arm-loop": (936, 1080),
    "photo-rig": (816, 696),
    "photo-arm-bleed": (1920, 1080),
}

OUT.mkdir(parents=True, exist_ok=True)

for slot_id, (box_w, box_h) in SLOTS.items():
    src = SRC / f"{slot_id}.jpg"
    if not src.exists():
        print(f"· {slot_id} — no source, skipping")
        continue

    img = Image.open(src).convert("RGB")
    # Cover the 2x box: scale so both dimensions reach it, then centre-crop.
    target_w, target_h = box_w * 2, box_h * 2
    scale = max(target_w / img.width, target_h / img.height)
    resized = img.resize(
        (max(target_w, round(img.width * scale)), max(target_h, round(img.height * scale))),
        Image.LANCZOS,
    )
    left = (resized.width - target_w) // 2
    top = (resized.height - target_h) // 2
    cropped = resized.crop((left, top, left + target_w, top + target_h))

    dst = OUT / f"{slot_id}.jpg"
    cropped.save(dst, "JPEG", quality=82, optimize=True, progressive=True)
    kb = dst.stat().st_size // 1024
    print(f"✓ {dst.relative_to(HERE.parent)} — {target_w}x{target_h}, {kb} KB")
