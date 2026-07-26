#!/usr/bin/env python3
from __future__ import annotations

import argparse
import math
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from calibrate_virtual_leader_follower import (
    insufficient_range_spans,
    record_ranges_resilient,
    required_range_spans,
)
from virtual_leader_gateway import (
    BODY_JOINTS,
    BridgeState,
    VirtualCommand,
    endpoint_clutched_value,
    startup_hardware_limits,
    validate_args,
)


def arguments() -> argparse.Namespace:
    return argparse.Namespace(
        name="Test gateway",
        listen_port=7443,
        pairing_code=None,
        dry_run=True,
        allow_motion=False,
        fps=20.0,
        command_timeout_ms=2000.0,
        motion_scale=0.35,
        elbow_motion_scale=1.0,
        max_speed_deg_s=15.0,
        max_gripper_speed=20.0,
        limit_margin=0.90,
        collapsed_elbow_tolerance_deg=10.0,
        log_state_hz=0.0,
        shoulder_pan_sign=1,
        shoulder_lift_sign=1,
        elbow_flex_sign=1,
        wrist_flex_sign=1,
        wrist_roll_sign=1,
        gripper_sign=1,
    )


class BridgeStateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.state = BridgeState(arguments(), "1234")
        self.address = ("127.0.0.1", 50000)
        self.assertTrue(self.state.register_client(self.address))
        self.state.set_robot_ready(
            actual={
                "shoulder_pan": 0.0,
                "shoulder_lift": 0.0,
                "elbow_flex": 0.0,
                "wrist_flex": 0.0,
                "wrist_roll": 0.0,
                "gripper": 50.0,
            },
            limits=self.state._default_limits(),
            connected=False,
        )
        paired = self.state.handle_message(self.address, {"type": "pair", "code": "1234"})
        self.assertEqual(paired["type"], "paired")
        armed = self.state.handle_message(self.address, {"type": "arm"})
        self.assertTrue(armed["armed"])

    def control(self, sequence: int, shoulder_pan: float, active: bool = True) -> None:
        error = self.state._handle_control(
            {
                "type": "control",
                "sequence": sequence,
                "joints_rad": {joint: shoulder_pan if joint == "shoulder_pan" else 0.0 for joint in BODY_JOINTS},
                "gripper": 0.5,
                "arm_active": active,
                "gripper_active": False,
            }
        )
        self.assertIsNone(error)

    def test_first_active_frame_clutches_without_snap(self) -> None:
        self.control(1, shoulder_pan=1.0)
        target, should_send = self.state.next_target(0.05)
        self.assertTrue(should_send)
        self.assertEqual(target["shoulder_pan"], 0.0)

    def test_successful_control_does_not_emit_full_rate_telemetry(self) -> None:
        response = self.state.handle_message(
            self.address,
            {
                "type": "control",
                "sequence": 1,
                "joints_rad": {joint: 0.0 for joint in BODY_JOINTS},
                "gripper": 0.5,
                "arm_active": True,
                "gripper_active": False,
            },
        )
        self.assertIsNone(response)

    def test_virtual_delta_is_scaled_and_slew_limited(self) -> None:
        self.control(1, shoulder_pan=0.0)
        self.state.next_target(0.05)
        self.control(2, shoulder_pan=math.radians(20))
        target, should_send = self.state.next_target(0.05)
        self.assertTrue(should_send)
        self.assertGreater(target["shoulder_pan"], 0.0)
        self.assertLessEqual(target["shoulder_pan"], 0.75)

    def test_elbow_uses_full_scale_to_escape_a_folded_start(self) -> None:
        folded = math.radians(120)
        straight = math.radians(30)
        frame = {
            "type": "control",
            "joints_rad": {
                joint: folded if joint == "elbow_flex" else 0.0
                for joint in BODY_JOINTS
            },
            "gripper": 0.5,
            "arm_active": True,
            "gripper_active": False,
        }
        self.assertIsNone(self.state._handle_control({**frame, "sequence": 1}))
        self.state.next_target(10.0)
        straight_joints = dict(frame["joints_rad"])
        straight_joints["elbow_flex"] = straight
        self.assertIsNone(
            self.state._handle_control({**frame, "sequence": 2, "joints_rad": straight_joints})
        )
        target, should_send = self.state.next_target(10.0)
        self.assertTrue(should_send)
        self.assertEqual(target["elbow_flex"], self.state.limits["elbow_flex"][0])

    def test_gripper_clutch_preserves_engagement_and_reaches_endpoints(self) -> None:
        self.assertEqual(endpoint_clutched_value(0.6, 0.6, 42.0, 0.0, 100.0, 1), 42.0)
        self.assertEqual(endpoint_clutched_value(0.0, 0.6, 42.0, 0.0, 100.0, 1), 0.0)
        self.assertEqual(endpoint_clutched_value(1.0, 0.6, 42.0, 0.0, 100.0, 1), 100.0)
        self.assertEqual(endpoint_clutched_value(0.0, 0.6, 42.0, 0.0, 100.0, -1), 100.0)
        self.assertEqual(endpoint_clutched_value(1.0, 0.6, 42.0, 0.0, 100.0, -1), 0.0)

        frame = {
            "type": "control",
            "joints_rad": {joint: 0.0 for joint in BODY_JOINTS},
            "arm_active": False,
            "gripper_active": True,
        }
        self.assertIsNone(self.state._handle_control({**frame, "sequence": 1, "gripper": 0.5}))
        target, should_send = self.state.next_target(1.0)
        self.assertTrue(should_send)
        self.assertEqual(target["gripper"], 50.0)

        self.assertIsNone(self.state._handle_control({**frame, "sequence": 2, "gripper": 0.0}))
        for _ in range(3):
            target, should_send = self.state.next_target(1.0)
            self.assertTrue(should_send)
        self.assertEqual(target["gripper"], 0.0)

    def test_one_second_control_gap_remains_within_watchdog(self) -> None:
        self.control(1, shoulder_pan=0.0)
        self.state.next_target(0.05)
        assert self.state.latest_command is not None
        command = self.state.latest_command
        self.state.latest_command = VirtualCommand(
            sequence=command.sequence,
            received_at=command.received_at - 1.0,
            joints_rad=command.joints_rad,
            gripper=command.gripper,
            arm_active=True,
            gripper_active=False,
        )
        _, should_send = self.state.next_target(0.05)
        self.assertTrue(should_send)
        self.assertTrue(self.state.armed)

    def test_stale_active_control_disarms(self) -> None:
        self.control(1, shoulder_pan=0.0)
        self.state.next_target(0.05)
        assert self.state.latest_command is not None
        command = self.state.latest_command
        self.state.latest_command = VirtualCommand(
            sequence=command.sequence,
            received_at=command.received_at - 3.0,
            joints_rad=command.joints_rad,
            gripper=command.gripper,
            arm_active=True,
            gripper_active=False,
        )
        _, should_send = self.state.next_target(0.05)
        self.assertFalse(should_send)
        self.assertFalse(self.state.armed)
        self.assertEqual(self.state.mode, "timeout")

    def test_calibration_range_recorder_survives_a_dropped_read(self) -> None:
        motors = ["shoulder_pan", "elbow_flex"]

        class FakeBus:
            def __init__(self) -> None:
                self.responses = [
                    {"shoulder_pan": 500, "elbow_flex": 500},
                    ConnectionError("dropped packet"),
                    {"shoulder_pan": 300, "elbow_flex": 700},
                    {"shoulder_pan": 900, "elbow_flex": 200},
                ]

            def sync_read(self, *_args, **_kwargs):
                response = self.responses.pop(0)
                if isinstance(response, BaseException):
                    raise response
                return response

        with (
            patch("calibrate_virtual_leader_follower.enter_pressed", side_effect=[False, True]),
            patch("calibrate_virtual_leader_follower.time.sleep"),
        ):
            minimums, maximums = record_ranges_resilient(FakeBus(), motors)

        self.assertEqual(minimums, {"shoulder_pan": 300, "elbow_flex": 200})
        self.assertEqual(maximums, {"shoulder_pan": 900, "elbow_flex": 700})

    def test_calibration_requires_most_of_the_previous_valid_range(self) -> None:
        original = {
            "shoulder_lift": SimpleNamespace(range_min=555, range_max=2414),
        }
        required = required_range_spans(original)
        self.assertEqual(required["shoulder_lift"], 1301)
        self.assertEqual(required["gripper"], 300)

    def test_calibration_rejects_incomplete_joint_sweeps(self) -> None:
        minimums = {
            "shoulder_pan": 100,
            "shoulder_lift": 100,
            "elbow_flex": 100,
            "wrist_flex": 100,
            "gripper": 100,
        }
        complete_maximums = {
            "shoulder_pan": 1000,
            "shoulder_lift": 1000,
            "elbow_flex": 1000,
            "wrist_flex": 1000,
            "gripper": 500,
        }
        self.assertEqual(insufficient_range_spans(minimums, complete_maximums), {})

        incomplete_maximums = {**complete_maximums, "elbow_flex": 700}
        self.assertEqual(
            insufficient_range_spans(minimums, incomplete_maximums),
            {"elbow_flex": 600},
        )

    def test_collapsed_elbow_startup_tolerance_does_not_relax_other_joints(self) -> None:
        hard_limits = {
            "shoulder_pan": (-80.0, 80.0),
            "shoulder_lift": (-75.0, 75.0),
            "elbow_flex": (-96.0, 96.0),
            "wrist_flex": (-85.0, 85.0),
            "wrist_roll": (-180.0, 180.0),
            "gripper": (0.0, 100.0),
        }
        startup_limits = startup_hardware_limits(hard_limits, 10.0)
        self.assertEqual(startup_limits["elbow_flex"], (-106.0, 106.0))
        for joint in (*BODY_JOINTS[:2], *BODY_JOINTS[3:], "gripper"):
            self.assertEqual(startup_limits[joint], hard_limits[joint])

    def test_collapsed_elbow_tolerance_is_bounded(self) -> None:
        for invalid in (-0.1, 20.1):
            args = arguments()
            args.collapsed_elbow_tolerance_deg = invalid
            with self.assertRaises(SystemExit):
                validate_args(args)

        args = arguments()
        args.collapsed_elbow_tolerance_deg = 10.0
        validate_args(args)

    def test_elbow_motion_scale_is_bounded(self) -> None:
        for invalid in (0.0, 1.1):
            args = arguments()
            args.elbow_motion_scale = invalid
            with self.assertRaises(SystemExit):
                validate_args(args)

        args = arguments()
        args.elbow_motion_scale = 1.0
        validate_args(args)

    def test_custom_pairing_code_requires_exactly_four_ascii_digits(self) -> None:
        for invalid in ("123", "12345", "12a4", "١٢٣٤"):
            args = arguments()
            args.pairing_code = invalid
            with self.assertRaises(SystemExit):
                validate_args(args)

        args = arguments()
        args.pairing_code = "0123"
        validate_args(args)

    def test_pairing_locks_after_three_incorrect_four_digit_codes(self) -> None:
        state = BridgeState(arguments(), "1234")
        self.assertTrue(state.register_client(self.address))

        for code in ("0000", "1111"):
            response = state.handle_message(self.address, {"type": "pair", "code": code})
            self.assertEqual(response["type"], "error")
            self.assertIn("before lockout", response["message"])

        response = state.handle_message(self.address, {"type": "pair", "code": "2222"})
        self.assertEqual(response["type"], "error")
        self.assertIn("Too many incorrect codes", response["message"])

        response = state.handle_message(self.address, {"type": "pair", "code": "1234"})
        self.assertEqual(response["type"], "error")
        self.assertIn("temporarily locked", response["message"])

    def test_disconnect_disarms(self) -> None:
        self.state.unregister_client(self.address)
        self.assertFalse(self.state.armed)
        self.assertEqual(self.state.mode, "disarmed")


if __name__ == "__main__":
    unittest.main()
