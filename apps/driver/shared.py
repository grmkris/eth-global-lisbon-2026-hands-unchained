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


# PREVIEW-only knobs (recording opens its own cameras at full quality). The
# encoded bytes feed both the local <img> and the hub push — smaller frames
# keep the push from saturating the uplink, where queued video delays the
# operator's input packets riding the same connection. Lives here so both the
# real capture loop (driver.py) and the sim renderer (backends/sim.py) share
# them without importing the __main__ module.
PREVIEW_QUALITY = _env_int("LAB_PREVIEW_QUALITY", 60, 20, 95)
PREVIEW_WIDTH = _env_int("LAB_PREVIEW_WIDTH", 0, 160, 1920)  # 0 = native

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
