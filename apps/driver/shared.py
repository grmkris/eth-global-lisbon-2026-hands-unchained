"""Shared driver state: frame buffers for the MJPEG server + protocol emit."""

import json
import os
import sys
import threading

FRAMES: dict[str, bytes] = {}
BRIGHTNESS: dict[str, float] = {}
LOCK = threading.Lock()


def _env_int(name: str, default: int, lo: int, hi: int) -> int:
    """Bounded env knob — a typo'd value falls back instead of e.g. quality 0."""
    try:
        value = int(os.environ.get(name, ""))
    except ValueError:
        return default
    return value if lo <= value <= hi else default


# PREVIEW-only knobs (recording opens its own cameras at full quality — a
# downscaled preview NEVER reaches a dataset). The encoded bytes feed both the
# local <img> and the hub push — smaller frames keep the push from saturating
# the uplink, where queued video delays the operator's input packets riding the
# same connection. Lives here so both the real capture loop (driver.py) and the
# sim renderer (backends/sim.py) share them without importing the __main__
# module.
#
# The default downscales, because resolution is the only lever that pays.
# Measured on a real frame off the deployed rig: quality 60 -> 45 saves 6% of
# the bytes, while 640px -> 480px at quality 50 saves 44% (23.7 KB -> 13.2 KB).
# That is what buys the 50ms push cadence in rig/link.ts — 20fps at 480px costs
# LESS uplink than 12.5fps at native did, and at a hackathon the rig's uplink
# and every booth viewer's downlink are the same shared radio, so every byte is
# paid for twice.
PREVIEW_QUALITY = _env_int("LAB_PREVIEW_QUALITY", 50, 20, 95)
PREVIEW_WIDTH = _env_int("LAB_PREVIEW_WIDTH", 480, 160, 1920)  # 0 = native

_EMIT_LOCK = threading.Lock()  # emit happens from worker threads too

# The protocol stream is captured at import time; driver.main() then points
# sys.stdout at stderr so stray library print()s (hebi warnings, lerobot
# calibration prompts) can never corrupt the ndjson protocol.
_PROTO = sys.stdout


def emit(obj) -> None:
    with _EMIT_LOCK:
        _PROTO.write(json.dumps(obj) + "\n")
        _PROTO.flush()


def log(msg: str) -> None:
    print(f"[driver] {msg}", file=sys.stderr, flush=True)
