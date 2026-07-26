#!/usr/bin/env python3
"""Local Vision Pro virtual-leader gateway for an SO-101 follower.

The gateway accepts newline-delimited JSON over a Bonjour-advertised TCP socket.
It uses relative clutching: engaging a virtual control captures both the virtual
and measured follower positions, so engagement never snaps to an absolute pose.

This first LAN protocol uses a one-time pairing code but is not encrypted. Use it
only on a trusted private network. A production version should add TLS pinning.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import math
import platform
import secrets
import shutil
import signal
import socket
import socketserver
import subprocess
import sys
import termios
import threading
import time
from dataclasses import dataclass
from typing import Any

SERVICE_TYPE = "_so101-control._tcp"
PROTOCOL_VERSION = 1
BODY_JOINTS = (
    "shoulder_pan",
    "shoulder_lift",
    "elbow_flex",
    "wrist_flex",
    "wrist_roll",
)
ALL_JOINTS = (*BODY_JOINTS, "gripper")
PAIRING_MAX_FAILURES = 3
PAIRING_LOCKOUT_SECONDS = 60.0


def log_event(message: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {message}", flush=True)


def claim_serial_exclusive(bus: Any) -> None:
    serial_port = bus.port_handler.ser
    if serial_port is None or not serial_port.is_open:
        raise RuntimeError("Serial port was not open when requesting exclusive ownership")
    fcntl.ioctl(serial_port.fileno(), termios.TIOCEXCL)


def endpoint_clutched_value(
    value: float,
    virtual_base: float,
    physical_base: float,
    low: float,
    high: float,
    sign: int,
) -> float:
    """Map a relative clutch continuously while preserving both endpoints."""
    if value < virtual_base:
        progress = (virtual_base - value) / virtual_base if virtual_base > 0 else 0.0
        endpoint = low if sign > 0 else high
    elif value > virtual_base:
        remaining = 1.0 - virtual_base
        progress = (value - virtual_base) / remaining if remaining > 0 else 0.0
        endpoint = high if sign > 0 else low
    else:
        return physical_base
    return physical_base + (endpoint - physical_base) * min(1.0, max(0.0, progress))


@dataclass(frozen=True)
class VirtualCommand:
    sequence: int
    received_at: float
    joints_rad: dict[str, float]
    gripper: float
    arm_active: bool
    gripper_active: bool


class BridgeState:
    def __init__(self, args: argparse.Namespace, pairing_code: str):
        self.args = args
        self.pairing_code = pairing_code
        self.lock = threading.RLock()
        self.stop_event = threading.Event()

        self.client: tuple[str, int] | None = None
        self.paired_client: tuple[str, int] | None = None
        self.pairing_failures = 0
        self.pairing_locked_until = 0.0
        self.last_sequence = -1
        self.latest_command: VirtualCommand | None = None

        self.robot_ready = False
        self.robot_connected = False
        self.armed = False
        self.mode = "starting"
        self.message = "Gateway is starting"
        self.fault: str | None = None
        self.actual = {joint: (50.0 if joint == "gripper" else 0.0) for joint in ALL_JOINTS}
        self.target = dict(self.actual)
        self.limits = self._default_limits()

        self.arm_virtual_base: dict[str, float] | None = None
        self.arm_physical_base: dict[str, float] | None = None
        self.gripper_virtual_base: float | None = None
        self.gripper_physical_base: float | None = None
        self.last_state_log = 0.0

        self.signs = {
            "shoulder_pan": args.shoulder_pan_sign,
            "shoulder_lift": args.shoulder_lift_sign,
            "elbow_flex": args.elbow_flex_sign,
            "wrist_flex": args.wrist_flex_sign,
            "wrist_roll": args.wrist_roll_sign,
            "gripper": args.gripper_sign,
        }

    def _default_limits(self) -> dict[str, tuple[float, float]]:
        return {
            "shoulder_pan": (-85.0, 85.0),
            "shoulder_lift": (-75.0, 75.0),
            "elbow_flex": (-70.0, 70.0),
            "wrist_flex": (-85.0, 85.0),
            "wrist_roll": (-160.0, 160.0),
            "gripper": (0.0, 100.0),
        }

    def register_client(self, address: tuple[str, int]) -> bool:
        with self.lock:
            if self.client is not None and self.client != address:
                return False
            self.client = address
            self.mode = "disarmed" if self.robot_ready else "starting"
            self.message = f"Client connected from {address[0]}"
            log_event(f"Vision Pro connected from {address[0]}:{address[1]}")
            return True

    def unregister_client(self, address: tuple[str, int]) -> None:
        with self.lock:
            if self.client != address:
                return
            self._disarm_locked("Client disconnected")
            self.client = None
            self.paired_client = None
            self.last_sequence = -1
            self.latest_command = None
            log_event(f"Vision Pro disconnected from {address[0]}:{address[1]}; gateway disarmed")

    def gateway_hello(self) -> dict[str, Any]:
        with self.lock:
            return {
                "type": "gateway_hello",
                "protocol": PROTOCOL_VERSION,
                "gateway": self.args.name,
                "pairing_required": True,
                "allow_motion": bool(self.args.dry_run or self.args.allow_motion),
                "robot_ready": self.robot_ready,
                "robot_connected": self.robot_connected,
                "dry_run": self.args.dry_run,
                "encrypted": False,
            }

    def handle_message(
        self,
        address: tuple[str, int],
        payload: dict[str, Any],
    ) -> dict[str, Any] | None:
        message_type = payload.get("type")
        if message_type == "hello":
            return self.gateway_hello()
        if message_type == "stop":
            with self.lock:
                self._disarm_locked("Stop requested from Vision Pro")
                log_event("STOP received from Vision Pro")
            return self.snapshot()
        if message_type == "pair":
            return self._handle_pair(address, payload)

        with self.lock:
            if self.paired_client != address:
                return self.error("Pairing is required")

        if message_type == "heartbeat":
            return self.snapshot()
        if message_type == "arm":
            return self._handle_arm()
        if message_type == "control":
            # Successful high-rate controls need no per-frame response. The
            # request handler sends rate-limited state telemetry separately.
            return self._handle_control(payload)
        return self.error(f"Unsupported message type: {message_type!r}")

    def _handle_pair(self, address: tuple[str, int], payload: dict[str, Any]) -> dict[str, Any]:
        code = str(payload.get("code", "")).strip()
        with self.lock:
            now = time.monotonic()
            if now < self.pairing_locked_until:
                seconds = math.ceil(self.pairing_locked_until - now)
                return self.error(f"Pairing is temporarily locked; retry in {seconds} seconds")

            if not secrets.compare_digest(code, self.pairing_code):
                self.pairing_failures += 1
                remaining = PAIRING_MAX_FAILURES - self.pairing_failures
                log_event(f"Pairing failed for {address[0]}:{address[1]}")
                if remaining <= 0:
                    self.pairing_failures = 0
                    self.pairing_locked_until = now + PAIRING_LOCKOUT_SECONDS
                    log_event(
                        f"Pairing locked for {PAIRING_LOCKOUT_SECONDS:.0f} seconds after repeated failures"
                    )
                    return self.error(
                        f"Too many incorrect codes; retry in {PAIRING_LOCKOUT_SECONDS:.0f} seconds"
                    )
                return self.error(
                    f"Incorrect pairing code; {remaining} attempt{'s' if remaining != 1 else ''} before lockout"
                )

            self.pairing_failures = 0
            self.pairing_locked_until = 0.0
            self.paired_client = address
            self.message = "Vision Pro paired; robot remains disarmed"
            log_event(f"Vision Pro paired from {address[0]}:{address[1]}; robot remains disarmed")
            return {
                "type": "paired",
                "gateway": self.args.name,
                "robot_ready": self.robot_ready,
                "allow_motion": bool(self.args.dry_run or self.args.allow_motion),
            }

    def _handle_arm(self) -> dict[str, Any]:
        with self.lock:
            if self.fault:
                return self.error(f"Cannot arm while faulted: {self.fault}")
            if not self.robot_ready:
                return self.error("Follower is not ready")
            if not (self.args.dry_run or self.args.allow_motion):
                return self.error("Mac-side motion permission was not granted")
            self.armed = True
            self.mode = "armed"
            self.message = "Armed and holding; grab a virtual control to move"
            self.target = dict(self.actual)
            self._clear_clutches_locked()
            log_event("ARM accepted; holding measured pose until a virtual control is grabbed")
            return self.snapshot_locked()

    def _handle_control(self, payload: dict[str, Any]) -> dict[str, Any] | None:
        try:
            sequence = int(payload["sequence"])
            joints = payload["joints_rad"]
            joints_rad = {joint: float(joints[joint]) for joint in BODY_JOINTS}
            gripper = float(payload["gripper"])
            arm_active = bool(payload["arm_active"])
            gripper_active = bool(payload["gripper_active"])
        except (KeyError, TypeError, ValueError) as exc:
            return self.error(f"Malformed control frame: {exc}")

        values = (*joints_rad.values(), gripper)
        if not all(math.isfinite(value) for value in values):
            return self.error("Control frame contains a non-finite value")
        if any(abs(value) > 4 * math.pi for value in joints_rad.values()):
            return self.error("Joint angle is outside the protocol sanity bound")
        if not 0.0 <= gripper <= 1.0:
            return self.error("Gripper value must be between 0 and 1")

        with self.lock:
            if sequence <= self.last_sequence:
                return None
            first_control = self.last_sequence < 0
            self.last_sequence = sequence
            self.latest_command = VirtualCommand(
                sequence=sequence,
                received_at=time.monotonic(),
                joints_rad=joints_rad,
                gripper=gripper,
                arm_active=arm_active,
                gripper_active=gripper_active,
            )
            if first_control:
                log_event(f"Control stream started at sequence {sequence}")
        return None

    def set_robot_ready(
        self,
        actual: dict[str, float],
        limits: dict[str, tuple[float, float]],
        connected: bool,
    ) -> None:
        with self.lock:
            self.actual = dict(actual)
            self.target = dict(actual)
            self.limits = limits
            self.robot_connected = connected
            self.robot_ready = True
            self.mode = "disarmed"
            self.message = "Dry-run follower ready" if self.args.dry_run else "SO-101 follower ready"

    def set_fault(self, message: str) -> None:
        with self.lock:
            self.fault = message
            self.robot_ready = False
            self._disarm_locked(message)
            self.mode = "fault"

    def update_actual(self, actual: dict[str, float]) -> None:
        with self.lock:
            self.actual = dict(actual)

    def update_sent_target(self, action: dict[str, float]) -> None:
        with self.lock:
            for joint in ALL_JOINTS:
                key = f"{joint}.pos"
                if key in action:
                    self.target[joint] = float(action[key])

    def next_target(self, dt: float) -> tuple[dict[str, float], bool]:
        with self.lock:
            command = self.latest_command
            if not self.armed or command is None:
                return dict(self.target), False

            command_age = time.monotonic() - command.received_at
            was_active = self.arm_virtual_base is not None or self.gripper_virtual_base is not None
            if was_active and command_age > self.args.command_timeout_ms / 1000.0:
                self._disarm_locked(f"Control timeout after {command_age * 1000:.0f} ms")
                self.mode = "timeout"
                return dict(self.target), False

            desired = dict(self.target)
            any_active = False

            if command.arm_active:
                any_active = True
                if self.arm_virtual_base is None:
                    self.arm_virtual_base = dict(command.joints_rad)
                    self.arm_physical_base = {joint: self.actual[joint] for joint in BODY_JOINTS}
                    for joint in BODY_JOINTS:
                        desired[joint] = self.actual[joint]
                    log_event("Arm clutch engaged at the measured follower pose")
                assert self.arm_physical_base is not None
                for joint in BODY_JOINTS:
                    delta_rad = wrapped_delta(command.joints_rad[joint], self.arm_virtual_base[joint])
                    scale = (
                        self.args.elbow_motion_scale
                        if joint == "elbow_flex"
                        else self.args.motion_scale
                    )
                    desired[joint] = (
                        self.arm_physical_base[joint]
                        + self.signs[joint]
                        * math.degrees(delta_rad)
                        * scale
                    )
            else:
                if self.arm_virtual_base is not None:
                    log_event("Arm clutch released; holding the last target")
                self.arm_virtual_base = None
                self.arm_physical_base = None

            if command.gripper_active:
                any_active = True
                if self.gripper_virtual_base is None:
                    self.gripper_virtual_base = command.gripper
                    self.gripper_physical_base = self.actual["gripper"]
                    desired["gripper"] = self.actual["gripper"]
                    log_event("Gripper clutch engaged at the measured follower position")
                assert self.gripper_physical_base is not None
                low, high = self.limits["gripper"]
                desired["gripper"] = endpoint_clutched_value(
                    value=command.gripper,
                    virtual_base=self.gripper_virtual_base,
                    physical_base=self.gripper_physical_base,
                    low=low,
                    high=high,
                    sign=self.signs["gripper"],
                )
            else:
                if self.gripper_virtual_base is not None:
                    log_event("Gripper clutch released; holding the last target")
                self.gripper_virtual_base = None
                self.gripper_physical_base = None

            if not any_active:
                self.mode = "armed"
                self.message = "Armed and holding"
                return dict(self.target), False

            limited: dict[str, float] = {}
            for joint in ALL_JOINTS:
                low, high = self.limits[joint]
                bounded = min(high, max(low, desired[joint]))
                speed = self.args.max_gripper_speed if joint == "gripper" else self.args.max_speed_deg_s
                max_step = speed * dt
                previous = self.target[joint]
                limited[joint] = previous + min(max(bounded - previous, -max_step), max_step)

            self.target = limited
            self.mode = "active"
            active_names = []
            if command.arm_active:
                active_names.append("arm")
            if command.gripper_active:
                active_names.append("gripper")
            self.message = f"Following virtual {' + '.join(active_names)} control"
            return dict(limited), True

    def log_state_if_due(self) -> None:
        with self.lock:
            if self.mode != "active" or self.args.log_state_hz <= 0:
                return
            now = time.monotonic()
            if now - self.last_state_log < 1.0 / self.args.log_state_hz:
                return
            self.last_state_log = now
            actual = " ".join(f"{joint}={self.actual[joint]:.1f}" for joint in ALL_JOINTS)
            target = " ".join(f"{joint}={self.target[joint]:.1f}" for joint in ALL_JOINTS)
        log_event(f"ACTIVE actual[{actual}] target[{target}]")

    def stop(self, reason: str) -> None:
        with self.lock:
            self._disarm_locked(reason)

    def _disarm_locked(self, reason: str) -> None:
        was_armed = self.armed
        self.armed = False
        self.mode = "disarmed"
        self.message = reason
        self._clear_clutches_locked()
        if was_armed:
            log_event(f"DISARMED: {reason}")

    def _clear_clutches_locked(self) -> None:
        self.arm_virtual_base = None
        self.arm_physical_base = None
        self.gripper_virtual_base = None
        self.gripper_physical_base = None

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            return self.snapshot_locked()

    def snapshot_locked(self) -> dict[str, Any]:
        command_age_ms = None
        if self.latest_command is not None:
            command_age_ms = round((time.monotonic() - self.latest_command.received_at) * 1000, 1)
        return {
            "type": "state",
            "protocol": PROTOCOL_VERSION,
            "mode": self.mode,
            "message": self.message,
            "armed": self.armed,
            "robot_ready": self.robot_ready,
            "robot_connected": self.robot_connected,
            "allow_motion": bool(self.args.dry_run or self.args.allow_motion),
            "dry_run": self.args.dry_run,
            "fault": self.fault,
            "actual": rounded_dict(self.actual),
            "target": rounded_dict(self.target),
            "limits": {key: [round(value[0], 3), round(value[1], 3)] for key, value in self.limits.items()},
            "last_sequence": self.last_sequence,
            "command_age_ms": command_age_ms,
        }

    @staticmethod
    def error(message: str) -> dict[str, Any]:
        return {"type": "error", "message": message}


class RobotWorker(threading.Thread):
    def __init__(self, state: BridgeState):
        super().__init__(name="so101-control-loop", daemon=True)
        self.state = state
        self.robot: Any | None = None

    def run(self) -> None:
        try:
            if self.state.args.dry_run:
                self.state.set_robot_ready(
                    actual={joint: (50.0 if joint == "gripper" else 0.0) for joint in ALL_JOINTS},
                    limits=self.state._default_limits(),
                    connected=False,
                )
            else:
                self._connect_robot()
            self._control_loop()
        except Exception as exc:
            self.state.set_fault(f"Robot fault: {type(exc).__name__}: {exc}")
        finally:
            if self.robot is not None and self.robot.is_connected:
                self.robot.disconnect()

    def _connect_robot(self) -> None:
        from lerobot.motors.feetech import OperatingMode
        from lerobot.robots.so_follower.config_so_follower import SOFollowerRobotConfig
        from lerobot.robots.so_follower.so_follower import SO101Follower

        relative_limit = {joint: (12.0 if joint == "gripper" else 6.0) for joint in ALL_JOINTS}
        config = SOFollowerRobotConfig(
            port=self.state.args.robot_port,
            id=self.state.args.robot_id,
            use_degrees=True,
            max_relative_target=relative_limit,
            disable_torque_on_disconnect=True,
        )
        robot = SO101Follower(config)
        # Store immediately so run() can always disconnect if any later
        # calibration or pose validation fails after the serial port opens.
        self.robot = robot
        if not robot.calibration:
            raise RuntimeError(f"No LeRobot follower calibration at {robot.calibration_fpath}")

        print(f"Connecting to follower on {self.state.args.robot_port}…", flush=True)
        robot.bus.connect()
        claim_serial_exclusive(robot.bus)
        calibration_matches = robot.bus.is_calibrated
        if not calibration_matches and not self.state.args.apply_saved_calibration:
            raise RuntimeError(
                "Follower calibration does not match the connected motors. "
                "Restart with --apply-saved-calibration to write the existing saved profile."
            )

        # Keep torque off while applying EEPROM calibration and configuring the
        # motors. Latch the measured pose before torque is enabled, preventing a
        # stale Goal_Position register from causing a startup jump.
        robot.bus.disable_torque()
        if not calibration_matches:
            log_event(f"Applying saved follower calibration: {robot.calibration_fpath}")
            robot.bus.write_calibration(robot.calibration)
            if not robot.bus.is_calibrated:
                raise RuntimeError("Saved calibration did not verify after being written to the motors")

        robot.bus.configure_motors()
        for motor in robot.bus.motors:
            robot.bus.write("Operating_Mode", motor, OperatingMode.POSITION.value)
            robot.bus.write("P_Coefficient", motor, 16)
            robot.bus.write("I_Coefficient", motor, 0)
            robot.bus.write("D_Coefficient", motor, 32)
            if motor == "gripper":
                robot.bus.write("Max_Torque_Limit", motor, 500)
                robot.bus.write("Protection_Current", motor, 250)
                robot.bus.write("Overload_Torque", motor, 25)

        measured = robot.bus.sync_read("Present_Position")
        actual = {joint: float(measured[joint]) for joint in ALL_JOINTS}
        soft_limits = calibration_limits(robot.calibration, self.state.args.limit_margin)
        hard_limits = calibration_limits(robot.calibration, 1.0)
        startup_limits = startup_hardware_limits(
            hard_limits,
            self.state.args.collapsed_elbow_tolerance_deg,
        )
        outside_hardware = [
            joint
            for joint, value in actual.items()
            if not startup_limits[joint][0] <= value <= startup_limits[joint][1]
        ]
        if outside_hardware:
            raise RuntimeError(
                "Current pose is outside the calibrated hardware range: "
                + ", ".join(outside_hardware)
                + ". Reposition into the saved range or run the launcher with --calibrate."
            )

        elbow_low, elbow_high = hard_limits["elbow_flex"]
        if not elbow_low <= actual["elbow_flex"] <= elbow_high:
            log_event(
                f"Collapsed elbow startup accepted at {actual['elbow_flex']:.1f}° "
                f"(bounded tolerance {self.state.args.collapsed_elbow_tolerance_deg:.1f}°); "
                "only inward motion is allowed"
            )

        # Never snap from a valid measured pose to a softer margin. If startup
        # occurs just beyond a soft bound, include only that measured value as
        # the temporary bound, allowing subsequent commands to move inward but
        # never farther toward the hardware endpoint.
        limits: dict[str, tuple[float, float]] = {}
        for joint in ALL_JOINTS:
            low, high = soft_limits[joint]
            limits[joint] = (min(low, actual[joint]), max(high, actual[joint]))
            if not low <= actual[joint] <= high:
                log_event(
                    f"{joint} starts outside its soft margin at {actual[joint]:.1f}; "
                    "only inward motion is allowed"
                )

        robot.bus.sync_write("Goal_Position", actual)
        robot.bus.enable_torque()
        self.state.set_robot_ready(actual=actual, limits=limits, connected=True)
        print("Follower connected and holding its measured pose.", flush=True)

    def _control_loop(self) -> None:
        period = 1.0 / self.state.args.fps
        last = time.monotonic()
        while not self.state.stop_event.is_set():
            started = time.monotonic()
            dt = min(0.25, max(0.001, started - last))
            last = started

            if self.robot is not None:
                observation = self.robot.get_observation()
                self.state.update_actual(observation_to_joints(observation))

            target, should_send = self.state.next_target(dt)
            if should_send:
                action = {f"{joint}.pos": target[joint] for joint in ALL_JOINTS}
                if self.robot is not None:
                    sent = self.robot.send_action(action)
                    self.state.update_sent_target(sent)
                else:
                    # Dry-run simulation follows the same slew-limited target.
                    self.state.update_actual(target)
                    self.state.update_sent_target(action)
                self.state.log_state_if_due()

            remaining = period - (time.monotonic() - started)
            self.state.stop_event.wait(max(0.0, remaining))


class GatewayTCPServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, address: tuple[str, int], bridge: BridgeState):
        self.bridge = bridge
        super().__init__(address, GatewayRequestHandler)


class GatewayRequestHandler(socketserver.BaseRequestHandler):
    server: GatewayTCPServer

    def setup(self) -> None:
        super().setup()
        self.address = (str(self.client_address[0]), int(self.client_address[1]))
        self.accepted = self.server.bridge.register_client(self.address)
        self.request.settimeout(0.2)
        self.last_state_sent = 0.0

    def handle(self) -> None:
        if not self.accepted:
            self.send_message(BridgeState.error("Another Vision Pro client already owns the gateway"))
            return

        self.send_message(self.server.bridge.gateway_hello())
        buffer = bytearray()
        while not self.server.bridge.stop_event.is_set():
            try:
                data = self.request.recv(4096)
            except socket.timeout:
                if time.monotonic() - self.last_state_sent >= 0.5:
                    self.send_message(self.server.bridge.snapshot())
                continue
            except (ConnectionError, OSError):
                break

            if not data:
                break
            buffer.extend(data)
            if len(buffer) > 65_536:
                self.send_message(BridgeState.error("Input buffer exceeded 64 KiB"))
                break

            while b"\n" in buffer:
                line, _, remainder = buffer.partition(b"\n")
                buffer = bytearray(remainder)
                if not line.strip():
                    continue
                try:
                    payload = json.loads(line)
                    if not isinstance(payload, dict):
                        raise ValueError("message must be a JSON object")
                    response = self.server.bridge.handle_message(self.address, payload)
                except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as exc:
                    response = BridgeState.error(f"Invalid JSON message: {exc}")

                if response is not None:
                    self.send_message(response)
                elif time.monotonic() - self.last_state_sent >= 0.5:
                    # Keep telemetry useful without flooding the AVP's UI actor
                    # with a full state dictionary for every 30 Hz control.
                    self.send_message(self.server.bridge.snapshot())

    def finish(self) -> None:
        if getattr(self, "accepted", False):
            self.server.bridge.unregister_client(self.address)
        super().finish()

    def send_message(self, payload: dict[str, Any]) -> None:
        try:
            encoded = (json.dumps(payload, separators=(",", ":"), allow_nan=False) + "\n").encode()
            self.request.sendall(encoded)
            self.last_state_sent = time.monotonic()
        except (ConnectionError, OSError):
            pass


def wrapped_delta(value: float, origin: float) -> float:
    return (value - origin + math.pi) % (2 * math.pi) - math.pi


def rounded_dict(values: dict[str, float]) -> dict[str, float]:
    return {key: round(float(value), 3) for key, value in values.items()}


def observation_to_joints(observation: dict[str, Any]) -> dict[str, float]:
    return {joint: float(observation[f"{joint}.pos"]) for joint in ALL_JOINTS}


def calibration_limits(calibration: dict[str, Any], margin: float) -> dict[str, tuple[float, float]]:
    limits: dict[str, tuple[float, float]] = {}
    for joint in BODY_JOINTS:
        entry = calibration[joint]
        half_range_degrees = (entry.range_max - entry.range_min) * 180.0 / 4095.0
        safe_half_range = half_range_degrees * margin
        limits[joint] = (-safe_half_range, safe_half_range)
    # The normalized LeRobot gripper endpoints are its calibrated open/closed
    # positions. Current/torque protection and slew limiting remain active.
    limits["gripper"] = (0.0, 100.0)
    return limits


def startup_hardware_limits(
    hard_limits: dict[str, tuple[float, float]],
    collapsed_elbow_tolerance_deg: float,
) -> dict[str, tuple[float, float]]:
    limits = dict(hard_limits)
    low, high = limits["elbow_flex"]
    limits["elbow_flex"] = (
        low - collapsed_elbow_tolerance_deg,
        high + collapsed_elbow_tolerance_deg,
    )
    return limits


def parse_sign(value: str) -> int:
    parsed = int(value)
    if parsed not in (-1, 1):
        raise argparse.ArgumentTypeError("sign must be -1 or 1")
    return parsed


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--name", default=f"{platform.node()} Virtual SO-101")
    parser.add_argument("--listen-port", type=int, default=7443)
    parser.add_argument("--pairing-code", help="Four-digit code; random when omitted")
    parser.add_argument("--no-bonjour", action="store_true")

    parser.add_argument("--dry-run", action="store_true", help="Simulate follower state; never open serial")
    parser.add_argument("--allow-motion", action="store_true", help="Permit physical commands after confirmation")
    parser.add_argument(
        "--apply-saved-calibration",
        action="store_true",
        help="If motor EEPROM differs, write the existing robot-id calibration with torque disabled",
    )
    parser.add_argument("--robot-port", default="/dev/tty.usbmodem5AE60832001")
    parser.add_argument("--robot-id", default="arm")
    parser.add_argument("--fps", type=float, default=20.0)
    parser.add_argument("--command-timeout-ms", type=float, default=2000.0)
    parser.add_argument("--motion-scale", type=float, default=0.35)
    parser.add_argument(
        "--elbow-motion-scale",
        type=float,
        default=1.0,
        help="Independent elbow scale; full range lets a folded start extend",
    )
    parser.add_argument("--max-speed-deg-s", type=float, default=15.0)
    parser.add_argument("--max-gripper-speed", type=float, default=20.0)
    parser.add_argument("--limit-margin", type=float, default=0.90)
    parser.add_argument(
        "--collapsed-elbow-tolerance-deg",
        type=float,
        default=10.0,
        help="Bounded startup allowance beyond the calibrated elbow endpoint",
    )
    parser.add_argument("--log-state-hz", type=float, default=2.0)

    parser.add_argument("--shoulder-pan-sign", type=parse_sign, default=1)
    parser.add_argument("--shoulder-lift-sign", type=parse_sign, default=1)
    parser.add_argument("--elbow-flex-sign", type=parse_sign, default=1)
    parser.add_argument("--wrist-flex-sign", type=parse_sign, default=1)
    parser.add_argument("--wrist-roll-sign", type=parse_sign, default=1)
    parser.add_argument("--gripper-sign", type=parse_sign, default=1)
    return parser.parse_args()


def validate_args(args: argparse.Namespace) -> None:
    if not 1 <= args.listen_port <= 65535:
        raise SystemExit("--listen-port must be between 1 and 65535")
    if args.pairing_code is not None and (
        len(args.pairing_code) != 4
        or not args.pairing_code.isascii()
        or not args.pairing_code.isdigit()
    ):
        raise SystemExit("--pairing-code must contain exactly four ASCII digits")
    if args.fps <= 0 or args.fps > 60:
        raise SystemExit("--fps must be in (0, 60]")
    if not 50 <= args.command_timeout_ms <= 2000:
        raise SystemExit("--command-timeout-ms must be between 50 and 2000")
    if not 0 < args.motion_scale <= 1:
        raise SystemExit("--motion-scale must be in (0, 1]")
    if not 0 < args.elbow_motion_scale <= 1:
        raise SystemExit("--elbow-motion-scale must be in (0, 1]")
    if args.max_speed_deg_s <= 0 or args.max_gripper_speed <= 0:
        raise SystemExit("speed limits must be positive")
    if not 0 <= args.log_state_hz <= 20:
        raise SystemExit("--log-state-hz must be between 0 and 20")
    if not 0.5 <= args.limit_margin <= 1.0:
        raise SystemExit("--limit-margin must be between 0.5 and 1.0")
    if not 0 <= args.collapsed_elbow_tolerance_deg <= 20:
        raise SystemExit("--collapsed-elbow-tolerance-deg must be between 0 and 20")
    if not args.dry_run and not args.allow_motion:
        raise SystemExit("Physical mode requires --allow-motion (dry-run needs no serial device)")


def start_bonjour(args: argparse.Namespace) -> subprocess.Popen[bytes] | None:
    if args.no_bonjour:
        return None
    if shutil.which("dns-sd") is None:
        raise RuntimeError("macOS dns-sd was not found")
    return subprocess.Popen(
        [
            "dns-sd",
            "-R",
            args.name,
            SERVICE_TYPE,
            "local.",
            str(args.listen_port),
            "mode=virtual-leader",
            f"protocol={PROTOCOL_VERSION}",
            f"dry_run={'true' if args.dry_run else 'false'}",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def main() -> int:
    args = parse_args()
    validate_args(args)

    if not args.dry_run:
        print("\nPHYSICAL SO-101 MOTION REQUESTED")
        print("Clear the workspace and keep the physical power disconnect within reach.")
        confirmation = input('Type "DRIVE" to let paired AVP arm requests enable motion: ')
        if confirmation != "DRIVE":
            raise SystemExit("Motion permission not granted")

    pairing_code = args.pairing_code or f"{secrets.randbelow(10_000):04d}"
    bridge = BridgeState(args, pairing_code)
    server = GatewayTCPServer(("0.0.0.0", args.listen_port), bridge)
    server_thread = threading.Thread(target=server.serve_forever, name="gateway-tcp", daemon=True)
    worker = RobotWorker(bridge)
    advertiser: subprocess.Popen[bytes] | None = None

    def stop(_signum: int, _frame: object) -> None:
        bridge.stop_event.set()

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    try:
        advertiser = start_bonjour(args)
        server_thread.start()
        worker.start()

        print(f'Advertising "{args.name}" as {SERVICE_TYPE} on TCP {args.listen_port}')
        print(f"Vision Pro pairing code: {pairing_code}")
        print("Mode:", "DRY RUN (no serial)" if args.dry_run else "PHYSICAL FOLLOWER")
        print("Transport warning: paired but not encrypted; use a trusted private LAN.")
        print("Press Control-C to stop and disarm.", flush=True)

        while not bridge.stop_event.wait(0.5):
            if bridge.fault:
                print(bridge.fault, file=sys.stderr, flush=True)
                break
    finally:
        bridge.stop("Gateway shutting down")
        bridge.stop_event.set()
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=2)
        worker.join(timeout=5)
        if advertiser is not None:
            advertiser.terminate()
            try:
                advertiser.wait(timeout=2)
            except subprocess.TimeoutExpired:
                advertiser.kill()

    return 1 if bridge.fault else 0


if __name__ == "__main__":
    sys.exit(main())
