"""Shared no-op Teleoperator plumbing for the driver's synthetic sources.

lerobot's record/teleop loops accept any Teleoperator; our sources (browser
keys, phone, scripted expert, remote joints) have no calibration, no feedback
channel and are always "connected" — this base carries that boilerplate once.
Subclasses provide `get_action()` and set `self.motor_names`; override
`connect`/`disconnect` only where a real resource is owned (phone link,
scripted clock).
"""

from lerobot.teleoperators.teleoperator import Teleoperator

# deadman shared by the input-driven sources: input silent this long -> hold pose
STALE_INPUT_S = 0.5


class SourceBase(Teleoperator):
    motor_names: list[str] = []

    @property
    def action_features(self) -> dict:
        return {f"{name}.pos": float for name in self.motor_names}

    @property
    def feedback_features(self) -> dict:
        return {}

    @property
    def is_connected(self) -> bool:
        return True

    def connect(self, calibrate: bool = True) -> None:  # noqa: ARG002
        pass

    @property
    def is_calibrated(self) -> bool:
        return True

    def calibrate(self) -> None:
        pass

    def configure(self) -> None:
        pass

    def get_feedback(self) -> dict:
        return {}

    def send_feedback(self, feedback: dict) -> None:
        pass

    def disconnect(self) -> None:
        pass
