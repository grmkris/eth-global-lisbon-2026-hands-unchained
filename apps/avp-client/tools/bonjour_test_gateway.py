#!/usr/bin/env python3
"""Advertise a harmless SO-101 test gateway on the local network.

This opens a plain TCP test socket and advertises it through macOS Bonjour. It
never imports LeRobot, opens a serial port, or emits robot commands.
"""

from __future__ import annotations

import argparse
import json
import platform
import shutil
import signal
import socketserver
import subprocess
import sys
from typing import Any

SERVICE_TYPE = "_so101-control._tcp"


class GatewayServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, address: tuple[str, int], gateway_name: str):
        self.gateway_name = gateway_name
        super().__init__(address, GatewayRequestHandler)


class GatewayRequestHandler(socketserver.BaseRequestHandler):
    server: GatewayServer

    def handle(self) -> None:
        peer = f"{self.client_address[0]}:{self.client_address[1]}"
        print(f"AVP test connection from {peer}", flush=True)
        self.send_message(
            {
                "type": "gateway_hello",
                "gateway": self.server.gateway_name,
                "protocol": 1,
                "robot_control": False,
            }
        )

        while data := self.request.recv(4096):
            message = data.decode("utf-8", errors="replace").strip()
            if message:
                print(f"Received test message: {message}", flush=True)
                self.send_message(
                    {
                        "type": "discovery_test_ack",
                        "gateway": self.server.gateway_name,
                        "robot_control": False,
                    }
                )

    def send_message(self, payload: dict[str, Any]) -> None:
        encoded = (json.dumps(payload, separators=(",", ":")) + "\n").encode()
        self.request.sendall(encoded)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--name",
        default=f"{platform.node()} SO-101 Test",
        help="Name shown in the Vision Pro discovery list",
    )
    parser.add_argument("--port", type=int, default=7443)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not 1 <= args.port <= 65535:
        raise SystemExit("--port must be between 1 and 65535")
    if shutil.which("dns-sd") is None:
        raise SystemExit("macOS dns-sd was not found")

    with GatewayServer(("0.0.0.0", args.port), args.name) as server:
        advertiser = subprocess.Popen(
            [
                "dns-sd",
                "-R",
                args.name,
                SERVICE_TYPE,
                "local.",
                str(args.port),
                "mode=test",
                "protocol=1",
                "robot_control=false",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

        running = True

        def stop(_signum: int, _frame: object) -> None:
            nonlocal running
            running = False

        signal.signal(signal.SIGINT, stop)
        signal.signal(signal.SIGTERM, stop)
        print(f'Advertising "{args.name}" as {SERVICE_TYPE} on TCP {args.port}')
        print("This is a discovery test only; no robot is connected.")
        print("Press Control-C to stop.", flush=True)

        server.timeout = 0.2
        try:
            while running:
                server.handle_request()
        finally:
            advertiser.terminate()
            try:
                advertiser.wait(timeout=2)
            except subprocess.TimeoutExpired:
                advertiser.kill()

    return 0


if __name__ == "__main__":
    sys.exit(main())
