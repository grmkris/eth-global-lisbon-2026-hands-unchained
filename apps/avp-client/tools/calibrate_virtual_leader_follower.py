#!/usr/bin/env python3
"""Safely recalibrate the SO-101 follower used by the AVP gateway."""

from __future__ import annotations

import argparse
import fcntl
import select
import shutil
import sys
import termios
import time
from pathlib import Path
from typing import Any

FULL_TURN_MOTOR = "wrist_roll"
MINIMUM_RANGE_SPANS = {
    "shoulder_pan": 800,
    "shoulder_lift": 800,
    "elbow_flex": 800,
    "wrist_flex": 800,
    "gripper": 300,
}
PREVIOUS_RANGE_FRACTION = 0.70
JOINT_SWEEP_INSTRUCTIONS = {
    "shoulder_pan": "Rotate the complete arm left and right around the base.",
    "shoulder_lift": (
        "Move the upper arm through its full forward/back shoulder arc; "
        "this is motor 2 at the shoulder, not the elbow."
    ),
    "elbow_flex": "Bend and straighten the elbow through both safe endpoints.",
    "wrist_flex": "Bend the wrist hinge up and down through both safe endpoints.",
    "gripper": "Open and close the gripper fully without forcing either stop.",
}


def insufficient_range_spans(
    range_mins: dict[str, int],
    range_maxes: dict[str, int],
) -> dict[str, int]:
    return {
        motor: range_maxes[motor] - range_mins[motor]
        for motor, minimum_span in MINIMUM_RANGE_SPANS.items()
        if range_maxes[motor] - range_mins[motor] < minimum_span
    }


def required_range_spans(original_calibration: dict[str, Any]) -> dict[str, int]:
    required = dict(MINIMUM_RANGE_SPANS)
    for motor in MINIMUM_RANGE_SPANS:
        previous = original_calibration.get(motor)
        if previous is None:
            continue
        previous_span = int(previous.range_max) - int(previous.range_min)
        required[motor] = max(required[motor], int(previous_span * PREVIOUS_RANGE_FRACTION))
    return required


def backup_calibration(path: Path) -> Path | None:
    if not path.is_file():
        return None
    stamp = time.strftime("%Y%m%d-%H%M%S") + f"-{time.time_ns() % 1_000_000_000:09d}"
    backup = path.with_name(f"{path.stem}.{stamp}.backup.json")
    shutil.copy2(path, backup)
    return backup


def claim_serial_exclusive(bus: Any) -> None:
    serial_port = bus.port_handler.ser
    if serial_port is None or not serial_port.is_open:
        raise RuntimeError("Serial port was not open when requesting exclusive ownership")
    fcntl.ioctl(serial_port.fileno(), termios.TIOCEXCL)


def enter_pressed() -> bool:
    readable, _, _ = select.select([sys.stdin], [], [], 0)
    return bool(readable) and sys.stdin.readline().strip() == ""


def record_ranges_resilient(
    bus: Any,
    motors: list[str],
    *,
    maximum_failure_seconds: float = 3.0,
) -> tuple[dict[str, int], dict[str, int]]:
    positions = bus.sync_read(
        "Present_Position",
        motors,
        normalize=False,
        num_retry=5,
    )
    range_mins = {motor: int(value) for motor, value in positions.items()}
    range_maxes = dict(range_mins)
    last_success = time.monotonic()
    last_display = 0.0
    dropped_reads = 0

    while True:
        try:
            positions = bus.sync_read(
                "Present_Position",
                motors,
                normalize=False,
                num_retry=5,
            )
            last_success = time.monotonic()
        except (ConnectionError, RuntimeError) as error:
            dropped_reads += 1
            if time.monotonic() - last_success >= maximum_failure_seconds:
                raise ConnectionError(
                    "Follower communication failed continuously during calibration. "
                    "Check USB/power and stop every other process that can open the serial port."
                ) from error
            if dropped_reads == 1 or dropped_reads % 10 == 0:
                print(f"\nTransient serial read failure #{dropped_reads}; retrying…")
            time.sleep(0.05)
            continue

        for motor, value in positions.items():
            integer_value = int(value)
            range_mins[motor] = min(range_mins[motor], integer_value)
            range_maxes[motor] = max(range_maxes[motor], integer_value)

        now = time.monotonic()
        if now - last_display >= 0.2:
            summary = " | ".join(
                f"{motor}:{range_mins[motor]}/{int(positions[motor])}/{range_maxes[motor]}"
                for motor in motors
            )
            print(f"\r{summary}", end="", flush=True)
            last_display = now

        if enter_pressed():
            print()
            break
        time.sleep(0.02)

    unchanged = [motor for motor in motors if range_mins[motor] == range_maxes[motor]]
    if unchanged:
        raise ValueError("No range was recorded for: " + ", ".join(unchanged))
    return range_mins, range_maxes


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--robot-port", required=True)
    parser.add_argument("--robot-id", default="arm")
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    print("\nSO-101 FOLLOWER RECALIBRATION")
    print("Torque will be disabled; support the arm before continuing.")
    print("This records new midpoint offsets and complete mechanical ranges.")
    confirmation = input('Type "CALIBRATE" to continue: ')
    if confirmation != "CALIBRATE":
        raise SystemExit("Calibration cancelled")

    from lerobot.motors import MotorCalibration
    from lerobot.motors.feetech import OperatingMode
    from lerobot.robots.so_follower.config_so_follower import SOFollowerRobotConfig
    from lerobot.robots.so_follower.so_follower import SO101Follower

    config = SOFollowerRobotConfig(
        port=args.robot_port,
        id=args.robot_id,
        use_degrees=True,
        disable_torque_on_disconnect=True,
    )
    robot = SO101Follower(config)
    bus = robot.bus
    original_calibration = dict(robot.calibration)
    backup = backup_calibration(robot.calibration_fpath)
    succeeded = False

    print(f"Opening follower on {args.robot_port} with torque disabled…")
    bus.connect()
    try:
        claim_serial_exclusive(bus)
        bus.disable_torque()
        for motor in bus.motors:
            bus.write("Operating_Mode", motor, OperatingMode.POSITION.value)

        print("\nSTEP 1 — MIDPOINT")
        print("Move every joint, including the gripper, to the middle of its usable travel.")
        input("Keep supporting the arm, then press ENTER to record the midpoint…")
        homing_offsets = bus.set_half_turn_homings()

        sweep_motors = [motor for motor in bus.motors if motor != FULL_TURN_MOTOR]
        minimum_spans = required_range_spans(original_calibration)
        print("\nSTEP 2 — COMPLETE RANGE SWEEP")
        print("Each joint is now recorded and checked separately.")
        print(f"Do not sweep {FULL_TURN_MOTOR}; it uses its full encoder turn.")
        range_mins: dict[str, int] = {}
        range_maxes: dict[str, int] = {}

        for index, motor in enumerate(sweep_motors, start=1):
            required_span = minimum_spans[motor]
            while True:
                print(f"\nJOINT {index}/{len(sweep_motors)} — {motor}")
                print(JOINT_SWEEP_INSTRUCTIONS[motor])
                print(
                    f"Move to both endpoints at least once; required recorded span: "
                    f"{required_span} ticks. Press ENTER when complete."
                )
                try:
                    joint_mins, joint_maxes = record_ranges_resilient(bus, [motor])
                except ValueError as error:
                    print(f"Incomplete {motor} sweep: {error}")
                    retry = input(
                        'Type "RETRY" to record this joint again, or anything else to abort: '
                    )
                    if retry == "RETRY":
                        continue
                    raise RuntimeError(
                        f"Calibration stopped at incomplete joint {motor}; "
                        "old calibration will be restored"
                    ) from error

                observed_min = min(range_mins.get(motor, joint_mins[motor]), joint_mins[motor])
                observed_max = max(range_maxes.get(motor, joint_maxes[motor]), joint_maxes[motor])
                range_mins[motor] = observed_min
                range_maxes[motor] = observed_max
                observed_span = observed_max - observed_min
                if observed_span >= required_span:
                    print(f"Accepted {motor}: span {observed_span} ticks.")
                    break

                print(
                    f"Incomplete {motor} sweep: span {observed_span}, "
                    f"required at least {required_span} ticks."
                )
                retry = input(
                    'Type "RETRY" to continue recording this joint, or anything else to abort: '
                )
                if retry != "RETRY":
                    raise RuntimeError(
                        f"Calibration stopped at incomplete joint {motor}; "
                        "old calibration will be restored"
                    )

        range_mins[FULL_TURN_MOTOR] = 0
        range_maxes[FULL_TURN_MOTOR] = 4095

        print("\nRecorded encoder ranges:")
        for motor in bus.motors:
            print(
                f"  {motor:16} {range_mins[motor]:5} … {range_maxes[motor]:5} "
                f"(span {range_maxes[motor] - range_mins[motor]})"
            )

        print("\nSTEP 3 — SAFE STARTING POSE")
        print("Move the follower back to a supported central pose, clear the workspace,")
        save_confirmation = input('then type "SAVE" to write and verify this calibration: ')
        if save_confirmation != "SAVE":
            raise RuntimeError("Calibration was not saved; old calibration will be restored")

        calibration: dict[str, Any] = {}
        for motor, motor_definition in bus.motors.items():
            calibration[motor] = MotorCalibration(
                id=motor_definition.id,
                drive_mode=0,
                homing_offset=int(homing_offsets[motor]),
                range_min=int(range_mins[motor]),
                range_max=int(range_maxes[motor]),
            )

        bus.write_calibration(calibration)
        if not bus.is_calibrated:
            raise RuntimeError("New calibration did not verify against the motor EEPROM")

        robot.calibration = calibration
        robot._save_calibration()
        succeeded = True
        print(f"\nCalibration saved and verified: {robot.calibration_fpath}")
        if backup is not None:
            print(f"Previous calibration backup: {backup}")
    except BaseException:
        if original_calibration:
            print("Restoring the previous calibration to the motors…")
            try:
                bus.disable_torque()
                bus.write_calibration(original_calibration)
                robot.calibration = original_calibration
                if backup is not None:
                    shutil.copy2(backup, robot.calibration_fpath)
            except Exception as restore_error:
                print(
                    f"WARNING: automatic calibration restore failed: {restore_error}",
                    file=sys.stderr,
                )
        raise
    finally:
        if bus.is_connected:
            bus.disconnect(disable_torque=True)

    if not succeeded:
        return 1
    print("Torque remains disabled. The gateway may now be started from a safe pose.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
