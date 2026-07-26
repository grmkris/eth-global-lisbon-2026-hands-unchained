#!/usr/bin/env python3
"""Regression checks for the CAD-derived SO-101 virtual-leader geometry.

Values come from TheRobotStudio/SO-ARM100 Simulation/SO101/
so101_new_calib.urdf (RobotStudio CAD export): shoulder→elbow = 0.116 m,
elbow→wrist = 0.135 m; at calibrated q=0 the mirrored display-plane link
angles are 104.0° and 177.8° respectively.
"""

from __future__ import annotations

import math
import re
import unittest
from pathlib import Path

SOURCE = (Path(__file__).resolve().parents[1] / "AVPIsaacLeader" / "VirtualLeaderView.swift").read_text()
APP_SOURCE = (Path(__file__).resolve().parents[1] / "AVPIsaacLeader" / "AVPIsaacLeaderApp.swift").read_text()
DIRECT_SOURCE = (Path(__file__).resolve().parents[1] / "AVPIsaacLeader" / "DirectHubLeaderClient.swift").read_text()
CONTROL_SOURCE = (Path(__file__).resolve().parents[1] / "AVPIsaacLeader" / "ControlView.swift").read_text()
WINDOW_STATE_SOURCE = (Path(__file__).resolve().parents[1] / "AVPIsaacLeader" / "LeaderWindowState.swift").read_text()


class SO101VirtualGeometryTests(unittest.TestCase):
    def test_link_ratio_matches_so101_cad_joint_centres(self) -> None:
        match = re.search(
            r"upperArmLength: Float = ([0-9.]+) \* ([0-9.]+).*?"
            r"forearmLength: Float = ([0-9.]+) \* ([0-9.]+)",
            SOURCE,
            re.DOTALL,
        )
        self.assertIsNotNone(match)
        assert match
        upper = float(match[1]) * float(match[2])
        forearm = float(match[3]) * float(match[4])
        self.assertAlmostEqual(upper / forearm, 0.116 / 0.135, places=6)
        # Guard against the former reversed 250 mm upper / 210 mm forearm.
        self.assertLess(upper, forearm)

    def test_calibrated_zero_maps_to_zero_motor_commands(self) -> None:
        shoulder_zero = math.pi - 1.327
        elbow_world_zero = math.pi - 0.0385
        # This is the exact inverse used by setEndEffector(). An arm drawn at
        # the CAD q=0 pose must emit q_shoulder=q_elbow=0, not display angles.
        shoulder_motor = shoulder_zero - shoulder_zero
        elbow_motor = elbow_world_zero - shoulder_motor - elbow_world_zero
        self.assertAlmostEqual(shoulder_motor, 0)
        self.assertAlmostEqual(elbow_motor, 0)
        self.assertIn("requestedLift = normalizedAngle(shoulderAngle - shoulderLiftZero)", SOURCE)
        self.assertIn("requestedElbow = normalizedAngle(forearmAngle - requestedLift - elbowWorldZero)", SOURCE)

    def test_telemetry_uses_forward_kinematics_not_foldedness_heuristic(self) -> None:
        self.assertIn("applyFollowerPose(", SOURCE)
        self.assertIn("SO-101 URDF", SOURCE)
        self.assertNotIn("let shoulderFold =", SOURCE)
        self.assertIn("so101-moving-jaw", SOURCE)
        self.assertIn("so101-fixed-jaw", SOURCE)

    def test_wrist_is_contiguous_and_drag_target_is_rate_limited(self) -> None:
        # Both CAD wrist offsets must have an actual rendered bridge; the
        # roll-to-gripper 98.1 mm segment formerly existed only as a transform.
        self.assertIn('gripperStem.name = "so101-wrist-roll-follower"', SOURCE)
        self.assertIn("gripperStem.position = [-endEffectorOffset / 2, 0, 0]", SOURCE)
        self.assertIn("maximumHeadSpeedMetresPerSecond: Float = 0.32", SOURCE)
        self.assertIn("maximumStep = maximumHeadSpeedMetresPerSecond * Float(elapsed)", SOURCE)
        self.assertIn("resetToNeutralPose", SOURCE)
        self.assertIn("wrist-flex-control", SOURCE)
        self.assertIn("wrist-roll-control", SOURCE)
        self.assertIn("elbow-control", SOURCE)
        self.assertIn("updateShoulderFromElbowControl", SOURCE)
        self.assertIn("let towardBase = simd_normalize(shoulderPosition - elbow)", SOURCE)
        self.assertIn("elbowControl.position = elbow + (towardBase * 0.12)", SOURCE)
        self.assertIn("elbowFlex: virtualElbowFlex", SOURCE)
        self.assertIn("initialVirtualShoulderLift - (controlX - initialElbowControlX) * 8", SOURCE)
        self.assertIn("setOrbMaterial", SOURCE)
        self.assertIn("selected ? 1 : 0.45", SOURCE)
        self.assertIn("resetToNeutralPose(preservingGripper: true)", SOURCE)
        self.assertIn("for joint in Self.bodyJoints", DIRECT_SOURCE)
        self.assertIn("Self.bodyJoints.allSatisfy", DIRECT_SOURCE)

    def test_single_joint_mode_freezes_unselected_targets(self) -> None:
        self.assertIn("Toggle(\"Single joint\"", SOURCE)
        self.assertIn("enum IsolatedJoint", SOURCE)
        self.assertIn("private var activeIsolationJoint", SOURCE)
        self.assertIn("selectHeadIsolationJointIfNeeded", SOURCE)
        self.assertIn("private func allows", SOURCE)
        self.assertNotIn('Picker("Joint"', SOURCE)
        self.assertIn("let panMotor = allows(.shoulderPan)", SOURCE)
        self.assertIn("let liftMotor = allows(.shoulderLift)", SOURCE)
        self.assertIn("let elbowMotor = allows(.elbowFlex)", SOURCE)
        self.assertIn("guard allows(.gripper)", SOURCE)

    def test_precision_handles_and_jerk_limited_motion(self) -> None:
        self.assertIn("wrist-flex-axis-guide", SOURCE)
        self.assertIn("wrist-roll-axis-guide", SOURCE)
        self.assertIn("Active joint:", SOURCE)
        self.assertIn("trajectoryVelocity", DIRECT_SOURCE)
        self.assertIn("trajectoryAcceleration", DIRECT_SOURCE)
        self.assertIn("maxBodyJerkDegreesPerSecond3", DIRECT_SOURCE)
        self.assertNotIn("smoothingSeconds", DIRECT_SOURCE)
        self.assertIn('"shoulder_pan": -1', DIRECT_SOURCE)
        self.assertIn("direction * delta * 180 / .pi", DIRECT_SOURCE)
        self.assertIn("requestImage(", DIRECT_SOURCE)
        self.assertIn("advertisedCameras", DIRECT_SOURCE)
        self.assertIn("cameraNames: cameraNames", DIRECT_SOURCE)
        self.assertIn("HubCameraPreview", SOURCE)
        self.assertIn("hubCameraNames.prefix(2)", SOURCE)
        self.assertIn("shoulderPan: -Float(shoulderPan * .pi / 180)", SOURCE)
        # The standalone panel keeps its normal Stop/E-STOP actions. The
        # compact panel attached to the leader volume has no Stop action.
        self.assertIn('Button("Stop") { connection.stopRobot() }', CONTROL_SOURCE)
        self.assertIn('Button("E-STOP") { connection.emergencyStop() }', CONTROL_SOURCE)
        self.assertNotIn('Button("Stop")', SOURCE)
        self.assertIn('.frame(width: 340)', SOURCE)
        self.assertIn('Toggle("Swivel only"', SOURCE)
        self.assertIn('if swivelOnlyMode { return headEventID != nil && joint == .shoulderPan }', SOURCE)
        self.assertIn('headIsolationJoint = .shoulderPan', SOURCE)
        self.assertGreaterEqual(CONTROL_SOURCE.count("Spacer()"), 2)

    def test_settings_and_leader_windows_are_singleton_and_recoverable(self) -> None:
        self.assertIn("isControlOpen", WINDOW_STATE_SOURCE)
        self.assertIn("beginControlOpening", WINDOW_STATE_SOURCE)
        self.assertIn("beginRepositioning", WINDOW_STATE_SOURCE)
        self.assertIn("dismissWindow(id: AppWindow.leaderPlatform.rawValue)", CONTROL_SOURCE)
        self.assertIn("openOrRepositionLeader", CONTROL_SOURCE)
        self.assertIn(".defaultWindowPlacement", APP_SOURCE)
        self.assertIn("WindowPlacement(.utilityPanel)", APP_SOURCE)

    def test_wrist_controls_are_separated_and_platform_is_bottom_aligned(self) -> None:
        self.assertIn("root.position = [0, -0.38, 0]", SOURCE)
        self.assertIn("headBulb.position = wrist + SIMD3<Float>(0, 0.145, 0)", SOURCE)
        self.assertIn("wristFlexControl.position = wrist + SIMD3<Float>(0, 0.090, 0.160)", SOURCE)
        self.assertIn("wristRollControl.position = wrist + SIMD3<Float>(0, 0.090, -0.160)", SOURCE)

    def test_all_commandable_joints_have_time_based_speed_caps(self) -> None:
        self.assertIn("maximumArmJointSpeedRadiansPerSecond", SOURCE)
        self.assertIn("maximumWristJointSpeedRadiansPerSecond", SOURCE)
        self.assertIn("maximumGripperSpeedPerSecond", SOURCE)
        self.assertIn("cappedElapsed", SOURCE)
        self.assertIn("snap: Bool = false", SOURCE)

    def test_neutral_is_calibrated_zero_and_platform_faces_operator(self) -> None:
        self.assertIn("Label(\"Move both to neutral\"", SOURCE)
        self.assertIn("elbowFlex: 0", SOURCE)
        self.assertIn("root.scale = SIMD3<Float>(repeating: 0.5)", SOURCE)
        self.assertIn("rotatePlatform(byDegrees", SOURCE)
        self.assertIn('Label("Rotate left"', SOURCE)
        self.assertIn('Label("Rotate right"', SOURCE)
        self.assertIn(".overlay(alignment: .bottom)", SOURCE)
        self.assertIn("leaderControls", SOURCE)
        self.assertIn(".defaultSize(width: 1.3, height: 1.2, depth: 0.9, in: .meters)", APP_SOURCE)


if __name__ == "__main__":
    unittest.main()
