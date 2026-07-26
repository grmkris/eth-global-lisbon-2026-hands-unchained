#!/usr/bin/env python3
from __future__ import annotations

import math
import pathlib
import sys
import time
import unittest
from types import SimpleNamespace

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from hub_virtual_leader_gateway import ControlPlaneWorker, HubBridgeState


class FakeHub:
    def __init__(self) -> None:
        self.calls: list[tuple] = []
        self.bound = False
        self.pending: dict | None = None
        self.rows = [
            {
                "name": "test-sim",
                "backend": "sim",
                "armState": "connected",
                "online": True,
                "holder": "browser-session",
                "joints": {
                    "shoulder_pan": 10.0,
                    "shoulder_lift": -20.0,
                    "elbow_flex": 30.0,
                    "wrist_flex": 4.0,
                    "wrist_roll": -5.0,
                    "gripper": 40.0,
                },
            }
        ]

    def list_rigs(self):
        self.calls.append(("list",))
        return self.rows

    def leader_command(self, name, client_id, action, rig=None):
        self.calls.append(("leader_command", name, client_id, action, rig))
        if action == "stop":
            self.bound = False
        return {"ok": True}

    def leader_link(self, name, driving):
        self.calls.append(("leader_link", name, driving))
        command = self.pending
        self.pending = None
        if command and command.get("action") == "drive":
            self.bound = True
        elif command and command.get("action") == "stop":
            self.bound = False
        return {"command": command, "bound": self.bound}

    def input(self, rig, leader_name, joints):
        self.calls.append(("input", rig, leader_name, joints))

    def estop(self, rig, client_id):
        self.calls.append(("estop", rig, client_id))


def args():
    return SimpleNamespace(
        hub_url="https://example.invalid",
        hub_token="",
        http_timeout=1.0,
        name="Test AVP Gateway",
        leader_name="test-avp",
        command_timeout_ms=500.0,
        motion_scale=0.2,
        elbow_motion_scale=1.0,
        edge_rate_deg_s=30.0,
        smoothing_ms=0.0,
        max_speed_deg_s=8.0,
        max_gripper_speed=12.0,
        shoulder_pan_sign=1,
        shoulder_lift_sign=1,
        elbow_flex_sign=1,
        wrist_flex_sign=1,
        wrist_roll_sign=1,
        gripper_sign=1,
    )


class HubVirtualLeaderTests(unittest.TestCase):
    def setUp(self):
        self.state = HubBridgeState(args(), "1234")
        self.hub = FakeHub()
        self.state.hub = self.hub
        self.address = ("192.0.2.10", 12345)
        self.assertTrue(self.state.register_client(self.address))
        paired = self.state.handle_message(
            self.address, {"type": "pair", "code": "1234"}
        )
        self.assertEqual(paired["type"], "paired")

    def test_web_selection_binds_automatically_without_claiming_a_lease(self):
        self.assertEqual(self.state.gateway_hello()["leader_name"], "test-avp")
        self.hub.pending = {"action": "drive", "rig": "test-sim"}
        self.state.update_link()

        state = self.state.snapshot()
        self.assertEqual(state["selected_rig"], "test-sim")
        self.assertTrue(state["leader_bound"])
        self.assertTrue(state["robot_ready"])
        self.assertAlmostEqual(state["actual"]["shoulder_pan"], 10.0)
        self.assertFalse(any(call[0] in {"claim", "release"} for call in self.hub.calls))
        self.assertFalse(
            any(call[0] == "leader_command" and call[3] == "drive" for call in self.hub.calls)
        )

        denied = self.state.handle_message(
            self.address,
            {"type": "take_control", "rig": "test-sim", "force": True},
        )
        self.assertEqual(denied["type"], "error")
        self.assertIn("web interface", denied["message"])

        self.hub.pending = {"action": "stop"}
        self.state.update_link()
        stopped = self.state.snapshot()
        self.assertIsNone(stopped["selected_rig"])
        self.assertFalse(stopped["leader_bound"])

    def test_relative_clutch_starts_at_rig_pose_and_slew_limits_motion(self):
        self.hub.pending = {"action": "drive", "rig": "test-sim"}
        self.state.update_link()
        armed = self.state.handle_message(self.address, {"type": "arm"})
        self.assertTrue(armed["armed"])

        zero = {
            joint: 0.0
            for joint in (
                "shoulder_pan",
                "shoulder_lift",
                "elbow_flex",
                "wrist_flex",
                "wrist_roll",
            )
        }
        self.state.handle_message(
            self.address,
            {
                "type": "control",
                "sequence": 1,
                "joints_rad": zero,
                "gripper": 0.5,
                "arm_active": True,
                "gripper_active": False,
            },
        )
        first = self.state.next_input(0.1)
        self.assertAlmostEqual(first[1]["shoulder_pan.pos"], 10.0)

        moved = dict(zero)
        moved["shoulder_pan"] = math.radians(30)
        self.state.handle_message(
            self.address,
            {
                "type": "control",
                "sequence": 2,
                "joints_rad": moved,
                "gripper": 0.5,
                "arm_active": True,
                "gripper_active": False,
            },
        )
        second = self.state.next_input(0.1)
        self.assertAlmostEqual(second[1]["shoulder_pan.pos"], 10.8, places=5)

        elbow_moved = dict(zero)
        elbow_moved["elbow_flex"] = math.radians(30)
        self.state.handle_message(
            self.address,
            {
                "type": "control",
                "sequence": 3,
                "joints_rad": elbow_moved,
                "gripper": 0.5,
                "arm_active": True,
                "gripper_active": False,
            },
        )
        # Anti-windup holds the target within 20° of telemetry; once the rig
        # follows (telemetry catches up), the remaining travel completes.
        elbow = self.state.next_input(10.0)
        self.assertAlmostEqual(elbow[1]["elbow_flex.pos"], 50.0, places=5)
        self.state.actual["elbow_flex"] = 50.0
        elbow = self.state.next_input(10.0)
        self.assertAlmostEqual(elbow[1]["elbow_flex.pos"], 60.0, places=5)

    def test_rejects_bad_pairing_and_nonfinite_controls(self):
        other = HubBridgeState(args(), "9999")
        address = ("192.0.2.11", 23456)
        other.register_client(address)
        denied = other.handle_message(address, {"type": "pair", "code": "0000"})
        self.assertEqual(denied["type"], "error")

        self.hub.pending = {"action": "drive", "rig": "test-sim"}
        self.state.update_link()
        self.state.arm()
        invalid = self.state.handle_message(
            self.address,
            {
                "type": "control",
                "sequence": 1,
                "joints_rad": {
                    "shoulder_pan": float("nan"),
                    "shoulder_lift": 0,
                    "elbow_flex": 0,
                    "wrist_flex": 0,
                    "wrist_roll": 0,
                },
                "gripper": 0.5,
                "arm_active": True,
                "gripper_active": False,
            },
        )
        self.assertEqual(invalid["type"], "error")

    def test_clutch_reengagement_ratchets_instead_of_resetting(self):
        zero = {
            joint: 0.0
            for joint in (
                "shoulder_pan",
                "shoulder_lift",
                "elbow_flex",
                "wrist_flex",
                "wrist_roll",
            )
        }

        def frame(sequence, pan=0.0, gripper=0.5, arm=False, grip=False):
            joints = dict(zero)
            joints["shoulder_pan"] = pan
            self.state.handle_message(
                self.address,
                {
                    "type": "control",
                    "sequence": sequence,
                    "joints_rad": joints,
                    "gripper": gripper,
                    "arm_active": arm,
                    "gripper_active": grip,
                },
            )

        self.hub.pending = {"action": "drive", "rig": "test-sim"}
        self.state.update_link()
        self.state.handle_message(self.address, {"type": "arm"})

        # Drive the arm to an accumulated target.
        frame(1, arm=True)
        self.state.next_input(10.0)
        frame(2, pan=math.radians(30), arm=True)
        moved = self.state.next_input(10.0)
        self.assertAlmostEqual(moved[1]["shoulder_pan.pos"], 16.0, places=5)

        # The AVP freshness deadman flaps: one inactive frame clears the
        # clutch. Holding must still STREAM (the hub input slot is consume-
        # once with a 500 ms gate; a silent leader starves the rig) and must
        # not move the arm.
        frame(3, pan=math.radians(30))
        holding = self.state.next_input(10.0)
        self.assertIsNotNone(holding)
        self.assertAlmostEqual(holding[1]["shoulder_pan.pos"], 16.0, places=5)

        # Hub telemetry lags behind the commanded pose. Re-engaging must clutch
        # at the commanded target, not snap back toward stale telemetry.
        self.state.actual["shoulder_pan"] = 11.0
        frame(4, pan=math.radians(30), arm=True)
        held = self.state.next_input(10.0)
        self.assertAlmostEqual(held[1]["shoulder_pan.pos"], 16.0, places=5)

        # Gripper progress must ratchet across re-engagements, not reset.
        frame(5, gripper=0.5, grip=True)
        self.state.next_input(10.0)
        frame(6, gripper=1.0, grip=True)
        opened = self.state.next_input(10.0)
        # clamped to telemetry (40) + gripper lead (35) until the rig follows
        self.assertAlmostEqual(opened[1]["gripper.pos"], 75.0, places=5)
        self.state.actual["gripper"] = 75.0
        opened = self.state.next_input(10.0)
        self.assertAlmostEqual(opened[1]["gripper.pos"], 100.0, places=5)
        self.state.actual["gripper"] = 100.0

        frame(7, gripper=1.0)
        held = self.state.next_input(10.0)
        self.assertAlmostEqual(held[1]["gripper.pos"], 100.0, places=5)
        frame(8, gripper=1.0, grip=True)
        reheld = self.state.next_input(10.0)
        self.assertAlmostEqual(reheld[1]["gripper.pos"], 100.0, places=5)
        # Reversing responds immediately — progress ratchets from the held
        # position instead of resetting, bounded by the anti-windup lead.
        frame(9, gripper=0.5, grip=True)
        closing = self.state.next_input(10.0)
        self.assertAlmostEqual(closing[1]["gripper.pos"], 65.0, places=5)
        self.state.actual["gripper"] = 65.0
        closing = self.state.next_input(10.0)
        self.assertAlmostEqual(closing[1]["gripper.pos"], 50.0, places=5)

    def test_smoothing_filters_the_desired_pose(self):
        self.state.args.smoothing_ms = 100.0
        zero = {
            joint: 0.0
            for joint in (
                "shoulder_pan",
                "shoulder_lift",
                "elbow_flex",
                "wrist_flex",
                "wrist_roll",
            )
        }
        self.hub.pending = {"action": "drive", "rig": "test-sim"}
        self.state.update_link()
        self.state.handle_message(self.address, {"type": "arm"})

        frame = {
            "type": "control",
            "gripper": 0.5,
            "arm_active": True,
            "gripper_active": False,
        }
        self.state.handle_message(self.address, {**frame, "sequence": 1, "joints_rad": zero})
        self.state.next_input(0.1)

        moved = dict(zero)
        moved["shoulder_pan"] = math.radians(10)  # desired step: +2.0 at scale 0.2
        self.state.handle_message(self.address, {**frame, "sequence": 2, "joints_rad": moved})
        self.state.next_input(0.1)
        # alpha = dt/(tau+dt) = 0.1/0.2 = 0.5 -> the filter passes half the
        # step (to 11.0) and the slew limiter (8/s * 0.1) caps the tick at
        # 10.8; the next tick converges further to the filtered 11.5.
        self.assertAlmostEqual(self.state.target["shoulder_pan"], 10.8, places=5)
        self.state.next_input(0.1)
        self.assertAlmostEqual(self.state.target["shoulder_pan"], 11.5, places=5)

    def test_edge_continuation_extends_past_the_virtual_envelope(self):
        zero = {
            joint: 0.0
            for joint in (
                "shoulder_pan",
                "shoulder_lift",
                "elbow_flex",
                "wrist_flex",
                "wrist_roll",
            )
        }

        def frame(sequence, saturated=None, elbow=0.0):
            joints = dict(zero)
            joints["elbow_flex"] = elbow
            self.state.handle_message(
                self.address,
                {
                    "type": "control",
                    "sequence": sequence,
                    "joints_rad": joints,
                    "gripper": 0.5,
                    "arm_active": True,
                    "gripper_active": False,
                    "saturated": saturated or {},
                },
            )

        self.hub.pending = {"action": "drive", "rig": "test-sim"}
        self.state.update_link()
        self.state.handle_message(self.address, {"type": "arm"})

        frame(1)
        self.state.next_input(0.1)
        start = self.state.target["elbow_flex"]

        # Virtual elbow parked at its limit, operator keeps pushing: the
        # follower keeps folding at edge_rate even though the virtual joint
        # value no longer changes.
        for seq in range(2, 6):
            frame(seq, saturated={"elbow_flex": 1}, elbow=1.0)
            self.state.next_input(0.1)
        extended = self.state.target["elbow_flex"]
        # edge_rate (30/s) is still governed by the slew limit (8/s here)
        self.assertAlmostEqual(extended - start, 4 * 8.0 * 0.1, places=5)

        # Backing off the edge resumes relative control with no snap-back:
        # the same virtual pose with the flag cleared holds position.
        frame(6, elbow=1.0)
        self.state.next_input(0.1)
        self.assertAlmostEqual(self.state.target["elbow_flex"], extended, places=5)

    def test_gripper_edge_continuation_reaches_the_endpoints(self):
        zero = {
            joint: 0.0
            for joint in (
                "shoulder_pan",
                "shoulder_lift",
                "elbow_flex",
                "wrist_flex",
                "wrist_roll",
            )
        }

        def frame(sequence, gripper, sat=0):
            self.state.handle_message(
                self.address,
                {
                    "type": "control",
                    "sequence": sequence,
                    "joints_rad": zero,
                    "gripper": gripper,
                    "arm_active": False,
                    "gripper_active": True,
                    "saturated": {"gripper": sat},
                },
            )

        self.hub.pending = {"action": "drive", "rig": "test-sim"}
        self.state.update_link()
        self.state.handle_message(self.address, {"type": "arm"})

        # Engage at the middle (rig gripper telemetry = 40), then hold the
        # slider against the open end: the follower keeps opening at
        # max_gripper_speed even though the slider value no longer changes.
        frame(1, gripper=0.5)
        self.state.next_input(0.1)
        start = self.state.target["gripper"]
        for seq in range(2, 6):
            frame(seq, gripper=1.0, sat=1)
            self.state.next_input(0.1)
        opened = self.state.target["gripper"]
        self.assertAlmostEqual(opened - start, 4 * 12.0 * 0.1, places=5)

        # Coming off the end holds position — no snap back.
        frame(6, gripper=1.0)
        self.state.next_input(0.1)
        self.assertAlmostEqual(self.state.target["gripper"], opened, places=5)

    def test_reconnect_resets_the_control_sequence(self):
        zero = {
            joint: 0.0
            for joint in (
                "shoulder_pan",
                "shoulder_lift",
                "elbow_flex",
                "wrist_flex",
                "wrist_roll",
            )
        }
        frame = {
            "type": "control",
            "joints_rad": zero,
            "gripper": 0.5,
            "arm_active": True,
            "gripper_active": False,
        }
        self.state.handle_message(self.address, {**frame, "sequence": 500})
        self.assertEqual(self.state.snapshot()["last_sequence"], 500)

        # The AVP app restarts: new connection, sequence counter back at 1.
        self.state.unregister_client(self.address)
        reconnect = ("192.0.2.10", 23456)
        self.assertTrue(self.state.register_client(reconnect))
        paired = self.state.handle_message(reconnect, {"type": "pair", "code": "1234"})
        self.assertEqual(paired["type"], "paired")

        self.state.handle_message(reconnect, {**frame, "sequence": 1})
        self.assertEqual(self.state.snapshot()["last_sequence"], 1)

    def test_worker_survives_a_malformed_hub_response(self):
        class ExplodingHub(FakeHub):
            def leader_link(self, name, driving):
                raise ValueError("hub returned text/html, not JSON")

        self.state.hub = ExplodingHub()
        worker = ControlPlaneWorker(self.state)
        worker.start()
        try:
            deadline = time.monotonic() + 2.0
            while time.monotonic() < deadline:
                if self.state.snapshot()["fault"] is not None:
                    break
                time.sleep(0.01)
            self.assertIsNotNone(self.state.snapshot()["fault"])
            self.assertTrue(worker.is_alive())
        finally:
            self.state.stop_event.set()
            worker.join(timeout=2)
        self.assertFalse(worker.is_alive())


if __name__ == "__main__":
    unittest.main()
