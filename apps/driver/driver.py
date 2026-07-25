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

Events: ready, brightness, joints, robot_state, record_state, episode_saved, error.
"""

import argparse
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import cv2

import recorder
import teleop_loop
from shared import BRIGHTNESS, FRAMES, LOCK, emit, log

BACKEND = None  # RealBackend | SimBackend | None
RECORDING: dict = {"events": None, "thread": None}
STOP_FLAGS: list[threading.Event] = []


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
        ok2, jpg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
        if ok2:
            with LOCK:
                FRAMES[name] = jpg.tobytes()
    cap.release()
    with LOCK:
        FRAMES.pop(name, None)
        BRIGHTNESS.pop(name, None)
    log(f"capture {name} stopped")


def stop_previews() -> None:
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
    return {"started": started}


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
    stop_previews()  # recorder owns the cameras (real backend)

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
    robot, teleop_device, on_episode_start = backend.prepare_record(cfg)
    events = recorder.make_events()
    if hasattr(teleop_device, "set_input"):
        teleop_loop.set_record_source(teleop_device)  # teleop_input RPC reaches the recording source

    def worker() -> None:
        try:
            saved = recorder.run_session(robot, teleop_device, cfg, events, on_episode_start)
            log(f"record session done, saved={saved}")
        except Exception as exc:  # noqa: BLE001 — recorder already emitted the failed state
            log(f"record session failed: {exc}")
        finally:
            teleop_loop.set_record_source(None)
            backend.after_record()

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
    else:
        raise ValueError(f"unknown record action: {action}")
    return {"action": action}


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
                result = {"stopped": True}
            elif cmd == "connect":
                result = cmd_connect(req)
            elif cmd == "disconnect":
                result = cmd_disconnect()
            elif cmd == "torque":
                result = require_backend().torque(bool(req.get("on")))
            elif cmd == "estop":
                teleop_loop.stop()
                result = require_backend().estop()
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
            else:
                raise ValueError(f"unknown cmd: {cmd}")
            emit({"id": rid, "ok": True, "result": result})
        except Exception as exc:  # noqa: BLE001 — protocol boundary
            emit({"id": rid, "ok": False, "error": str(exc)})

    stop_previews()
    log("stdin closed, exiting")


if __name__ == "__main__":
    main()
