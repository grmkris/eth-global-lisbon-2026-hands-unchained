#!/usr/bin/env python
"""Leader-over-wire controller: your leader arm drives a remote rig via the hub.

Runs on the OPERATOR's machine (nothing else needed — no console, no driver).
Reads the local leader at ~30 Hz and ships its lerobot-space action dict
(degrees + gripper 0..100) to the hub, which relays it to the rig's
remote-joints teleop source. Cross-device is safe by construction: each arm
normalizes through its OWN calibration; the servo EEPROM limits on the
follower side are the hard stop.

Usage (from app/driver, after `uv sync` and calibrating the leader with id
`arm`):

    .venv/bin/python controller.py \
        --hub https://hub-production-3903.up.railway.app \
        --rig kris-sim \
        --port /dev/tty.usbmodemXXXX

Ctrl-C stops teleop and releases the rig. Losing the network mid-run is safe:
the rig holds pose after 0.5 s without packets.
"""

import argparse
import http.client
import json
import os
import signal
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from lerobot.teleoperators.so_leader import SO101Leader, SO101LeaderConfig


TOKEN = ""  # set from --token / HUB_TOKEN in main()


def _headers() -> dict:
    h = {"content-type": "application/json"}
    if TOKEN:
        h["authorization"] = f"Bearer {TOKEN}"
    return h


def api(hub: str, path: str, payload: dict, timeout: float = 2.0) -> dict:
    req = urllib.request.Request(
        f"{hub}{path}",
        data=json.dumps(payload).encode(),
        headers=_headers(),
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read() or b"{}")


class HubLink:
    """One kept-alive HTTPS connection for the 30Hz input stream. A fresh
    urllib request pays a full TLS handshake per POST (~150ms), which capped
    the stream at ~6 packets/s; keep-alive is RTT-bound (~15-16/s)."""

    def __init__(self, hub: str, timeout: float = 0.5) -> None:
        u = urllib.parse.urlparse(hub)
        self.host = u.netloc
        self.https = u.scheme == "https"
        self.timeout = timeout
        self.conn: http.client.HTTPConnection | None = None

    def _connect(self) -> http.client.HTTPConnection:
        if self.conn is None:
            cls = http.client.HTTPSConnection if self.https else http.client.HTTPConnection
            self.conn = cls(self.host, timeout=self.timeout)
        return self.conn

    def post(self, path: str, payload: dict) -> int:
        """Returns the HTTP status. Raises OSError-family on transport failure."""
        try:
            conn = self._connect()
            conn.request(
                "POST",
                path,
                body=json.dumps(payload),
                headers=_headers(),
            )
            res = conn.getresponse()
            res.read()  # drain so the connection is reusable
            return res.status
        except Exception:
            # drop the connection; next call reopens
            if self.conn is not None:
                self.conn.close()
                self.conn = None
            raise


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--hub", required=True, help="hub base URL")
    parser.add_argument("--rig", required=True, help="rig name from the lobby")
    parser.add_argument("--port", required=True, help="leader serial port")
    parser.add_argument("--id", default="arm", help="leader calibration id")
    parser.add_argument("--hz", type=float, default=30.0)
    parser.add_argument(
        "--token",
        default=os.environ.get("HUB_TOKEN", ""),
        help="hub shared secret (default: HUB_TOKEN env)",
    )
    args = parser.parse_args()
    global TOKEN
    TOKEN = args.token

    hub = args.hub.rstrip("/")
    rig = f"/api/hub/rigs/{args.rig}"
    client = {"clientId": f"leader-{int(time.time()) % 100000}"}

    print(f"connecting leader on {args.port} …")
    leader = SO101Leader(SO101LeaderConfig(port=args.port, id=args.id))
    leader.connect()
    print("leader up — claiming the rig")

    try:
        api(hub, f"{rig}/claim", client)
    except urllib.error.HTTPError as err:
        if err.code == 409:
            sys.exit("rig is held by another operator — try again later")
        raise
    api(hub, f"{rig}/command", {**client, "verb": "teleop_start_remote"})
    print("driving — move the leader. Ctrl-C to stop.")

    running = True

    def stop(*_sig) -> None:
        nonlocal running
        running = False

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    link = HubLink(hub)
    lease_lost = False
    sent = dropped = 0
    window = time.time()
    while running:
        tick = time.time()
        action = leader.get_action()  # {"<joint>.pos": deg, "gripper.pos": 0..100}
        try:
            status = link.post(f"{rig}/input", {**client, "joints": action})
            if status == 403:
                # someone force-took the rig in the browser — it's theirs now
                print("lost the rig (someone took over) — exiting")
                lease_lost = True
                break
            sent += 1
        except (TimeoutError, OSError):
            dropped += 1  # latest-wins on the hub; the next packet corrects
        if time.time() - window >= 5.0:
            rate = sent / (time.time() - window)
            print(f"  {rate:.0f} packets/s up, {dropped} dropped")
            sent = dropped = 0
            window = time.time()
        time.sleep(max(0.0, 1.0 / args.hz - (time.time() - tick)))

    if not lease_lost:
        # normal exit: stop the session and hand the rig back
        print("\nstopping teleop, releasing the rig")
        for path, payload in (
            (f"{rig}/command", {**client, "verb": "teleop_stop"}),
            (f"{rig}/release", client),
        ):
            try:
                api(hub, path, payload)
            except Exception:  # noqa: BLE001 — best effort on the way out
                pass
    leader.disconnect()


if __name__ == "__main__":
    main()
