"""Phone teleop source — lerobot-native (HEBI Mobile I/O on iPhone).

100% lerobot classes: `Phone` (IOSPhone under the hood; ARKit pose over the
HEBI SDK) + `MapPhoneActionToRobotAction` + the shared EE chain
(sources/ee_chain.py). B1 = deadman/clutch (hold to drive; rising edge
re-latches the reference), A3 slider = gripper velocity.

iOS `get_next_feedback()` blocks, so a daemon listener thread owns the phone
link (discovery retries + calibration + reads) and caches the latest phone
action; `get_action()` (30 Hz from the teleop/record loop) maps the cache
through the pipeline. Until the phone is up — or when its data goes stale —
the source emits its last joint action, i.e. the arm holds pose.

Runbook: iPhone hotspot (or same LAN), macOS firewall off, HEBI Mobile I/O app
foreground with screen on. See phone_teleop/README.md.

Proven parameter set from phone_teleop/teleoperate.py: step sizes 0.3
(gentler phone->arm mapping), latched reference, max_ee_step_m 0.08,
gripper speed 20.
"""

import threading
import time
from dataclasses import dataclass
from pathlib import Path

from shared import emit, log
from sources.base import STALE_INPUT_S, SourceBase
from sources.ee_chain import build_ee_pipeline

CONNECT_RETRIES = 10  # app backgrounding / screen lock drops it off the network
CONNECT_RETRY_S = 2.0


@dataclass
class PhoneSourceConfig:
    id: str | None = "phone"
    calibration_dir: Path | None = None


class PhoneSource(SourceBase):
    name = "phone_source"
    config_class = PhoneSourceConfig

    def __init__(self, motor_names: list[str], seed_obs: dict[str, float]) -> None:
        from lerobot.teleoperators.phone import Phone, PhoneConfig
        from lerobot.teleoperators.phone.config_phone import PhoneOS
        from lerobot.teleoperators.phone.phone_processor import MapPhoneActionToRobotAction

        self.id = "phone"
        self.calibration_dir = None
        self.calibration = None
        self.motor_names = motor_names
        self.pipeline = build_ee_pipeline(
            motor_names,
            step_size_m=0.3,
            gripper_speed=20.0,
            use_latched_reference=True,
            front_steps=(MapPhoneActionToRobotAction(platform=PhoneOS.IOS),),
        )
        self.phone = Phone(PhoneConfig(id="phone", phone_os=PhoneOS.IOS))

        self.obs: dict[str, float] = dict(seed_obs)
        self._lock = threading.Lock()
        self._latest: dict | None = None
        self._latest_ts = 0.0
        self._stop = False
        threading.Thread(target=self._listener, name="phone-listener", daemon=True).start()

    # ---------- phone link (daemon thread; lerobot's Android caching pattern) ----------

    def _listener(self) -> None:
        for attempt in range(CONNECT_RETRIES):
            if self._stop:
                return
            try:
                # blocks: 2s HEBI lookup, then B1-hold calibration capture
                self.phone.connect()
                break
            except Exception as exc:  # noqa: BLE001
                log(
                    f"phone connect {attempt + 1}/{CONNECT_RETRIES}: {exc} — "
                    "HEBI app foreground, screen on, same network/hotspot, firewall off"
                )
                time.sleep(CONNECT_RETRY_S)
        else:
            emit({
                "event": "error",
                "where": "phone",
                "error": "phone not found after retries — HEBI Mobile I/O app open? same network? firewall off?",
            })
            return

        log("phone connected + calibrated — hold B1 to drive, A3 slider = gripper")
        while not self._stop:
            try:
                action = self.phone.get_action()
            except Exception as exc:  # noqa: BLE001
                log(f"phone read error (skipped): {exc}")
                time.sleep(0.05)
                continue
            if action:
                with self._lock:
                    self._latest = action
                    self._latest_ts = time.time()

    # ---------- teleop/record loop side ----------

    def get_action(self) -> dict:
        with self._lock:
            raw = self._latest
            ts = self._latest_ts
        if raw is None or time.time() - ts > STALE_INPUT_S:
            return dict(self.obs)  # phone not up / stale -> hold pose
        try:
            joint_action = self.pipeline((dict(raw), self.obs))
        except ValueError as exc:
            log(f"phone frame skipped: {exc}")  # proven mode: bad frames skip, never crash
            return dict(self.obs)
        self.obs = dict(joint_action)  # open-loop feedback for FK/IK seeding
        return joint_action

    # boilerplate from SourceBase; disconnect is real — the phone link is ours

    def disconnect(self) -> None:
        self._stop = True
        try:
            if self.phone.is_connected:
                self.phone.disconnect()
        except Exception as exc:  # noqa: BLE001
            log(f"phone disconnect (ignored): {exc}")
