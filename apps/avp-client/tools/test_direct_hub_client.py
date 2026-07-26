#!/usr/bin/env python3
"""Integration test for the visionOS-native Proof of Hands leader client.

This compiles the real Swift DirectHubLeaderClient with a tiny stand-in for the
RealityKit-facing command type, then runs it against a local HTTP hub fixture.
The fixture deliberately has no WebSocket upgrade, proving that the required
HTTP mailbox fallback remains usable as it does under Vite development.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLIENT = ROOT / "AVPIsaacLeader" / "DirectHubLeaderClient.swift"


class HubFixture(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    links = 0
    link_bodies: list[dict] = []
    inputs: list[dict] = []
    stops: list[dict] = []
    camera_snaps: list[str] = []

    def log_message(self, *_args: object) -> None:
        pass

    def body(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        return json.loads(self.rfile.read(length) or b"{}")

    def reply(self, body: object, status: int = 200) -> None:
        self.reply_bytes(json.dumps(body).encode(), "application/json", status)

    def reply_bytes(self, data: bytes, content_type: str, status: int = 200) -> None:
        self.send_response(status)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self) -> None:  # noqa: N802
        body = self.body()
        if self.path == "/api/hub/leaders/link":
            type(self).links += 1
            type(self).link_bodies.append(body)
            command = {"action": "drive", "rig": "test-rig"} if type(self).links == 1 else None
            self.reply({"bound": True, "command": command})
        elif self.path == "/api/hub/rigs/test-rig/input":
            type(self).inputs.append(body)
            self.reply({"ok": True})
        elif self.path == "/api/hub/leaders/test-avp/command":
            type(self).stops.append(body)
            self.reply({"ok": True})
        else:
            self.reply({"error": "not found"}, 404)

    def do_GET(self) -> None:  # noqa: N802
        # Deliberately reject the WebSocket upgrade. URLSession then has to use
        # POST /input, just as local Vite hub development does.
        if self.path == "/api/hub/ws?role=leader&name=test-avp":
            self.reply({"error": "websocket unavailable"}, 400)
        elif self.path == "/api/hub/rigs/test-rig":
            self.reply({
                "online": True,
                "cams": ["workspace", "wrist", "third"],
                "joints": {
                    "shoulder_pan": 10,
                    "shoulder_lift": -20,
                    "elbow_flex": 30,
                    "wrist_flex": -40,
                    "wrist_roll": 50,
                    "gripper": 60,
                },
            })
        elif self.path in {
            "/api/hub/cams/test-rig/workspace/snap",
            "/api/hub/cams/test-rig/wrist/snap",
        }:
            type(self).camera_snaps.append(self.path)
            self.reply_bytes(b"\xff\xd8camera\xff\xd9", "image/jpeg")
        else:
            self.reply({"error": "not found"}, 404)


SWIFT_STUB = r'''
import Foundation
import Observation

struct VirtualLeaderCommand: Sendable {
    let shoulderPan: Float
    let shoulderLift: Float
    let elbowFlex: Float
    let wristFlex: Float
    let wristRoll: Float
    let gripper: Float
    let armActive: Bool
    let gripperActive: Bool
    let saturation: [String: Int]
}

@main
struct DirectHubClientProbe {
    static func main() async {
        let url = ProcessInfo.processInfo.environment["TEST_HUB_URL"]!
        let client = await MainActor.run { DirectHubLeaderClient() }
        await MainActor.run { client.connect(hubURL: url, token: "", leaderName: "test-avp") }
        try? await Task.sleep(for: .milliseconds(800))
        let bound = await MainActor.run { client.leaderBound && client.selectedRig == "test-rig" }
        guard bound else { fatalError("leader was not bound to test-rig") }
        await MainActor.run { client.arm() }
        let command = VirtualLeaderCommand(
            shoulderPan: 0.3, shoulderLift: -0.2, elbowFlex: 0.1,
            wristFlex: 0, wristRoll: 0, gripper: 0.7,
            armActive: true, gripperActive: true, saturation: [:]
        )
        // Mirror the volume's 30 Hz publication cadence; this is the exact
        // source-freshness contract that prevents a stale active pose replay.
        for _ in 0..<8 {
            await MainActor.run { client.publish(command) }
            try? await Task.sleep(for: .milliseconds(30))
        }
        let active = await MainActor.run { client.mode == "active" && client.armed }
        guard active else { fatalError("client did not enter active motion mode") }
        await MainActor.run { client.stop() }
        try? await Task.sleep(for: .milliseconds(150))
        await MainActor.run { client.disconnect() }
    }
}
'''


class DirectHubClientTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), HubFixture)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.thread.join()

    def test_native_client_heartbeat_telemetry_and_http_fallback(self) -> None:
        HubFixture.links = 0
        HubFixture.link_bodies = []
        HubFixture.inputs = []
        HubFixture.stops = []
        HubFixture.camera_snaps = []
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "probe.swift"
            binary = Path(directory) / "probe"
            source.write_text(SWIFT_STUB)
            subprocess.run(
                [
                    "xcrun", "swiftc", "-parse-as-library", str(CLIENT), str(source),
                    "-o", str(binary),
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            result = subprocess.run(
                [str(binary)],
                check=False,
                capture_output=True,
                text=True,
                timeout=20,
                env={**os.environ, "TEST_HUB_URL": f"http://127.0.0.1:{self.server.server_port}"},
            )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertGreaterEqual(HubFixture.links, 2)
        self.assertEqual(HubFixture.link_bodies[0], {"name": "test-avp", "driving": None})
        self.assertEqual(HubFixture.link_bodies[1], {"name": "test-avp", "driving": "test-rig"})
        self.assertTrue(HubFixture.inputs, "no HTTP input reached the hub fixture")
        first = HubFixture.inputs[0]
        self.assertEqual(first["clientId"], "leader-test-avp")
        self.assertEqual(set(first["joints"]), {
            "shoulder_pan.pos", "shoulder_lift.pos", "elbow_flex.pos",
            "wrist_flex.pos", "wrist_roll.pos", "gripper.pos",
        })
        self.assertTrue(HubFixture.stops)
        self.assertEqual(HubFixture.stops[-1]["action"], "stop")
        self.assertEqual(
            set(HubFixture.camera_snaps),
            {
                "/api/hub/cams/test-rig/workspace/snap",
                "/api/hub/cams/test-rig/wrist/snap",
            },
        )


if __name__ == "__main__":
    unittest.main()
