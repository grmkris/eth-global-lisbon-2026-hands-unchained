"""Remote-joints teleop source — joint targets arriving over the hub link.

The operator's machine (controller.py) reads a physical leader arm and ships
its lerobot-space action dict (degrees + gripper 0..100, `<joint>.pos` keys)
through the hub; this source hands the latest one to the teleop loop. No IK,
no remapping — cross-device leader->follower works by construction in lerobot
0.6.0 because each end normalizes through its OWN calibration.

Safety on the wire:
- values are clamped and non-finite ones dropped BEFORE they reach the
  backend (a negative raw tick raises deep inside lerobot's _unnormalize —
  a malformed packet must not kill the loop)
- the last action is simply re-served between packets, so a network stall
  freezes the arm in place; the hub's own 500ms consume-once gate is the
  deadman that stops stale input from arriving at all
"""

import math

from sources.base import SourceBase

BODY_RANGE = (-180.0, 180.0)  # degrees; servo EEPROM limits are the real gate
GRIPPER_RANGE = (0.0, 100.0)


class RemoteJointsConfig:
    id: str | None = "remote"
    calibration_dir = None


class RemoteJoints(SourceBase):
    name = "remote_joints"
    config_class = RemoteJointsConfig

    def __init__(self, motor_names: list[str], seed_obs: dict[str, float]) -> None:
        self.id = "remote"
        self.calibration_dir = None
        self.calibration = None
        self.motor_names = motor_names
        # hold pose until the first packet lands
        self.action: dict[str, float] = dict(seed_obs)

    def set_joints(self, joints: dict) -> None:
        cleaned: dict[str, float] = {}
        for name in self.motor_names:
            key = f"{name}.pos"
            value = joints.get(key, joints.get(name))
            if value is None:
                continue
            value = float(value)
            if not math.isfinite(value):
                continue
            lo, hi = GRIPPER_RANGE if name == "gripper" else BODY_RANGE
            cleaned[key] = max(lo, min(hi, value))
        if cleaned:
            self.action.update(cleaned)

    def get_action(self) -> dict:
        return dict(self.action)
