"""Shared record session — ported from LeLab's record_with_web_events skeleton,
but with lerobot-CLI episode semantics: timeout SAVES the episode (right-arrow
equivalent = `keep` ends early and saves; `rerecord` redoes the current one).

Works over any (robot, teleop) pair: real lerobot devices or the sim's ducks
(the teleop MUST be a genuine Teleoperator subclass — record_loop isinstance-checks it).
"""

from shared import emit, log


def make_events() -> dict:
    return {"exit_early": False, "rerecord_episode": False, "stop_recording": False}


def run_session(robot, teleop, cfg: dict, events: dict, on_episode_start=None) -> int:
    from lerobot.datasets import LeRobotDataset
    from lerobot.processor import make_default_processors
    from lerobot.scripts.lerobot_record import record_loop
    from lerobot.utils.feature_utils import hw_to_dataset_features

    tap, rap, rop = make_default_processors()
    action_features = hw_to_dataset_features(robot.action_features, "action", True)
    obs_features = hw_to_dataset_features(robot.observation_features, "observation", True)
    features = {**action_features, **obs_features}
    n_cams = len(getattr(robot, "cameras", {}) or {})

    def state(phase: str, ep: int, saved: int) -> None:
        emit({
            "event": "record_state",
            "phase": phase,
            "episode": ep,
            "saved": saved,
            "total": cfg["num_episodes"],
            "repoId": cfg["repo_id"],
            "source": cfg.get("source"),
        })

    if cfg.get("resume"):
        dataset = LeRobotDataset.resume(
            cfg["repo_id"],
            root=cfg.get("root"),
            image_writer_processes=0,
            image_writer_threads=4 * n_cams if n_cams else 0,
        )
    else:
        dataset = LeRobotDataset.create(
            cfg["repo_id"],
            cfg["fps"],
            robot_type=robot.name,
            features=features,
            use_videos=True,
            image_writer_processes=0,
            image_writer_threads=4 * n_cams if n_cams else 0,
        )

    robot.connect()
    if teleop is not None:
        teleop.connect()
    # crib LeLab: push calibration into motor memory when real hardware
    if hasattr(robot, "bus") and getattr(robot, "calibration", None) is not None:
        robot.bus.write_calibration(robot.calibration)
    if teleop is not None and hasattr(teleop, "bus") and getattr(teleop, "calibration", None) is not None:
        teleop.bus.write_calibration(teleop.calibration)

    saved, ep = 0, 1
    failed: str | None = None
    common = dict(
        robot=robot,
        events=events,
        fps=cfg["fps"],
        teleop_action_processor=tap,
        robot_action_processor=rap,
        robot_observation_processor=rop,
        teleop=teleop,
        single_task=cfg["task"],
        display_data=False,
    )
    try:
        while saved < cfg["num_episodes"]:
            if on_episode_start is not None:
                on_episode_start()
            state("recording", ep, saved)
            events["exit_early"] = False
            record_loop(dataset=dataset, control_time_s=cfg["episode_time_s"], **common)

            if events.get("rerecord_episode"):
                events["rerecord_episode"] = False
                events["exit_early"] = False
                dataset.clear_episode_buffer()
                state("resetting", ep, saved)
                record_loop(control_time_s=cfg["reset_time_s"], **common)
                if events.get("stop_recording"):
                    break
                continue

            dataset.save_episode()
            saved += 1
            emit({"event": "episode_saved", "index": saved - 1, "repoId": cfg["repo_id"]})
            ep += 1
            if events.get("stop_recording") or saved >= cfg["num_episodes"]:
                break

            state("resetting", ep, saved)
            events["exit_early"] = False
            record_loop(control_time_s=cfg["reset_time_s"], **common)
            if events.get("stop_recording"):
                break
    except Exception as exc:  # noqa: BLE001 — recorder owns the terminal record_state
        failed = str(exc)
        emit({"event": "error", "where": "record", "error": failed})
        raise
    finally:
        for device, tag in ((robot, "robot"), (teleop, "teleop")):
            if device is None:
                continue
            try:
                device.disconnect()
            except Exception as exc:  # noqa: BLE001
                log(f"recorder {tag} disconnect: {exc}")
        state("failed" if failed else "done", ep, saved)
    return saved
