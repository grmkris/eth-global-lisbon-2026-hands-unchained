"""Browser-keyboard teleop source — lerobot-native EE control.

lerobot's KeyboardEndEffectorTeleop with ONLY the input layer swapped: axis
state arrives from the browser via the driver's `teleop_input` RPC instead of
pynput (which needs macOS Accessibility permission). Everything downstream is
lerobot's own chain (see sources/ee_chain.py).

Runs open-loop: the joint observation fed to the chain is the last action this
source emitted (seeded from the backend's measured joints at start) — the
standard way to run these steps without holding a robot handle.
"""

import time
from dataclasses import dataclass
from pathlib import Path

from sources.base import STALE_INPUT_S, SourceBase
from sources.ee_chain import build_ee_pipeline


@dataclass
class BrowserKeysConfig:
    id: str | None = "browser"
    calibration_dir: Path | None = None


class BrowserKeys(SourceBase):
    name = "browser_keys"
    config_class = BrowserKeysConfig

    def __init__(self, motor_names: list[str], seed_obs: dict[str, float]) -> None:
        self.id = "browser"
        self.calibration_dir = None
        self.calibration = None
        self.motor_names = motor_names
        # per-frame jog step at 30 fps: 0.0025 m -> ~0.075 m/s at full deflection
        self.pipeline = build_ee_pipeline(motor_names)

        self.axes = {"x": 0.0, "y": 0.0, "z": 0.0, "gripper": 0.0}
        self.last_input = 0.0
        self.obs: dict[str, float] = dict(seed_obs)

    def set_input(self, axes: dict) -> None:
        for key in self.axes:
            if key in axes:
                self.axes[key] = max(-1.0, min(1.0, float(axes[key])))
        self.last_input = time.time()

    def get_action(self) -> dict:
        stale = time.time() - self.last_input > STALE_INPUT_S
        ax = dict.fromkeys(self.axes, 0.0) if stale else self.axes
        active = any(abs(v) > 1e-6 for v in ax.values())

        raw = {
            "enabled": active,
            "target_x": ax["x"],
            "target_y": ax["y"],
            "target_z": ax["z"],
            "target_wx": 0.0,
            "target_wy": 0.0,
            "target_wz": 0.0,
            "gripper_vel": ax["gripper"],
        }
        joint_action = self.pipeline((raw, self.obs))
        self.obs = dict(joint_action)  # open-loop feedback for FK/IK seeding
        return joint_action
