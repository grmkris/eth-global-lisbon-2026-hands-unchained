#!/usr/bin/env python
"""Lab Console robot driver.

Protocol: ndjson-RPC over stdio. stdout carries ONLY protocol lines
(responses + events); logging goes to stderr. Frames are served over a
localhost MJPEG HTTP port.

Backends: `connect {"backend": "real" | "sim"}` picks who answers the robot
commands — real (serial + OpenCV + lerobot) or sim (MuJoCo). The console never
knows the difference.

Commands:
  hello, list_cameras, preview_start/preview_stop         (real cameras)
  connect {backend, followerPort, leaderPort, robotId}, disconnect
  torque {on}, estop, teleop_start, teleop_stop, get_joints
  record_start {repo_id, task, num_episodes, episode_time_s, reset_time_s,
                fps, resume, cameras}                     (needs connect first)
  record_control {action: keep | rerecord | finish}
  dataset_push {repo_id, private}, dataset_push_status    (publish to HF Hub)

Events: ready, brightness, joints, robot_state, record_state, episode_saved,
        push_state, error.
"""

import argparse
import shutil
import sys
import tempfile
import threading
import time
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import cv2

import recorder
import teleop_loop
from shared import BRIGHTNESS, FRAMES, LOCK, PREVIEW_QUALITY, PREVIEW_WIDTH, emit, log

BACKEND = None  # RealBackend | SimBackend | None
RECORDING: dict = {"events": None, "thread": None}
STOP_FLAGS: list[threading.Event] = []
# What cmd_preview_start last started. A record session STEALS the camera
# devices (macOS: one owner per device) and only this remembers what was
# streaming, so the worker can put the previews back when it is done.
PREVIEW_SPECS: list[dict] = []
# Names whose LAST frame survives stop_previews(). The recorder needs a second
# or two to open the devices; without this the 1 Hz status event reports an
# empty stream list inside that window and every panel in the browser unmounts
# and comes back.
KEEP_FRAMES: set[str] = set()


# ---------- camera preview (real cameras; sim feeds FRAMES itself) ----------

def capture_loop(name: str, index: int, width: int, height: int, fps: int, stop: threading.Event) -> None:
    cap = cv2.VideoCapture(index)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
    cap.set(cv2.CAP_PROP_FPS, fps)
    log(f"capture {name} (index {index}) started")
    n = 0
    while not stop.is_set():
        ok, frame = cap.read()
        if not ok:
            time.sleep(0.1)
            continue
        n += 1
        if n % 15 == 0:
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            with LOCK:
                BRIGHTNESS[name] = round(float(gray.mean()), 1)
        if PREVIEW_WIDTH and frame.shape[1] > PREVIEW_WIDTH:
            scale = PREVIEW_WIDTH / frame.shape[1]
            frame = cv2.resize(
                frame, (PREVIEW_WIDTH, max(1, round(frame.shape[0] * scale)))
            )
        ok2, jpg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, PREVIEW_QUALITY])
        if ok2:
            with LOCK:
                FRAMES[name] = jpg.tobytes()
    cap.release()
    if name not in KEEP_FRAMES:  # a handover keeps the last frame on screen
        with LOCK:
            FRAMES.pop(name, None)
            BRIGHTNESS.pop(name, None)
    log(f"capture {name} stopped")


def stop_previews(keep: set[str] | None = None) -> None:
    """Release every capture device. `keep` names whose last frame stays put —
    the ones something else is about to take over (the record tee)."""
    # stays set until the NEXT stop_previews: a capture thread can sit in a
    # blocking cap.read() well past the sleep below, and its cleanup must still
    # see the flag
    KEEP_FRAMES.clear()
    KEEP_FRAMES.update(keep or ())
    for flag in STOP_FLAGS:
        flag.set()
    STOP_FLAGS.clear()
    time.sleep(0.2)


# macOS exposes phantom camera slots that open and read fine but return pure
# black. A real camera in a dark room still reads well above this.
BLACK_FRAME_MEAN = 2.0


def cmd_list_cameras() -> list[dict]:
    stop_previews()  # macOS: one owner per device
    found = []
    for idx in range(6):
        cap = cv2.VideoCapture(idx)
        if cap.isOpened():
            for _ in range(5):  # first frames can be blank while the device wakes
                ok, frame = cap.read()
                if ok and float(frame.mean()) > BLACK_FRAME_MEAN:
                    break
            if ok and float(frame.mean()) > BLACK_FRAME_MEAN:
                h, w = frame.shape[:2]
                found.append({"index": idx, "width": w, "height": h})
            elif ok:
                log(f"camera {idx} ignored — returns black frames (phantom device)")
        cap.release()
    return found


def cmd_preview_start(cameras: list[dict]) -> dict:
    stop_previews()
    started = []
    for cam in cameras:
        stop = threading.Event()
        STOP_FLAGS.append(stop)
        threading.Thread(
            target=capture_loop,
            args=(cam["name"], cam["index"], cam.get("width", 640),
                  cam.get("height", 480), cam.get("fps", 30), stop),
            daemon=True,
        ).start()
        started.append(cam["name"])
    PREVIEW_SPECS[:] = [dict(cam) for cam in cameras]
    return {"started": started}


# ---------- record tee: previews that survive a recording ----------
#
# The recorder takes the camera devices away from the capture loops, but it
# READS every frame — so the video does not have to go dark for the person
# driving the episode. The tap publishes those frames back into FRAMES under
# the SAME cam<index> names, which is the part that matters: `streams` never
# changes, so the rig's advertised `cams` never changes, and the browser <img>
# is not even remounted. It just keeps playing.
#
# Split in two on purpose. The tap runs INSIDE lerobot's 30 Hz control loop,
# so it does the cheap half only (a clock check and a copy); the encoder thread
# does colour conversion and JPEG off-loop, dropping whatever it cannot keep up
# with. A tee that stole loop time would show up as dropped control frames in
# the dataset — the exact thing we are recording.

TEE_MIN_INTERVAL_S = 0.1  # ~10 fps is plenty for watching; recording is 30
TEE = {
    "names": {},        # lerobot cam key -> preview name (cam<index>)
    "mailbox": {},      # preview name -> newest RGB frame not yet encoded
    "last": {},         # preview name -> when we last took one
    "wake": threading.Event(),
    "stop": threading.Event(),
    "thread": None,
    "n": 0,
}


def tee_observation(obs: dict) -> None:
    """Called per control tick by recorder.run_session. Must never raise."""
    try:
        now = time.monotonic()
        for cam_key, name in TEE["names"].items():
            frame = obs.get(cam_key)
            if frame is None:
                continue
            if now - TEE["last"].get(name, 0.0) < TEE_MIN_INTERVAL_S:
                continue
            TEE["last"][name] = now
            TEE["mailbox"][name] = frame.copy()  # latest-wins, single slot
        TEE["wake"].set()
    except Exception as exc:  # noqa: BLE001 — a dead preview beats a dead recording
        log(f"record tee: {exc}")


def _tee_loop() -> None:
    while not TEE["stop"].is_set():
        TEE["wake"].wait(0.5)
        TEE["wake"].clear()
        for name in list(TEE["mailbox"].keys()):
            rgb = TEE["mailbox"].pop(name, None)
            if rgb is None:
                continue
            try:
                frame = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)  # lerobot hands back RGB
                if PREVIEW_WIDTH and frame.shape[1] > PREVIEW_WIDTH:
                    scale = PREVIEW_WIDTH / frame.shape[1]
                    frame = cv2.resize(
                        frame, (PREVIEW_WIDTH, max(1, round(frame.shape[0] * scale)))
                    )
                ok, jpg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, PREVIEW_QUALITY])
                if not ok:
                    continue
                with LOCK:
                    FRAMES[name] = jpg.tobytes()
                    if TEE["n"] % 15 == 0:
                        BRIGHTNESS[name] = round(
                            float(cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY).mean()), 1
                        )
                TEE["n"] += 1
            except Exception as exc:  # noqa: BLE001
                log(f"record tee encode {name}: {exc}")


def start_tee(names: dict) -> None:
    TEE["names"] = dict(names)
    TEE["mailbox"].clear()
    TEE["last"].clear()
    if not names:
        return  # sim renders its own frames — nothing to tee
    TEE["stop"].clear()
    TEE["thread"] = threading.Thread(target=_tee_loop, name="record-tee", daemon=True)
    TEE["thread"].start()
    log(f"record tee: {', '.join(f'{k}->{v}' for k, v in names.items())}")


def stop_tee() -> set[str]:
    """Stop teeing and answer which preview names it was feeding."""
    fed = set(TEE["names"].values())
    TEE["names"] = {}
    TEE["stop"].set()
    TEE["wake"].set()
    TEE["thread"] = None
    return fed


# ---------- MJPEG ----------

class MJPEGHandler(BaseHTTPRequestHandler):
    def log_message(self, *args) -> None:
        pass

    def do_GET(self) -> None:
        # single frame — what the hub link pushes upstream (multipart is for the
        # local <img>; parsing it back apart on the TS side would be silly)
        if self.path.startswith("/snap/"):
            name = self.path.rsplit("/", 1)[-1]
            with LOCK:
                data = FRAMES.get(name)
            if not data:
                self.send_response(404)
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        if self.path.startswith("/cam/"):
            name = self.path.rsplit("/", 1)[-1]
            self.send_response(200)
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            try:
                while True:
                    with LOCK:
                        data = FRAMES.get(name)
                    if data:
                        self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + data + b"\r\n")
                    time.sleep(1 / 15)
            except (BrokenPipeError, ConnectionResetError):
                return
        else:
            self.send_response(404)
            self.end_headers()


# ---------- robot dispatch ----------

def require_backend():
    if BACKEND is None:
        raise ValueError("not connected — connect first")
    return BACKEND


def cmd_connect(req: dict) -> dict:
    global BACKEND
    if BACKEND is not None:
        raise ValueError("already connected — disconnect first")
    if req.get("backend") == "sim":
        from backends.sim import SimBackend

        BACKEND = SimBackend()
        return {**BACKEND.connect(req), "backend": "sim"}
    from backends.real import RealBackend

    backend = RealBackend()
    result = backend.connect(req)  # raises with a friendly hint on failure
    BACKEND = backend
    return {**result, "backend": "real"}


def cmd_disconnect() -> dict:
    global BACKEND
    teleop_loop.stop(wait=True)
    if BACKEND is None:
        return {"state": "disconnected"}
    result = BACKEND.disconnect()
    BACKEND = None
    return result


def cmd_record_start(req: dict) -> dict:
    if RECORDING["thread"] is not None and RECORDING["thread"].is_alive():
        raise ValueError("recording already active")
    backend = require_backend()
    teleop_loop.stop(wait=True)  # recorder owns the arm — a live teleop loop must end first
    resume_previews = [dict(cam) for cam in PREVIEW_SPECS]  # put these back afterwards

    cfg = {
        "repo_id": req["repo_id"],
        "task": req["task"],
        "num_episodes": int(req.get("num_episodes", 5)),
        "episode_time_s": float(req.get("episode_time_s", 20)),
        "reset_time_s": float(req.get("reset_time_s", 10)),
        "fps": int(req.get("fps", 30)),
        "resume": bool(req.get("resume", False)),
        "cameras": req.get("cameras") or {},
        "source": req.get("source") or ("scripted" if backend.name == "sim" else "leader"),
    }
    # The recorder's cameras carry the same indexes the previews were opened
    # with, so each one maps back onto the cam<index> stream the browser is
    # already watching. Sim passes cameras: {} — it renders its own frames and
    # this whole path stays inert there.
    previewed = {cam["name"] for cam in resume_previews}
    tee_names = {
        cam_key: f"cam{spec['index']}"
        for cam_key, spec in cfg["cameras"].items()
        if f"cam{spec['index']}" in previewed
    }
    # Only the tee'd names keep their last frame; a camera nobody takes over
    # (an unmapped cam2) is genuinely closed and must not sit there frozen.
    stop_previews(keep=set(tee_names.values()))

    # Everything from here to the worker thread runs with the previews already
    # down: if it raises, the worker's finally never happens, and the cameras
    # would stay dark until someone clicked Probe + preview.
    try:
        robot, teleop_device, on_episode_start = backend.prepare_record(cfg)
        start_tee(tee_names)
    except Exception:
        stop_tee()
        # the frames stop_previews kept for the handover that never happened
        for name in tee_names.values():
            with LOCK:
                FRAMES.pop(name, None)
        if resume_previews:
            try:
                cmd_preview_start(resume_previews)
            except Exception as exc:  # noqa: BLE001 — report the ORIGINAL failure
                log(f"preview restore after failed record start: {exc}")
        raise

    events = recorder.make_events()
    if hasattr(teleop_device, "set_input") or hasattr(teleop_device, "set_joints"):
        teleop_loop.set_record_source(teleop_device)  # teleop_input RPC reaches the recording source

    def worker() -> None:
        try:
            saved = recorder.run_session(
                robot, teleop_device, cfg, events, on_episode_start,
                observation_tap=tee_observation if tee_names else None,
            )
            log(f"record session done, saved={saved}")
        except Exception as exc:  # noqa: BLE001 — recorder already emitted the failed state
            log(f"record session failed: {exc}")
        finally:
            teleop_loop.set_record_source(None)
            # stop teeing BEFORE the restart, so a frame still in flight cannot
            # land on top of a fresh preview
            teed = stop_tee()
            # after_record puts the ARM back (see real.py); this puts the CAMERAS
            # back. Without it a real rig's feeds stay dark for everyone after the
            # first attempt — recorder.run_session has already released the
            # devices in its own finally, so re-opening here is safe.
            backend.after_record()
            if resume_previews:
                try:
                    time.sleep(0.5)  # macOS: let the recorder's handles close first
                    cmd_preview_start(resume_previews)
                except Exception as exc:  # noqa: BLE001 — a replugged camera must
                    log(f"preview restore failed: {exc}")  # not poison the session
                    # the tee's last frames would otherwise sit there as a still
                    # image nobody could tell was stale
                    for name in teed:
                        with LOCK:
                            FRAMES.pop(name, None)

    RECORDING["events"] = events
    RECORDING["thread"] = threading.Thread(target=worker, name="record-session", daemon=True)
    RECORDING["thread"].start()
    return {"started": True, "repo_id": cfg["repo_id"], "source": cfg["source"]}


def cmd_record_control(action: str) -> dict:
    events = RECORDING.get("events")
    if events is None or RECORDING["thread"] is None or not RECORDING["thread"].is_alive():
        raise ValueError("no active recording")
    if action == "keep":
        events["exit_early"] = True
    elif action == "rerecord":
        events["rerecord_episode"] = True
        events["exit_early"] = True
    elif action == "finish":
        events["stop_recording"] = True
        events["exit_early"] = True
    elif action == "discard":
        # end the session WITHOUT saving the in-flight episode: the rerecord
        # flag clears the buffer, stop ends the session before the reset pass
        events["rerecord_episode"] = True
        events["stop_recording"] = True
        events["exit_early"] = True
    else:
        raise ValueError(f"unknown record action: {action}")
    return {"action": action}


# ---------- dataset publish ----------
# The dataset lives HERE, on the rig owner's machine, and so does the HF token.
# The hub never sees either — it only relays the owner's "push" verb. Runs on a
# worker thread and reports through events for the same reason record_start
# does: a 26MB upload blows the console's 30s RPC timeout.

PUSHING: dict = {"thread": None, "state": {"phase": "idle", "repoId": None, "url": None, "error": None}}


def push_state(phase: str, repo_id: str, url: str | None = None, error: str | None = None) -> None:
    PUSHING["state"] = {"phase": phase, "repoId": repo_id, "url": url, "error": error}
    emit({"event": "push_state", **PUSHING["state"]})


def cmd_dataset_push(req: dict) -> dict:
    repo_id = req.get("repo_id") or ""
    if not repo_id:
        raise ValueError("repo_id required")
    # Episodes the referee failed. The hub derives these from its verdicts; an
    # empty list (or a hub with no market layer) means publish everything.
    exclude = sorted({int(i) for i in (req.get("exclude_episodes") or [])})
    if PUSHING["thread"] is not None and PUSHING["thread"].is_alive():
        raise ValueError("a dataset push is already running")
    # Uploading a dataset that the recorder is still writing into would ship a
    # half-written episode — refuse rather than publish a corrupt snapshot.
    if RECORDING["thread"] is not None and RECORDING["thread"].is_alive():
        raise ValueError("recording active — finish the session before publishing")

    def worker() -> None:
        try:
            push_state("uploading", repo_id)
            from lerobot.datasets import LeRobotDataset
            from lerobot.utils.constants import HF_LEROBOT_HOME

            root = HF_LEROBOT_HOME / repo_id
            if not root.exists():
                raise ValueError(f"no local dataset at {root} — record an episode first")
            dataset = LeRobotDataset(repo_id, root=str(root))

            # THE REFEREE GATES THE DATA. push_to_hub uploads a whole folder and
            # has no notion of an episode subset — and could not have one, since
            # a v3 dataset packs many episodes into a single parquet file. So we
            # build a filtered COPY first: delete_episodes rewrites the parquet,
            # re-encodes any video segment that mixed kept and dropped episodes,
            # and recomputes the stats, leaving a dataset consistent with its own
            # metadata. The recording on disk is never touched.
            if exclude:
                from lerobot.datasets.dataset_tools import delete_episodes

                keep = dataset.meta.total_episodes - len(exclude)
                if keep <= 0:
                    raise ValueError(
                        f"nothing to publish — all {dataset.meta.total_episodes} "
                        "episodes failed the referee"
                    )
                push_state("filtering", repo_id)
                log(f"excluding {len(exclude)} failed episode(s) from {repo_id}: {exclude}")
                # A TEMP dir, deliberately not a sibling of the source: the
                # dataset catalog scans ~/.cache/huggingface/lerobot/<user>/*
                # and would list the staging copy as a second, phantom dataset.
                staged = Path(tempfile.mkdtemp(prefix="poh-publish-"))
                staged_root = staged / "dataset"
                try:
                    dataset = delete_episodes(
                        dataset,
                        episode_indices=exclude,
                        output_dir=staged_root,
                        repo_id=repo_id,
                    )
                    push_state("uploading", repo_id)
                    log(f"pushing {repo_id} ({dataset.meta.total_episodes} episodes) to the Hub")
                    dataset.push_to_hub(
                        private=bool(req.get("private", False)),
                        tags=["robotics", "so101", "teleoperation", "proof-of-hands"],
                    )
                finally:
                    shutil.rmtree(staged, ignore_errors=True)
                push_state(
                    "done", repo_id, url=f"https://huggingface.co/datasets/{repo_id}"
                )
                log(f"pushed {repo_id} without {len(exclude)} rejected episode(s)")
                return

            log(f"pushing {repo_id} ({dataset.meta.total_episodes} episodes) to the Hub")
            dataset.push_to_hub(
                private=bool(req.get("private", False)),
                tags=["robotics", "so101", "teleoperation", "proof-of-hands"],
            )
            push_state("done", repo_id, url=f"https://huggingface.co/datasets/{repo_id}")
            log(f"pushed {repo_id}")
        except Exception as exc:  # noqa: BLE001 — surfaced to the owner via push_state
            # HF's auth failures are long and multi-line; keep the first line,
            # which is the part that tells the owner what to fix.
            message = str(exc).strip().splitlines()[0][:300] if str(exc).strip() else repr(exc)
            push_state("failed", repo_id, error=message)
            log(f"push failed for {repo_id}: {message}")

    PUSHING["thread"] = threading.Thread(target=worker, name="dataset-push", daemon=True)
    PUSHING["thread"].start()
    return {"started": True, "repoId": repo_id}


# ---------- housekeeping threads ----------

def status_reporter() -> None:
    """1 Hz: brightness per stream + which streams are live (= FRAMES keys)."""
    while True:
        time.sleep(1)
        with LOCK:
            brightness = dict(BRIGHTNESS)
            streams = sorted(FRAMES.keys())
        emit({"event": "status", "brightness": brightness, "streams": streams})


def orphan_watchdog() -> None:
    import os

    while True:
        time.sleep(2)
        if os.getppid() == 1:
            log("orphaned (parent died), exiting")
            os._exit(0)


def main() -> None:
    import json

    # protocol stream already captured by shared._PROTO; stray print()s -> stderr
    sys.stdout = sys.stderr

    parser = argparse.ArgumentParser()
    # 0 = let the OS pick a free port; the real one goes back in `ready`, so
    # several rigs can share a machine with nothing to configure
    parser.add_argument("--mjpeg-port", type=int, default=0)
    args = parser.parse_args()

    server = ThreadingHTTPServer(("127.0.0.1", args.mjpeg_port), MJPEGHandler)
    mjpeg_port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    threading.Thread(target=status_reporter, daemon=True).start()
    threading.Thread(target=orphan_watchdog, daemon=True).start()

    emit({"event": "ready", "mjpegPort": mjpeg_port})
    log(f"ready, mjpeg on :{mjpeg_port}")

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            emit({"id": None, "ok": False, "error": "bad json"})
            continue
        rid, cmd = req.get("id"), req.get("cmd")
        try:
            if cmd == "hello":
                result = {"driver": "lab-console", "version": "0.2.0"}
            elif cmd == "list_cameras":
                result = cmd_list_cameras()
            elif cmd == "preview_start":
                result = cmd_preview_start(req.get("cameras", []))
            elif cmd == "preview_stop":
                stop_previews()
                PREVIEW_SPECS.clear()  # deliberate stop: don't resurrect after a record
                result = {"stopped": True}
            elif cmd == "connect":
                result = cmd_connect(req)
            elif cmd == "disconnect":
                result = cmd_disconnect()
            elif cmd == "torque":
                result = require_backend().torque(bool(req.get("on")))
            elif cmd == "estop":
                # E-STOP is the one control the UI shows unconditionally, to
                # everyone, lease or not — so it must never answer "not
                # connected — connect first". Stopping the teleop loop IS the
                # stop when there is no backend to kill torque on.
                teleop_loop.stop()
                result = BACKEND.estop() if BACKEND is not None else {"estopped": True}
            elif cmd == "teleop_start":
                result = teleop_loop.start(
                    req,
                    require_backend(),
                    RECORDING["thread"] is not None and RECORDING["thread"].is_alive(),
                )
            elif cmd == "teleop_stop":
                result = teleop_loop.stop()
            elif cmd == "teleop_input":
                result = teleop_loop.set_input(req)
            elif cmd == "get_joints":
                result = require_backend().get_joints()
            elif cmd == "record_start":
                result = cmd_record_start(req)
            elif cmd == "record_control":
                result = cmd_record_control(req.get("action", ""))
            elif cmd == "dataset_push":
                result = cmd_dataset_push(req)
            elif cmd == "dataset_push_status":
                result = PUSHING["state"]
            else:
                raise ValueError(f"unknown cmd: {cmd}")
            emit({"id": rid, "ok": True, "result": result})
        except Exception as exc:  # noqa: BLE001 — protocol boundary
            emit({"id": rid, "ok": False, "error": str(exc)})

    stop_previews()
    log("stdin closed, exiting")


if __name__ == "__main__":
    main()
