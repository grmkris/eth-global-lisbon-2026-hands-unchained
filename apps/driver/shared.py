"""Shared driver state: frame buffers for the MJPEG server + protocol emit."""

import json
import sys
import threading

FRAMES: dict[str, bytes] = {}
BRIGHTNESS: dict[str, float] = {}
LOCK = threading.Lock()

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
