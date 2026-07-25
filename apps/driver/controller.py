#!/usr/bin/env python
"""Leader agent: plug in your leader arm, run this, drive rigs from the hub UI.

Runs on the OPERATOR's machine (nothing else needed — no console, no driver).
Zero-config: hub defaults to the deployed instance, the leader's serial port
is auto-detected, the agent registers under this machine's hostname. Then
everything happens in the browser — take control of a rig, then click "Drive
with <name>'s leader": the hub BINDS this leader to your browser session (you
keep the lease, so your task attempt keeps running) and this process streams
the leader's lerobot-space action dict (degrees + gripper 0..100) at ~30 Hz to
the rig's remote-joints teleop source. It claims nothing and sends no verbs.

Cross-device is safe by construction: each arm normalizes through its OWN
calibration; the follower's servo EEPROM limits are the hard stop. Losing the
network mid-drive is safe: the rig holds pose after 0.5 s without packets.

    bun run teleop            # from apps/web, or:
    .venv/bin/python controller.py

First run on a new arm enters lerobot's interactive calibration wizard.
Ctrl-C returns to idle (if driving) and exits — the browser keeps the rig.
"""

import argparse
import http.client
import json
import os
import signal
import socket
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from ports import candidate_ports

DEFAULT_HUB = "https://web-production-b5106.up.railway.app"

TOKEN = ""  # set from --token / HUB_TOKEN in main()


def _headers() -> dict:
    h = {"content-type": "application/json"}
    if TOKEN:
        h["authorization"] = f"Bearer {TOKEN}"
    return h


def api_get(hub: str, path: str, timeout: float = 3.0) -> dict:
    req = urllib.request.Request(f"{hub}{path}", headers=_headers(), method="GET")
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

    def post(self, path: str, payload: dict) -> tuple[int, dict]:
        """Returns (status, body). Raises OSError-family on transport failure."""
        try:
            conn = self._connect()
            conn.request(
                "POST",
                path,
                body=json.dumps(payload),
                headers=_headers(),
            )
            res = conn.getresponse()
            raw = res.read()  # drain so the connection is reusable
            try:
                body = json.loads(raw or b"{}")
            except ValueError:
                body = {}
            return res.status, body
        except Exception:
            # drop the connection; next call reopens
            if self.conn is not None:
                self.conn.close()
                self.conn = None
            raise


def open_input_socket(hub: str, name: str):
    """The input plane: one WebSocket carrying ONLY input frames.

    Fire-and-forget, so the loop runs at the full --hz instead of being
    RTT-bound like one-POST-at-a-time keep-alive was (~15 packets/s). Returns
    None when unavailable — the caller then keeps using the HTTP input path,
    which must stay working (old hub, proxy eating the upgrade, vite dev).
    """
    try:
        from websockets.sync.client import connect
    except ImportError:
        print("websockets not installed (uv sync in apps/driver) — using HTTP input")
        return None
    url = re.sub(r"^http", "ws", hub) + "/api/hub/ws?role=leader&name=" + urllib.parse.quote(name)
    if TOKEN:
        url += "&token=" + urllib.parse.quote(TOKEN)
    try:
        return connect(url, open_timeout=3, close_timeout=1)
    except Exception as exc:  # noqa: BLE001 — any failure means: use HTTP
        print(f"input socket unavailable ({exc}) — using HTTP input")
        return None


def default_name() -> str:
    host = socket.gethostname().split(".")[0].lower()
    return re.sub(r"[^a-z0-9-]", "-", host) or "leader"


def resolve_port(explicit: str | None) -> str:
    if explicit:
        return explicit
    ports = candidate_ports()
    if len(ports) == 1:
        print(f"leader port auto-detected: {ports[0]}")
        return ports[0]
    if len(ports) == 0:
        sys.exit("no serial device found — plug in your leader arm (USB) and re-run")
    if not sys.stdin.isatty():
        sys.exit(
            "several serial devices found:\n  "
            + "\n  ".join(ports)
            + "\nre-run with --port <one of these> (or LEADER_PORT env)"
        )
    print("several serial devices found — pick the LEADER arm")
    print("(picking the follower would overwrite its calibration!)")
    for i, p in enumerate(ports):
        print(f"  [{i}] {p}")
    while True:
        choice = input("number: ").strip()
        if choice.isdigit() and int(choice) < len(ports):
            return ports[int(choice)]
        print("invalid choice, try again")


def drive(hub: str, leader, name: str, rig_name: str, hz: float, running) -> None:
    """One driving session: a pure INPUT STREAM.

    This agent claims nothing and sends no verbs. The browser holds the rig's
    lease and the hub binds this leader to that session (and starts the remote
    teleop source) when the operator clicks Drive — so their attempt keeps
    running while the leader drives, and take-over is just the lease changing.
    Returns to idle on stop, on losing the binding, or on Ctrl-C.
    """
    rig = f"/api/hub/rigs/{urllib.parse.quote(rig_name)}"
    client = {"clientId": f"leader-{name}"}
    # short timeout: a stalled POST must not outlive the rig's 0.5s deadman
    link = HubLink(hub, timeout=0.5)

    try:
        summary = api_get(hub, rig)
    except urllib.error.HTTPError as err:
        print(f"rig {rig_name} not found on the hub (HTTP {err.code}) — ignoring")
        return
    if not summary.get("online"):
        print(f"rig {rig_name} is offline — ignoring")
        return

    ws = open_input_socket(hub, name)
    print(f"driving {rig_name} — move the leader. Stop from the web UI or Ctrl-C.")
    sent = dropped = packets = 0
    window = time.time()
    try:
        while running["on"]:
            tick = time.time()
            action = leader.get_action()  # {"<joint>.pos": deg, "gripper.pos": 0..100}
            if ws is not None:
                # fire-and-forget: revocation arrives on the heartbeat below
                try:
                    ws.send(json.dumps({"t": "input", "rig": rig_name, "joints": action}))
                    sent += 1
                except Exception:  # noqa: BLE001 — socket died; HTTP for the rest
                    print("input socket dropped — falling back to HTTP input")
                    try:
                        ws.close()
                    except Exception:  # noqa: BLE001
                        pass
                    ws = None
            else:
                try:
                    status, _ = link.post(f"{rig}/input", {**client, "joints": action})
                    if status == 403:
                        # the browser released the rig or someone else took it
                        print(f"lost {rig_name} (control changed) — back to idle")
                        return
                    sent += 1
                except (TimeoutError, OSError):
                    dropped += 1  # latest-wins on the hub; next packet corrects
            packets += 1
            # heartbeat the leader registry + poll for a web-UI stop (~2x/s).
            # `bound` is the ONLY revocation signal on the socket path.
            if packets % 15 == 0:
                try:
                    _, res = link.post(
                        "/api/hub/leaders/link", {"name": name, "driving": rig_name}
                    )
                    cmd = res.get("command")
                    if cmd and cmd.get("action") == "stop":
                        print("stopped from the web UI — back to idle")
                        return
                    if res.get("bound") is False:
                        print(f"lost {rig_name} (control changed) — back to idle")
                        return
                except (TimeoutError, OSError):
                    pass
            if time.time() - window >= 5.0:
                rate = sent / (time.time() - window)
                via = "socket" if ws is not None else "http"
                print(f"  {rate:.0f} packets/s up via {via}, {dropped} dropped")
                sent = dropped = 0
                window = time.time()
            time.sleep(max(0.0, 1.0 / hz - (time.time() - tick)))
    finally:
        if ws is not None:
            try:
                ws.close()
            except Exception:  # noqa: BLE001
                pass


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--hub",
        default=os.environ.get("HUB_URL") or DEFAULT_HUB,
        help="hub base URL (default: HUB_URL env, then the deployed hub)",
    )
    parser.add_argument(
        "--name",
        default=os.environ.get("LEADER_NAME") or default_name(),
        help="how this leader shows up in the web UI (default: hostname)",
    )
    parser.add_argument(
        "--port",
        default=os.environ.get("LEADER_PORT"),
        help="leader serial port (default: auto-detect)",
    )
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
    source = "--hub" if args.hub != (os.environ.get("HUB_URL") or DEFAULT_HUB) else (
        "HUB_URL env" if os.environ.get("HUB_URL") else "built-in default"
    )
    print(f"hub: {hub} ({source})")

    # hub reachable? fail here, before touching hardware
    try:
        api_get(hub, "/api/hub/leaders")
    except urllib.error.HTTPError as err:
        if err.code == 401:
            sys.exit("hub requires a token — set HUB_TOKEN / --token")
        sys.exit(f"hub error: HTTP {err.code}")
    except OSError as exc:
        sys.exit(f"hub unreachable at {hub} ({exc})")

    port = resolve_port(args.port)
    print("connecting leader (first run on a new arm enters lerobot's calibration wizard)")
    from lerobot.teleoperators.so_leader import SO101Leader, SO101LeaderConfig

    leader = SO101Leader(SO101LeaderConfig(port=port, id=args.id))
    try:
        leader.connect()
    except Exception as exc:  # noqa: BLE001
        sys.exit(
            f"could not open the leader on {port}: {exc}\n"
            "hints: close LeLab/other terminals using the arm; replug and re-run"
        )

    print(f"leader '{args.name}' registered — open a rig on {hub}, take")
    print("control, then click \"Drive with your leader\". Ctrl-C to quit.")

    running = {"on": True}

    def stop(*_sig) -> None:
        running["on"] = False

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    link = HubLink(hub, timeout=2.0)
    while running["on"]:
        try:
            _, res = link.post(
                "/api/hub/leaders/link", {"name": args.name, "driving": None}
            )
            cmd = res.get("command")
            if cmd and cmd.get("action") == "drive" and cmd.get("rig"):
                drive(hub, leader, args.name, cmd["rig"], args.hz, running)
        except (TimeoutError, OSError):
            pass  # hub blip — keep idling, next tick re-registers
        time.sleep(1.0)

    leader.disconnect()
    print("bye")


if __name__ == "__main__":
    main()
