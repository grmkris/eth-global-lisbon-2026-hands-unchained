#!/usr/bin/env python3
"""Regression test: recording must not power-cycle the real follower."""

from __future__ import annotations

import sys
import types
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
from backends.real import RealBackend  # noqa: E402


class FakeCamera:
    def __init__(self) -> None:
        self.connect_calls = 0
        self.disconnect_calls = 0

    def connect(self) -> None:
        self.connect_calls += 1

    def disconnect(self) -> None:
        self.disconnect_calls += 1


class FakeRobot:
    def __init__(self) -> None:
        self.cameras: dict[str, FakeCamera] = {}
        self.config = SimpleNamespace(max_relative_target=None)
        self.bus = SimpleNamespace(motors={"shoulder_pan": object()})


class RealRecordHandoffTests(unittest.TestCase):
    def test_record_camera_handoff_keeps_existing_arm_and_leader_connected(self) -> None:
        created: dict[str, FakeCamera] = {}

        class FakeCameraConfig:
            def __init__(self, **kwargs: object) -> None:
                self.kwargs = kwargs

        cameras_module = types.ModuleType("lerobot.cameras")

        def make_cameras(configs: dict[str, FakeCameraConfig]) -> dict[str, FakeCamera]:
            nonlocal created
            created = {name: FakeCamera() for name in configs}
            return created

        cameras_module.make_cameras_from_configs = make_cameras  # type: ignore[attr-defined]
        config_module = types.ModuleType("lerobot.cameras.opencv.configuration_opencv")
        config_module.OpenCVCameraConfig = FakeCameraConfig  # type: ignore[attr-defined]
        modules = {
            "lerobot": types.ModuleType("lerobot"),
            "lerobot.cameras": cameras_module,
            "lerobot.cameras.opencv": types.ModuleType("lerobot.cameras.opencv"),
            "lerobot.cameras.opencv.configuration_opencv": config_module,
        }

        backend = RealBackend()
        robot = FakeRobot()
        leader = object()
        backend.robot = robot
        backend.teleop = leader
        backend._emit_state = lambda: None  # type: ignore[method-assign]

        with patch.dict(sys.modules, modules):
            returned_robot, returned_leader, _ = backend.prepare_record({
                "source": "leader",
                "cameras": {"workspace_cam": {"index": 0}},
            })

        self.assertIs(returned_robot, robot)
        self.assertIs(returned_leader, leader)
        self.assertEqual(created["workspace_cam"].connect_calls, 1)
        self.assertIs(backend.robot, robot)
        self.assertIs(backend.teleop, leader)

        backend.after_record()

        self.assertEqual(created["workspace_cam"].disconnect_calls, 1)
        self.assertIs(backend.robot, robot)
        self.assertIs(backend.teleop, leader)
        self.assertEqual(robot.cameras, {})
        self.assertEqual(backend.state, "connected")


if __name__ == "__main__":
    unittest.main()
