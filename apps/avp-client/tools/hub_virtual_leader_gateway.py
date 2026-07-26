#!/usr/bin/env python3
"""Bridge the Vision Pro virtual leader to a web-selected Proof of Hands rig.

The AVP keeps its paired Bonjour/TCP protocol. This Mac process registers only
as a hub leader input device. The browser owns the rig lease and selects this
leader; the gateway follows that binding automatically and forwards
relative-clutched LeRobot targets over the hub HTTP fallback.
"""

from __future__ import annotations

import argparse
import faulthandler
import http.client
import json
import math
import os
import platform
import secrets
import signal
import socket
import socketserver
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass, field
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
# Anti-windup: how far the commanded target may LEAD the rig's reported
# telemetry. The gateway does not know the rig's calibrated joint limits; when
# a command runs past the physical range the servo clips and telemetry stops
# following, but the internal target kept integrating — shoulder_lift was
# observed 110° past the limit, and unwinding that at motion scale 0.2 takes
# ~500° of hand travel before the arm visibly responds again. Telemetry lags
# about a second, so the margin must comfortably exceed max_speed_deg_s.
MAX_TARGET_LEAD_DEG = 20.0
MAX_TARGET_LEAD_GRIPPER = 35.0


def log_event(message: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {message}", flush=True)


def wrapped_delta(value: float, origin: float) -> float:
    return (value - origin + math.pi) % (2 * math.pi) - math.pi


def endpoint_clutched_value(
    value: float,
    virtual_base: float,
    physical_base: float,
    low: float,
    high: float,
    sign: int,
) -> float:
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
    # Edge continuation: -1/0/+1 per joint — the operator is holding a control
    # past the VIRTUAL envelope limit; keep driving the follower joint in that
    # direction so the whole physical envelope stays addressable.
    saturated: dict[str, int] = field(default_factory=dict)


class GatewayRequestHandler(socketserver.BaseRequestHandler):
    """Newline-delimited AVP protocol with state telemetry capped at 2 Hz."""

    def setup(self) -> None:
        super().setup()
        self.address = (str(self.client_address[0]), int(self.client_address[1]))
        self.accepted = self.server.bridge.register_client(self.address)
        self.request.settimeout(0.2)
        self.last_state_sent = 0.0

    def handle(self) -> None:
        if not self.accepted:
            self.send_message(self.server.bridge.error("Another Vision Pro owns the gateway"))
            return
        self.send_message(self.server.bridge.gateway_hello())
        buffer = bytearray()
        while not self.server.bridge.stop_event.is_set():
            try:
                data = self.request.recv(4096)
            except TimeoutError:
                if time.monotonic() - self.last_state_sent >= 0.5:
                    self.send_message(self.server.bridge.snapshot())
                continue
            except (ConnectionError, OSError):
                break
            if not data:
                break
            buffer.extend(data)
            if len(buffer) > 65_536:
                self.send_message(self.server.bridge.error("Input exceeded 64 KiB"))
                break
            while b"\n" in buffer:
                line, _, remainder = buffer.partition(b"\n")
                buffer = bytearray(remainder)
                if not line.strip():
                    continue
                try:
                    payload = json.loads(line)
                    if not isinstance(payload, dict):
                        raise ValueError("message must be an object")
                    response = self.server.bridge.handle_message(self.address, payload)
                except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as exc:
                    response = self.server.bridge.error(f"Invalid message: {exc}")
                if response is not None:
                    self.send_message(response)
                elif time.monotonic() - self.last_state_sent >= 0.5:
                    self.send_message(self.server.bridge.snapshot())

    def finish(self) -> None:
        if getattr(self, "accepted", False):
            self.server.bridge.unregister_client(self.address)
        super().finish()

    def send_message(self, payload: dict[str, Any]) -> None:
        try:
            data = (json.dumps(payload, separators=(",", ":"), allow_nan=False) + "\n").encode()
            self.request.sendall(data)
            self.last_state_sent = time.monotonic()
        except (ConnectionError, OSError):
            pass


class HubError(RuntimeError):
    pass


class InputDropped(RuntimeError):
    """A single lost input packet — latest-wins upstream, the next one corrects."""


class HubAPI:
    def __init__(self, base_url: str, token: str, timeout: float = 2.0):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout
        # Keep-alive connection for the 30 Hz input stream. A fresh urllib
        # request pays a full TLS handshake per POST (~150 ms), capping the
        # stream at ~6 packets/s — controller.py learned this the hard way.
        self._input_conn: http.client.HTTPConnection | None = None

    def request(self, method: str, path: str, payload: dict[str, Any] | None = None) -> Any:
        headers = {"accept": "application/json"}
        data = None
        if payload is not None:
            headers["content-type"] = "application/json"
            data = json.dumps(payload, separators=(",", ":"), allow_nan=False).encode()
        if self.token:
            headers["authorization"] = f"Bearer {self.token}"
        request = urllib.request.Request(
            f"{self.base_url}{path}", data=data, headers=headers, method=method
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return json.loads(response.read() or b"{}")
        except urllib.error.HTTPError as exc:
            try:
                detail = json.loads(exc.read() or b"{}").get("error", exc.reason)
            except (ValueError, AttributeError):
                detail = exc.reason
            raise HubError(f"hub HTTP {exc.code}: {detail}") from exc
        except OSError as exc:
            raise HubError(f"hub request failed: {exc}") from exc

    @staticmethod
    def rig_path(name: str) -> str:
        return f"/api/hub/rigs/{urllib.parse.quote(name, safe='')}"

    def list_rigs(self) -> list[dict[str, Any]]:
        value = self.request("GET", "/api/hub/rigs")
        return value if isinstance(value, list) else []

    def leader_link(self, name: str, driving: str | None) -> dict[str, Any]:
        return self.request(
            "POST", "/api/hub/leaders/link", {"name": name, "driving": driving}
        )

    def leader_command(
        self, name: str, client_id: str, action: str, rig: str | None = None
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"clientId": client_id, "action": action}
        if rig is not None:
            payload["rig"] = rig
        encoded = urllib.parse.quote(name, safe="")
        return self.request("POST", f"/api/hub/leaders/{encoded}/command", payload)

    def input(self, rig: str, leader_name: str, joints: dict[str, float]) -> None:
        """Stream one input packet over the kept-alive connection.

        Raises HubError on a hub refusal (403 — the binding is gone) and
        InputDropped on a transport failure (latest-wins; the caller keeps
        streaming and the next packet corrects).
        """
        headers = {"content-type": "application/json"}
        if self.token:
            headers["authorization"] = f"Bearer {self.token}"
        body = json.dumps(
            {"clientId": f"leader-{leader_name}", "joints": joints},
            separators=(",", ":"),
            allow_nan=False,
        )
        try:
            if self._input_conn is None:
                parsed = urllib.parse.urlparse(self.base_url)
                cls = (
                    http.client.HTTPSConnection
                    if parsed.scheme == "https"
                    else http.client.HTTPConnection
                )
                # short timeout: a stalled POST must not outlive the rig's 0.5s deadman
                self._input_conn = cls(parsed.netloc, timeout=0.5)
            self._input_conn.request(
                "POST", f"{self.rig_path(rig)}/input", body=body, headers=headers
            )
            response = self._input_conn.getresponse()
            raw = response.read()  # drain so the connection is reusable
            if response.status == 403:
                try:
                    detail = json.loads(raw or b"{}").get("error", "forbidden")
                except ValueError:
                    detail = "forbidden"
                raise HubError(f"hub HTTP 403: {detail}")
            if response.status >= 400:
                raise InputDropped(f"hub HTTP {response.status} on input")
        except (HubError, InputDropped):
            raise
        except OSError as exc:
            if self._input_conn is not None:
                self._input_conn.close()
                self._input_conn = None
            raise InputDropped(f"input packet dropped: {exc}") from exc

    def estop(self, rig: str, client_id: str) -> None:
        self.request(
            "POST",
            f"{self.rig_path(rig)}/command",
            {"clientId": client_id, "verb": "estop"},
        )


@dataclass
class RigView:
    name: str
    backend: str
    arm_state: str
    online: bool
    holder: str | None
    joints: dict[str, float]

    @classmethod
    def from_hub(cls, row: dict[str, Any]) -> "RigView | None":
        name = row.get("name")
        if not isinstance(name, str):
            return None
        raw_joints = row.get("joints")
        joints = {
            str(key): float(value)
            for key, value in (raw_joints.items() if isinstance(raw_joints, dict) else [])
            if isinstance(value, (int, float)) and math.isfinite(float(value))
        }
        return cls(
            name=name,
            backend=str(row.get("backend", "unknown")),
            arm_state=str(row.get("armState", "unknown")),
            online=bool(row.get("online", False)),
            holder=row.get("holder") if isinstance(row.get("holder"), str) else None,
            joints=joints,
        )

    def public(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "backend": self.backend,
            "arm_state": self.arm_state,
            "online": self.online,
            "holder": self.holder,
        }


class HubBridgeState:
    def __init__(self, args: argparse.Namespace, pairing_code: str):
        self.args = args
        self.pairing_code = pairing_code
        self.hub = HubAPI(args.hub_url, args.hub_token, args.http_timeout)
        self.client_id = f"avp-{uuid.uuid4().hex[:12]}"
        self.lock = threading.RLock()
        self.stop_event = threading.Event()

        self.client: tuple[str, int] | None = None
        self.paired_client: tuple[str, int] | None = None
        self.pairing_failures = 0
        self.pairing_locked_until = 0.0

        self.rigs: dict[str, RigView] = {}
        self.selected_rig: str | None = None
        self.leader_bound = False
        self.armed = False
        self.mode = "starting"
        self.message = "Connecting to the Proof of Hands hub"
        self.fault: str | None = None

        self.last_sequence = -1
        self.latest_command: VirtualCommand | None = None
        self.actual = {joint: (50.0 if joint == "gripper" else 0.0) for joint in ALL_JOINTS}
        self.target = dict(self.actual)
        self.arm_virtual_base: dict[str, float] | None = None
        self.arm_physical_base: dict[str, float] | None = None
        # First-order low-pass over the desired pose: absorbs hand tremor and
        # spatial-gesture noise before the slew limiter, at the cost of
        # ~smoothing_ms of lag. Reset (None) whenever clutches reset so
        # engagement never lags behind a stale filter state.
        self.smoothed: dict[str, float] | None = None
        self.gripper_virtual_base: float | None = None
        self.gripper_physical_base: float | None = None
        self.last_input_at = time.monotonic()
        self._last_control_log = 0.0
        # Watchdog: the hub worker bumps this every loop; a monitor dumps all
        # thread stacks if it stalls, because a silently hung worker looks
        # exactly like "the arm ignores me" from the operator's seat.
        self.worker_progress = time.monotonic()
        self.link_progress = time.monotonic()
        # Anti-windup leads scale with the configured speeds: the target may
        # lead ~1.5 s of telemetry lag worth of motion, else the lead itself
        # becomes the speed limit.
        self.max_lead_deg = max(20.0, args.max_speed_deg_s * 1.5)
        self.max_lead_gripper = max(35.0, args.max_gripper_speed * 1.5)
        # Per-joint virtual->physical gains. The virtual leader is an ABSOLUTE
        # IK device — its joint envelope is fixed by the virtual arm geometry —
        # so a gain below the range ratio makes the far end of the follower's
        # travel unreachable. Trim per joint where the envelopes differ.
        per_joint = {
            "shoulder_pan": getattr(args, "shoulder_pan_scale", None),
            "shoulder_lift": getattr(args, "shoulder_lift_scale", None),
            "elbow_flex": getattr(args, "elbow_motion_scale", None),
            "wrist_flex": getattr(args, "wrist_flex_scale", None),
            "wrist_roll": getattr(args, "wrist_roll_scale", None),
        }
        self.scales = {
            joint: (value if value is not None else args.motion_scale)
            for joint, value in per_joint.items()
        }

        self.signs = {
            "shoulder_pan": args.shoulder_pan_sign,
            "shoulder_lift": args.shoulder_lift_sign,
            "elbow_flex": args.elbow_flex_sign,
            "wrist_flex": args.wrist_flex_sign,
            "wrist_roll": args.wrist_roll_sign,
            "gripper": args.gripper_sign,
        }

    # GatewayRequestHandler interface -------------------------------------

    def register_client(self, address: tuple[str, int]) -> bool:
        with self.lock:
            if self.client is not None and self.client != address:
                return False
            self.client = address
            log_event(f"Vision Pro connected from {address[0]}:{address[1]}")
            return True

    def unregister_client(self, address: tuple[str, int]) -> None:
        with self.lock:
            if self.client != address:
                return
            self.client = None
            self.paired_client = None
        self.stop_drive("Vision Pro disconnected")
        log_event("Vision Pro disconnected; hub binding stopped")

    def gateway_hello(self) -> dict[str, Any]:
        return {
            "type": "gateway_hello",
            "protocol": PROTOCOL_VERSION,
            "gateway": self.args.name,
            "pairing_required": True,
            "allow_motion": True,
            "robot_ready": False,
            "robot_connected": False,
            "dry_run": False,
            "encrypted": False,
            "mode": "hub-leader",
            "leader_name": self.args.leader_name,
        }

    def handle_message(
        self, address: tuple[str, int], payload: dict[str, Any]
    ) -> dict[str, Any] | None:
        message_type = payload.get("type")
        if message_type == "hello":
            return self.gateway_hello()
        if message_type == "pair":
            return self._pair(address, payload)

        with self.lock:
            if self.paired_client != address:
                return self.error("Pairing is required")

        if message_type == "heartbeat":
            return self.snapshot()
        if message_type in {"list_rigs", "take_control", "release_control"}:
            return self.error("Manage rig selection in the Proof of Hands web interface")
        if message_type == "arm":
            return self.arm()
        if message_type == "stop":
            self.stop_drive("Stop requested from Vision Pro")
            return self.snapshot()
        if message_type == "estop":
            return self.estop()
        if message_type == "control":
            return self.handle_control(payload)
        return self.error(f"Unsupported message type: {message_type!r}")

    # Pairing and AVP commands -------------------------------------------

    def _pair(self, address: tuple[str, int], payload: dict[str, Any]) -> dict[str, Any]:
        code = str(payload.get("code", "")).strip()
        with self.lock:
            now = time.monotonic()
            if now < self.pairing_locked_until:
                return self.error(
                    f"Pairing locked; retry in {math.ceil(self.pairing_locked_until - now)} seconds"
                )
            if not secrets.compare_digest(code, self.pairing_code):
                self.pairing_failures += 1
                remaining = PAIRING_MAX_FAILURES - self.pairing_failures
                if remaining <= 0:
                    self.pairing_failures = 0
                    self.pairing_locked_until = now + PAIRING_LOCKOUT_SECONDS
                    return self.error("Too many incorrect codes; pairing temporarily locked")
                return self.error(f"Incorrect pairing code; {remaining} attempts remain")
            self.pairing_failures = 0
            self.paired_client = address
            self.last_sequence = -1
            self.latest_command = None
            self.message = "Paired; waiting for selection in the web hub"
        return {
            "type": "paired",
            "gateway": self.args.name,
            "robot_ready": False,
            "allow_motion": True,
        }

    def refresh_rigs(self) -> None:
        rows = self.hub.list_rigs()
        rigs = [rig for row in rows if (rig := RigView.from_hub(row)) is not None]
        with self.lock:
            self.rigs = {rig.name: rig for rig in rigs}
            if self.selected_rig in self.rigs:
                selected = self.rigs[self.selected_rig]
                for joint in ALL_JOINTS:
                    if joint in selected.joints:
                        self.actual[joint] = selected.joints[joint]
            elif self.selected_rig is not None:
                self.leader_bound = False
                self.armed = False
                self.latest_command = None
                self._clear_clutches_locked()

    def arm(self) -> dict[str, Any]:
        with self.lock:
            if not self.leader_bound or self.selected_rig is None:
                return self.error("Select this leader for a rig in the web hub before arming")
            self.armed = True
            self.mode = "armed"
            self.message = f"Armed on {self.selected_rig}; grab a virtual control to move"
            self.target = dict(self.actual)
            self._clear_clutches_locked()
        log_event("AVP leader armed; holding until a virtual control is grabbed")
        return self.snapshot()

    def estop(self) -> dict[str, Any]:
        with self.lock:
            rig = self.selected_rig
        if rig is None:
            return self.error("No rig is selected")
        try:
            self.hub.estop(rig, self.client_id)
            self.stop_drive("E-STOP requested")
            return self.snapshot()
        except HubError as exc:
            return self.error(str(exc))

    def handle_control(self, payload: dict[str, Any]) -> dict[str, Any] | None:
        try:
            sequence = int(payload["sequence"])
            joints = payload["joints_rad"]
            joints_rad = {joint: float(joints[joint]) for joint in BODY_JOINTS}
            gripper = float(payload["gripper"])
            arm_active = bool(payload["arm_active"])
            gripper_active = bool(payload["gripper_active"])
            raw_saturated = payload.get("saturated") or {}
            saturated = {
                joint: value
                for joint in ALL_JOINTS
                if (value := int(raw_saturated.get(joint, 0))) in (-1, 1)
            }
        except (KeyError, TypeError, ValueError) as exc:
            return self.error(f"Malformed control frame: {exc}")
        values = (*joints_rad.values(), gripper)
        if not all(math.isfinite(value) for value in values):
            return self.error("Control frame contains a non-finite value")
        if any(abs(value) > 4 * math.pi for value in joints_rad.values()):
            return self.error("Joint angle is outside the protocol sanity bound")
        if not 0 <= gripper <= 1:
            return self.error("Gripper must be between 0 and 1")

        with self.lock:
            if sequence <= self.last_sequence:
                return None
            self.last_sequence = sequence
            self.latest_command = VirtualCommand(
                sequence=sequence,
                received_at=time.monotonic(),
                joints_rad=joints_rad,
                gripper=gripper,
                arm_active=arm_active,
                gripper_active=gripper_active,
                saturated=saturated,
            )
            # Diagnostic: one line per second of what the headset is actually
            # sending, so "app-side frozen input" and "gateway-side mapping"
            # failures are distinguishable from the log alone.
            now = time.monotonic()
            if now - self._last_control_log >= 1.0:
                self._last_control_log = now
                flags = f"{'A' if arm_active else '-'}{'G' if gripper_active else '-'}"
                pan = math.degrees(joints_rad["shoulder_pan"])
                lift = math.degrees(joints_rad["shoulder_lift"])
                log_event(
                    f"avp-in seq={sequence} [{flags}] grip={gripper:.3f} "
                    f"pan={pan:.1f} lift={lift:.1f}"
                )
        return None

    # Hub worker operations ----------------------------------------------

    def next_input(self, dt: float) -> tuple[str, dict[str, float]] | None:
        with self.lock:
            command = self.latest_command
            if not self.armed or not self.leader_bound or self.selected_rig is None or command is None:
                return None
            age = time.monotonic() - command.received_at
            if age > self.args.command_timeout_ms / 1000:
                self.armed = False
                self.mode = "timeout"
                self.message = f"AVP control timed out after {age * 1000:.0f} ms"
                self._clear_clutches_locked()
                return None

            desired = dict(self.target)
            active = False
            saturated_joints: list[str] = []
            if command.arm_active:
                active = True
                if self.arm_virtual_base is None:
                    # Clutch against the LAST COMMANDED target, not hub telemetry:
                    # telemetry lags by up to a poll interval, and the AVP's
                    # freshness deadman drops the active flag between UI updates,
                    # so clutches re-engage constantly. Re-basing on stale
                    # telemetry snapped the arm back on every re-engage (visible
                    # jerking) and reset gripper progress to zero before it could
                    # accumulate. The target was seeded from telemetry at arm().
                    self.arm_virtual_base = dict(command.joints_rad)
                    self.arm_physical_base = dict(self.target)
                    log_event("Remote arm clutch engaged at the commanded pose")
                assert self.arm_physical_base is not None
                for joint in BODY_JOINTS:
                    sat = command.saturated.get(joint, 0)
                    if sat:
                        # Edge continuation: the virtual joint is parked at its
                        # envelope limit but the operator keeps pushing — ramp
                        # the follower joint onward and pin the clutch at the
                        # edge so backing off resumes seamlessly with no jump.
                        desired[joint] = (
                            self.target[joint]
                            + sat * self.signs[joint] * self.args.edge_rate_deg_s * dt
                        )
                        self.arm_virtual_base[joint] = command.joints_rad[joint]
                        saturated_joints.append(joint)
                        continue
                    delta = wrapped_delta(command.joints_rad[joint], self.arm_virtual_base[joint])
                    desired[joint] = (
                        self.arm_physical_base[joint]
                        + self.signs[joint] * math.degrees(delta) * self.scales[joint]
                    )
            else:
                self.arm_virtual_base = None
                self.arm_physical_base = None

            if command.gripper_active:
                active = True
                if self.gripper_virtual_base is None:
                    self.gripper_virtual_base = command.gripper
                    self.gripper_physical_base = self.target["gripper"]
                    desired["gripper"] = self.target["gripper"]
                    log_event("Remote gripper clutch engaged")
                assert self.gripper_physical_base is not None
                grip_sat = command.saturated.get("gripper", 0)
                if grip_sat:
                    # Slider held against an end of its rail: keep driving the
                    # follower gripper toward its own endpoint, and pin the
                    # clutch at the edge so backing off resumes seamlessly.
                    desired["gripper"] = (
                        self.target["gripper"]
                        + grip_sat * self.signs["gripper"] * self.args.max_gripper_speed * dt
                    )
                    self.gripper_virtual_base = command.gripper
                    saturated_joints.append("gripper")
                else:
                    desired["gripper"] = endpoint_clutched_value(
                        command.gripper,
                        self.gripper_virtual_base,
                        self.gripper_physical_base,
                        0.0,
                        100.0,
                        self.signs["gripper"],
                    )
            else:
                self.gripper_virtual_base = None
                self.gripper_physical_base = None

            # STREAM CONTINUOUSLY, exactly like controller.py streams the
            # leader arm's pose whether or not the human is moving. The hub
            # input slot is consume-once with a 500 ms freshness gate and the
            # rig freezes 0.5 s after the last packet — a leader that goes
            # quiet while "holding" starves the rig, and re-activation then
            # passes only a couple of slew-limited micro-steps per burst.
            # Holding is expressed by re-sending the unchanged target.
            if not active:
                self.mode = "armed"
                self.message = f"Armed on {self.selected_rig}; holding"
                return self.selected_rig, {
                    f"{joint}.pos": value for joint, value in self.target.items()
                }

            # Low-pass the desired pose (except edge-continued joints, whose
            # ramp is already smooth and must not be attenuated).
            tau = self.args.smoothing_ms / 1000.0
            if self.smoothed is None:
                self.smoothed = dict(self.target)
            alpha = 1.0 if tau <= 0 else dt / (tau + dt)
            for joint in ALL_JOINTS:
                if joint in saturated_joints:
                    self.smoothed[joint] = desired[joint]
                else:
                    self.smoothed[joint] += alpha * (desired[joint] - self.smoothed[joint])

            limited: dict[str, float] = {}
            for joint in ALL_JOINTS:
                low, high = ((0.0, 100.0) if joint == "gripper" else (-180.0, 180.0))
                bounded = min(high, max(low, self.smoothed[joint]))
                speed = self.args.max_gripper_speed if joint == "gripper" else self.args.max_speed_deg_s
                step = speed * dt
                previous = self.target[joint]
                value = previous + min(step, max(-step, bounded - previous))
                # Anti-windup: stay within a bounded lead of rig telemetry so a
                # clipped joint re-responds the moment the operator reverses.
                lead = self.max_lead_gripper if joint == "gripper" else self.max_lead_deg
                anchor = self.actual[joint]
                limited[joint] = min(anchor + lead, max(anchor - lead, value))
            self.target = limited
            # Pin edge-continued clutches at the POST-slew target: pinning at
            # the pre-slew desired left the base ahead of the arm and the joint
            # coasted on briefly after the operator backed off the edge.
            for joint in saturated_joints:
                if joint == "gripper":
                    if self.gripper_physical_base is not None:
                        self.gripper_physical_base = limited[joint]
                elif command.arm_active and self.arm_physical_base is not None:
                    self.arm_physical_base[joint] = limited[joint]
            self.mode = "active"
            self.message = f"Driving {self.selected_rig}"
            self.last_input_at = time.monotonic()
            return self.selected_rig, {f"{joint}.pos": value for joint, value in limited.items()}

    def update_link(self) -> None:
        with self.lock:
            reported_rig = self.selected_rig
        response = self.hub.leader_link(self.args.leader_name, reported_rig)
        command = response.get("command")
        bound = bool(response.get("bound", False))

        if isinstance(command, dict) and command.get("action") == "drive":
            rig_name = command.get("rig")
            if not isinstance(rig_name, str) or not rig_name:
                raise HubError("hub sent a drive command without a rig")
            with self.lock:
                self.selected_rig = rig_name
                self.leader_bound = bound
                self.armed = False
                self.latest_command = None
                self.mode = "bound" if bound else "binding"
                self.message = (
                    f"Web hub selected {rig_name}; press Arm"
                    if bound
                    else f"Waiting for web binding to {rig_name}"
                )
                self._clear_clutches_locked()
            self.refresh_rigs()
            with self.lock:
                self.target = dict(self.actual)
            log_event(f"Web hub selected {rig_name}; binding detected automatically")
            return

        if isinstance(command, dict) and command.get("action") == "stop":
            with self.lock:
                self.armed = False
                self.leader_bound = False
                self.selected_rig = None
                self.latest_command = None
                self.mode = "disarmed"
                self.message = "Stopped by the web hub"
                self._clear_clutches_locked()
            return

        with self.lock:
            if self.selected_rig is not None and not bound:
                lost_rig = self.selected_rig
                self.armed = False
                self.leader_bound = False
                self.selected_rig = None
                self.latest_command = None
                self.mode = "disarmed"
                self.message = f"Web binding to {lost_rig} ended"
                self._clear_clutches_locked()
                log_event(self.message)
            elif self.selected_rig is not None:
                if not self.leader_bound:
                    self.mode = "bound"
                    self.message = f"Web hub selected {self.selected_rig}; press Arm"
                self.leader_bound = True
            else:
                self.leader_bound = False
                self.mode = "waiting"
                self.message = "Waiting for selection in the Proof of Hands web hub"

    def stop_drive(self, reason: str) -> None:
        with self.lock:
            rig = self.selected_rig
            self.armed = False
            self.leader_bound = False
            self.latest_command = None
            self.mode = "disarmed"
            self.message = reason
            self._clear_clutches_locked()
            self.selected_rig = None
        if rig:
            try:
                # Stop is a safety action. It clears only the leader binding;
                # the browser remains the rig lease holder.
                self.hub.leader_command(self.args.leader_name, self.client_id, "stop")
            except HubError as exc:
                log_event(f"Could not stop leader binding: {exc}")

    def _clear_clutches_locked(self) -> None:
        self.arm_virtual_base = None
        self.arm_physical_base = None
        self.gripper_virtual_base = None
        self.gripper_physical_base = None
        self.smoothed = None

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            return {
                "type": "state",
                "protocol": PROTOCOL_VERSION,
                "mode": self.mode,
                "message": self.message,
                "armed": self.armed,
                "robot_ready": bool(self.leader_bound and self.selected_rig),
                "robot_connected": bool(self.selected_rig),
                "allow_motion": True,
                "dry_run": False,
                "fault": self.fault,
                "actual": {key: round(value, 3) for key, value in self.actual.items()},
                "target": {key: round(value, 3) for key, value in self.target.items()},
                "selected_rig": self.selected_rig,
                "leader_bound": self.leader_bound,
                "last_sequence": self.last_sequence,
            }

    @staticmethod
    def error(message: str) -> dict[str, Any]:
        return {"type": "error", "message": message}


def open_input_socket(hub: str, name: str, token: str):
    """The hub's WS input plane — fire-and-forget input frames at full rate,
    exactly like controller.py. Returns None when unavailable; the caller then
    uses the keep-alive HTTP input path, which must stay working."""
    try:
        from websockets.sync.client import connect
    except ImportError:
        log_event("websockets not installed — input rides keep-alive HTTP")
        return None
    url = hub.replace("http", "ws", 1) + "/api/hub/ws?role=leader&name=" + urllib.parse.quote(name)
    if token:
        url += "&token=" + urllib.parse.quote(token)
    try:
        sock = connect(url, open_timeout=3, close_timeout=1)
        log_event("input socket up — streaming at full rate")
        return sock
    except Exception as exc:  # noqa: BLE001 — any failure means: use HTTP
        log_event(f"input socket unavailable ({exc}) — input rides HTTP")
        return None


class ControlPlaneWorker(threading.Thread):
    """Leader heartbeat + rig telemetry on their own thread, so their TLS
    round-trips can never stall the input stream."""

    def __init__(self, state: HubBridgeState):
        super().__init__(name="hub-control-plane", daemon=True)
        self.state = state

    def run(self) -> None:
        last_rigs = 0.0
        last_reported_error: str | None = None
        while not self.state.stop_event.wait(0.5):
            try:
                self.state.link_progress = time.monotonic()
                self.state.update_link()
                if time.monotonic() - last_rigs >= 1.0:
                    self.state.refresh_rigs()
                    last_rigs = time.monotonic()
                with self.state.lock:
                    if self.state.fault is not None:
                        self.state.fault = None
                        if self.state.selected_rig is None:
                            self.state.mode = "disarmed"
                            self.state.message = "Hub restored; waiting for web selection"
                last_reported_error = None
            except Exception as exc:  # noqa: BLE001 — the bridge must outlive any hub fault
                detail = str(exc) if isinstance(exc, HubError) else f"hub loop error: {exc!r}"
                with self.state.lock:
                    self.state.fault = detail
                    self.state.armed = False
                    self.state.leader_bound = False
                    self.state.latest_command = None
                    self.state.mode = "fault"
                    self.state.message = detail
                    self.state._clear_clutches_locked()
                if detail != last_reported_error:
                    log_event(detail)
                    last_reported_error = detail


class HubWorker(threading.Thread):
    """The input streamer: integrate targets and ship them at ~30 Hz over the
    WS input plane (fire-and-forget), falling back to keep-alive HTTP."""

    def __init__(self, state: HubBridgeState):
        super().__init__(name="proof-of-hands-hub-loop", daemon=True)
        self.state = state
        self.ws = None
        self.ws_retry_at = 0.0

    def _send(self, rig: str, joints: dict[str, float]) -> None:
        now = time.monotonic()
        if self.ws is None and now >= self.ws_retry_at:
            self.ws = open_input_socket(
                self.state.args.hub_url, self.state.args.leader_name, self.state.args.hub_token
            )
            self.ws_retry_at = now + 10.0
        if self.ws is not None:
            try:
                self.ws.send(json.dumps({"t": "input", "rig": rig, "joints": joints}))
                return
            except Exception:  # noqa: BLE001 — socket died; HTTP for the rest
                log_event("input socket dropped — falling back to HTTP input")
                try:
                    self.ws.close()
                except Exception:  # noqa: BLE001
                    pass
                self.ws = None
        self.state.hub.input(rig, self.state.args.leader_name, joints)

    def run(self) -> None:
        last_motion = time.monotonic()
        drops_since: float | None = None
        last_reported_error: str | None = None
        while not self.state.stop_event.wait(0.02):
            try:
                now = time.monotonic()
                self.state.worker_progress = now
                # dt spans the full cycle, including any blocking send.
                dt = min(0.25, max(0.001, now - last_motion))
                last_motion = now
                packet = self.state.next_input(dt)
                if packet is not None:
                    rig, joints = packet
                    try:
                        self._send(rig, joints)
                        drops_since = None
                    except InputDropped as exc:
                        # Latest-wins: keep streaming, the next packet corrects.
                        if drops_since is None:
                            drops_since = time.monotonic()
                        elif time.monotonic() - drops_since > 2.0:
                            drops_since = None
                            raise HubError(f"input stream down for 2 s: {exc}") from exc
                last_reported_error = None
            except Exception as exc:  # noqa: BLE001 — the bridge must outlive any hub fault
                detail = str(exc) if isinstance(exc, HubError) else f"input loop error: {exc!r}"
                with self.state.lock:
                    self.state.fault = detail
                    self.state.armed = False
                    self.state.mode = "fault"
                    self.state.message = detail
                    self.state._clear_clutches_locked()
                if detail != last_reported_error:
                    log_event(detail)
                    last_reported_error = detail
                self.state.stop_event.wait(0.5)


class WorkerWatchdog(threading.Thread):
    """Logs and stack-dumps when the hub worker stops making progress."""

    def __init__(self, state: HubBridgeState):
        super().__init__(name="hub-worker-watchdog", daemon=True)
        self.state = state

    def run(self) -> None:
        last_dump = 0.0
        while not self.state.stop_event.wait(2.0):
            stalled = time.monotonic() - min(
                self.state.worker_progress, self.state.link_progress
            )
            if stalled > 5.0 and time.monotonic() - last_dump > 10.0:
                last_dump = time.monotonic()
                log_event(
                    f"HUB WORKER STALLED for {stalled:.1f}s — dumping thread stacks"
                )
                faulthandler.dump_traceback(file=sys.stderr)


class GatewayTCPServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, address: tuple[str, int], bridge: HubBridgeState):
        self.bridge = bridge
        super().__init__(address, GatewayRequestHandler)


def parse_sign(value: str) -> int:
    parsed = int(value)
    if parsed not in (-1, 1):
        raise argparse.ArgumentTypeError("sign must be -1 or 1")
    return parsed


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--name", default=f"{platform.node()} AVP Hub Gateway")
    parser.add_argument("--listen-port", type=int, default=7443)
    parser.add_argument("--pairing-code", help="Four-digit AVP pairing code; random when omitted")
    parser.add_argument("--no-bonjour", action="store_true")
    parser.add_argument(
        "--hub-url",
        default=os.environ.get("HUB_URL", "https://web-production-b5106.up.railway.app"),
    )
    parser.add_argument("--hub-token", default=os.environ.get("HUB_TOKEN", ""))
    parser.add_argument("--leader-name", default=f"{platform.node().split('.')[0]}-avp")
    parser.add_argument("--http-timeout", type=float, default=2.0)
    parser.add_argument("--command-timeout-ms", type=float, default=500.0)
    parser.add_argument("--motion-scale", type=float, default=1.0)
    parser.add_argument("--elbow-motion-scale", type=float, default=None)
    parser.add_argument("--shoulder-pan-scale", type=float, default=None)
    parser.add_argument("--shoulder-lift-scale", type=float, default=None)
    parser.add_argument("--wrist-flex-scale", type=float, default=None)
    parser.add_argument("--wrist-roll-scale", type=float, default=None)
    parser.add_argument("--max-speed-deg-s", type=float, default=8.0)
    parser.add_argument("--edge-rate-deg-s", type=float, default=30.0)
    parser.add_argument("--smoothing-ms", type=float, default=120.0)
    parser.add_argument("--max-gripper-speed", type=float, default=12.0)
    parser.add_argument("--shoulder-pan-sign", type=parse_sign, default=1)
    parser.add_argument("--shoulder-lift-sign", type=parse_sign, default=1)
    parser.add_argument("--elbow-flex-sign", type=parse_sign, default=1)
    parser.add_argument("--wrist-flex-sign", type=parse_sign, default=1)
    parser.add_argument("--wrist-roll-sign", type=parse_sign, default=1)
    parser.add_argument("--gripper-sign", type=parse_sign, default=1)
    return parser.parse_args()


def start_bonjour(args: argparse.Namespace) -> subprocess.Popen[bytes] | None:
    if args.no_bonjour:
        return None
    return subprocess.Popen(
        [
            "dns-sd",
            "-R",
            args.name,
            SERVICE_TYPE,
            "local.",
            str(args.listen_port),
            "mode=hub-virtual-leader",
            f"protocol={PROTOCOL_VERSION}",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def main() -> int:
    args = parse_args()
    if not 1 <= args.listen_port <= 65535:
        raise SystemExit("--listen-port must be between 1 and 65535")
    if args.pairing_code is not None and (
        len(args.pairing_code) != 4 or not args.pairing_code.isascii() or not args.pairing_code.isdigit()
    ):
        raise SystemExit("--pairing-code must contain exactly four ASCII digits")
    if not 50 <= args.command_timeout_ms <= 2000:
        raise SystemExit("--command-timeout-ms must be between 50 and 2000")
    scales = [
        args.motion_scale,
        args.elbow_motion_scale,
        args.shoulder_pan_scale,
        args.shoulder_lift_scale,
        args.wrist_flex_scale,
        args.wrist_roll_scale,
    ]
    if any(s is not None and not 0 < s <= 2 for s in scales):
        raise SystemExit("motion scales must be in (0, 2]")
    if not 0 < args.edge_rate_deg_s <= 180:
        raise SystemExit("--edge-rate-deg-s must be in (0, 180]")
    if not 0 <= args.smoothing_ms <= 1000:
        raise SystemExit("--smoothing-ms must be in [0, 1000]")

    # Bound EVERY blocking socket operation, including DNS resolution and
    # connection establishment, which per-request timeouts do not cover — an
    # unbounded getaddrinfo can hang the hub worker silently for minutes.
    socket.setdefaulttimeout(5.0)

    pairing_code = args.pairing_code or f"{secrets.randbelow(10_000):04d}"
    state = HubBridgeState(args, pairing_code)
    server = GatewayTCPServer(("0.0.0.0", args.listen_port), state)
    server_thread = threading.Thread(target=server.serve_forever, name="gateway-tcp", daemon=True)
    worker = HubWorker(state)
    advertiser: subprocess.Popen[bytes] | None = None

    def stop(_signum: int, _frame: object) -> None:
        state.stop_event.set()

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    try:
        state.refresh_rigs()
        advertiser = start_bonjour(args)
        server_thread.start()
        worker.start()
        ControlPlaneWorker(state).start()
        WorkerWatchdog(state).start()
        print(f'Advertising "{args.name}" as {SERVICE_TYPE} on TCP {args.listen_port}')
        print(f"Vision Pro pairing code: {pairing_code}")
        print(f"Hub: {args.hub_url}")
        print(f"Leader: {args.leader_name}")
        print("Select this leader from a rig page in the web hub.")
        print("Press Control-C to stop the leader binding.", flush=True)
        while not state.stop_event.wait(0.5):
            pass
    except HubError as exc:
        print(exc, file=sys.stderr)
        return 1
    finally:
        state.stop_drive("Gateway shutting down")
        state.stop_event.set()
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=2)
        worker.join(timeout=3)
        if advertiser is not None:
            advertiser.terminate()
            try:
                advertiser.wait(timeout=2)
            except subprocess.TimeoutExpired:
                advertiser.kill()
    return 0


if __name__ == "__main__":
    sys.exit(main())
