"""Serial-port discovery for SO-10x arms. stdlib only.

The arms enumerate as CDC-ACM (tty.usbmodem*) or CH34x (tty.usbserial* /
tty.wchusbserial*) on macOS, ttyACM*/ttyUSB* on Linux. We stay with the
tty.* names (not cu.*) — every doc, calibration and stored serial in this
project already uses them. Bluetooth ports never match these globs.
"""

import glob
import sys


def candidate_ports() -> list[str]:
    if sys.platform == "darwin":
        patterns = [
            "/dev/tty.usbmodem*",
            "/dev/tty.usbserial*",
            "/dev/tty.wchusbserial*",
        ]
    else:
        patterns = ["/dev/ttyACM*", "/dev/ttyUSB*"]
    found: set[str] = set()
    for pattern in patterns:
        found.update(glob.glob(pattern))
    return sorted(found)


def resolve_follower(explicit: str | None) -> str:
    """Explicit port wins; otherwise exactly one candidate must exist.
    Raises (never prompts) — this runs inside the headless driver subprocess.
    """
    if explicit:
        return explicit
    ports = candidate_ports()
    if len(ports) == 1:
        return ports[0]
    if len(ports) == 0:
        raise RuntimeError(
            "no serial device found — plug in the follower arm (USB), "
            "or set FOLLOWER_PORT=/dev/tty.usbmodemXXXX"
        )
    raise RuntimeError(
        f"several serial devices found ({', '.join(ports)}) — "
        "set FOLLOWER_PORT to the follower's port"
    )
