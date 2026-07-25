"""Shared lerobot EE->joints chain for input-driven sources (keys, phone).

One assembly of lerobot's own processors: EEReferenceAndDelta ->
EEBoundsAndSafety -> GripperVelocityToJoint -> InverseKinematicsEEToJoints
(Placo IK). The URDF is the standard SO-101 calib model shipped in this repo
(lerobot itself ships none).
"""

from pathlib import Path

from lerobot.model.kinematics import RobotKinematics
from lerobot.processor import (
    RobotProcessorPipeline,
    robot_action_observation_to_transition,
    transition_to_robot_action,
)
from lerobot.robots.so_follower.robot_kinematic_processor import (
    EEBoundsAndSafety,
    EEReferenceAndDelta,
    GripperVelocityToJoint,
    InverseKinematicsEEToJoints,
)
from lerobot.types import RobotAction, RobotObservation

# Vendored in-repo (meshes beside it) — the driver is self-contained.
URDF_PATH = str(
    (Path(__file__).parent.parent / "assets/so101_urdf/so101_new_calib.urdf").resolve()
)


def build_ee_pipeline(
    motor_names: list[str],
    step_size_m: float = 0.0025,
    gripper_speed: float = 30.0,
    use_latched_reference: bool = False,
    front_steps: tuple = (),
) -> RobotProcessorPipeline:
    kinematics = RobotKinematics(
        urdf_path=URDF_PATH,
        target_frame_name="gripper_frame_link",
        joint_names=motor_names,
    )
    return RobotProcessorPipeline[tuple[RobotAction, RobotObservation], RobotAction](
        steps=[
            *front_steps,
            EEReferenceAndDelta(
                kinematics=kinematics,
                end_effector_step_sizes={"x": step_size_m, "y": step_size_m, "z": step_size_m},
                motor_names=motor_names,
                use_latched_reference=use_latched_reference,
            ),
            EEBoundsAndSafety(
                end_effector_bounds={"min": [-0.5, -0.5, -0.1], "max": [0.5, 0.5, 0.5]},
                max_ee_step_m=0.08,
                # Clamp an over-limit step instead of aborting the teleop loop.
                # lerobot computes the clamped position either way, so the safety
                # envelope is identical — raise_on_jump only decides whether a
                # transient IK glitch kills the session. It does, and a remote
                # operator then just sees the arm stop with no explanation.
                raise_on_jump=False,
            ),
            GripperVelocityToJoint(speed_factor=gripper_speed),
            InverseKinematicsEEToJoints(
                kinematics=kinematics,
                motor_names=motor_names,
                initial_guess_current_joints=True,
            ),
        ],
        to_transition=robot_action_observation_to_transition,
        to_output=transition_to_robot_action,
    )


def make_input_source(name: str, motor_names: list[str], seed_obs: dict[str, float]):
    """Registry for sources that take external input (browser RPC, phone,
    a remote leader arm over the hub).

    Works for both live teleop and record sessions — every source is a
    lerobot Teleoperator, so record_loop accepts it unchanged. `remote` matters
    for RECORDING: an operator whose task attempt is driven by a bound leader
    agent keeps that source through the record session (driver.py routes the
    teleop_input RPC to the record source via set_joints).
    """
    if name == "keys":
        from sources.keys import BrowserKeys

        return BrowserKeys(motor_names=motor_names, seed_obs=seed_obs)
    if name == "phone":
        from sources.phone import PhoneSource

        return PhoneSource(motor_names=motor_names, seed_obs=seed_obs)
    if name == "remote":
        from sources.remote import RemoteJoints

        return RemoteJoints(motor_names=motor_names, seed_obs=seed_obs)
    raise ValueError(f"unknown input source: {name}")
