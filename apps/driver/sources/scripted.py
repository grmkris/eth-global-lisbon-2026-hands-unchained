"""Scripted keyframe choreography as a Teleoperator (sim-only source).

Takes the backend (for unit conversion) and keyframes at construction so this
module imports nothing from backends (no cycles).
"""

import time
from dataclasses import dataclass
from pathlib import Path

from sources.base import SourceBase


@dataclass
class ScriptedExpertConfig:
    id: str | None = "sim"
    calibration_dir: Path | None = None


class ScriptedExpert(SourceBase):
    """Loops keyframe interpolation; emits lerobot-unit joint targets."""

    name = "sim_expert"
    config_class = ScriptedExpertConfig

    def __init__(self, backend, keyframes) -> None:
        self.b = backend
        self.keyframes = keyframes
        self.motor_names = backend.lerobot_joint_names
        self.id = "sim"
        self.calibration_dir = None
        self.calibration = None
        self._t0 = time.time()

    def reset(self) -> None:
        self._t0 = time.time()

    def connect(self, calibrate: bool = True) -> None:  # noqa: ARG002
        self._t0 = time.time()  # restart the choreography clock

    def get_action(self) -> dict:
        t = (time.time() - self._t0) % sum(d for _, d in self.keyframes)
        prev = self.keyframes[0][0]
        for target, dur in self.keyframes:
            if t <= dur:
                alpha = t / dur if dur > 0 else 1.0
                rad = [p + (q - p) * alpha for p, q in zip(prev, target)]
                return self.b.rad_to_lerobot(rad)
            t -= dur
            prev = target
        return self.b.rad_to_lerobot(self.keyframes[-1][0])
