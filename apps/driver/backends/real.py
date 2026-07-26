"""Real backend — serial SO-101 arms + OpenCV cameras via lerobot 0.6.0.
Connect/teleop structure cribbed from LeLab's teleoperate.py (worker owns disconnect).
"""


from ports import resolve_follower
from shared import emit, log


class RealBackend:
    name = "real"

    def __init__(self) -> None:
        self.robot = None
        self.teleop = None
        self.state = "disconnected"
        self._ports: dict = {}
        # Cameras are attached only for a recording session; the already
        # connected follower and optional leader remain the serial owners.
        self._record_cameras: dict = {}

    # ---------- lifecycle ----------

    def _emit_state(self) -> None:
        # `leader` rides EVERY transition, not just the connect reply: attaching is
        # best-effort (unplugged arm, port held by a leader agent), and the flag
        # goes stale on disconnect/after_record. The UI hides "drive with the rig's
        # own leader arm" on this, so a stale true = a button that fails.
        emit({
            "event": "robot_state",
            "state": self.state,
            "backend": self.name,
            "leader": self.teleop is not None,
        })

    @staticmethod
    def _safe_disconnect(device) -> None:
        if device is None:
            return
        try:
            device.disconnect()
        except Exception as exc:  # noqa: BLE001
            log(f"disconnect error (ignored): {exc}")

    def connect(self, req: dict) -> dict:
        if self.state != "disconnected":
            raise ValueError(f"already {self.state} — disconnect first")

        from lerobot.robots.so_follower import SO101Follower, SO101FollowerConfig
        from lerobot.teleoperators.so_leader import SO101Leader, SO101LeaderConfig

        robot_id = req.get("robotId", "arm")
        # None -> auto-detect (exactly one serial device); raises friendly text
        follower_port = resolve_follower(req.get("followerPort"))
        if not req.get("followerPort"):
            log(f"real: follower on {follower_port} (auto-detected)")
        # store the RESOLVED port — prepare_record reads _ports later
        self._ports = {
            "followerPort": follower_port,
            "leaderPort": req.get("leaderPort"),
            "robotId": robot_id,
        }
        robot = None
        teleop = None
        try:
            robot = SO101Follower(SO101FollowerConfig(port=follower_port, id=robot_id))
            try:
                robot.bus.connect()
            except Exception as exc:
                raise RuntimeError(
                    f"Could not connect to the follower arm on {follower_port}. "
                    "Plugged in, powered, and not held by LeLab/CLI?"
                ) from exc
            robot.bus.write_calibration(robot.calibration)
            robot.configure()

            if req.get("leaderPort"):
                teleop = SO101Leader(SO101LeaderConfig(port=req["leaderPort"], id=robot_id))
                try:
                    teleop.bus.connect()
                    teleop.bus.write_calibration(teleop.calibration)
                    teleop.configure()
                except Exception as exc:  # noqa: BLE001
                    # Leader is optional — a follower-only rig (friend's machine,
                    # headless agent autoconnect) must still come up. Keyboard and
                    # phone sources are unaffected; teleop_ready refuses
                    # source="leader" while self.teleop is None.
                    emit({
                        "event": "error",
                        "where": "real.connect",
                        "error": (
                            f"leader arm unavailable on {req['leaderPort']} ({exc})"
                            " — follower up without it"
                        ),
                    })
                    log(f"real: leader attach failed ({exc}) — continuing without leader")
                    teleop = None

            self.robot, self.teleop, self.state = robot, teleop, "connected"
            self._emit_state()
            return {"state": self.state, "leader": teleop is not None}
        except Exception:
            self._safe_disconnect(robot)
            self._safe_disconnect(teleop)
            self.robot = self.teleop = None
            self.state = "disconnected"
            raise

    def disconnect(self) -> dict:
        self._safe_disconnect(self.robot)
        self._safe_disconnect(self.teleop)
        self.robot = self.teleop = None
        self.state = "disconnected"
        self._emit_state()
        return {"state": "disconnected"}

    # ---------- control ----------

    def torque(self, on: bool) -> dict:
        if self.robot is None:
            raise ValueError("not connected")
        if on:
            self.robot.bus.enable_torque()
        else:
            self.robot.bus.disable_torque()
        return {"torque": on}

    def estop(self) -> dict:
        """Torque kill. Arm goes limp — hold it if it's raised."""
        if self.robot is not None:
            try:
                self.robot.bus.disable_torque()
            except Exception as exc:  # noqa: BLE001
                log(f"estop disable_torque error: {exc}")
        self.state = "connected" if self.robot is not None else "disconnected"
        self._emit_state()
        return {"estopped": True}

    def _read_joints(self) -> dict[str, float]:
        obs = self.robot.get_observation()
        return {
            k.removesuffix(".pos"): round(float(v), 2)
            for k, v in obs.items()
            if k.endswith(".pos")
        }

    def get_joints(self) -> dict:
        if self.robot is None:
            raise ValueError("not connected")
        return self._read_joints()

    # ---------- uniform surface for the driver's unified teleop loop ----------

    @property
    def lerobot_joint_names(self) -> list[str]:
        if self.robot is None:
            raise ValueError("not connected")
        return list(self.robot.bus.motors.keys())

    def current_joints_pos(self) -> dict[str, float]:
        """Observation-shaped joints: {"<name>.pos": value} in lerobot units."""
        if self.robot is None:
            raise ValueError("not connected")
        return {k: float(v) for k, v in self.robot.get_observation().items() if k.endswith(".pos")}

    def apply_action(self, action: dict) -> None:
        self.robot.send_action(action)

    def teleop_ready(self, source: str) -> None:
        """Called by the driver before its unified teleop loop starts."""
        if self.robot is None:
            raise ValueError("not connected")
        if source == "leader" and self.teleop is None:
            raise ValueError("connect with the leader arm first")
        # synthetic sources get a per-frame clamp; the leader is human-limited
        self.robot.config.max_relative_target = None if source == "leader" else 15.0

    def teleop_done(self) -> None:
        if self.robot is not None:
            self.robot.config.max_relative_target = None

    # ---------- record ----------

    def prepare_record(self, cfg: dict):
        """Attach record cameras without releasing torque or serial ownership.

        LeRobot's follower ``disconnect()`` disables torque by default and a
        fresh ``connect()`` temporarily disables it again while configuring
        motors. The old handoff recreated both devices for every episode, so a
        task attempt made an elevated arm go limp. Reuse the already configured
        follower/leader and attach only the cameras that the recorder needs.
        """
        from lerobot.cameras import make_cameras_from_configs
        from lerobot.cameras.opencv.configuration_opencv import OpenCVCameraConfig

        if self.robot is None:
            raise ValueError("not connected")
        source = cfg.get("source", "leader")
        if source == "scripted":
            raise ValueError("scripted source is sim-only")
        if source == "leader" and self.teleop is None:
            raise ValueError("recording needs the leader arm — reconnect with leader")
        if self._record_cameras or self.robot.cameras:
            raise RuntimeError("record cameras are already attached")

        # Seed open-loop EE sources before recording starts. The follower stays
        # connected throughout, so this is both current and torque-safe.
        seed_obs = self.current_joints_pos() if source != "leader" else None
        camera_configs = {
            name: OpenCVCameraConfig(
                index_or_path=cam["index"],
                width=cam.get("width", 640),
                height=cam.get("height", 480),
                fps=cam.get("fps", 30),
            )
            for name, cam in (cfg.get("cameras") or {}).items()
        }
        cameras = make_cameras_from_configs(camera_configs)
        try:
            for camera in cameras.values():
                camera.connect()
        except Exception:
            for camera in cameras.values():
                self._safe_disconnect(camera)
            raise

        self.robot.cameras = cameras
        # observation_features is a cached property. It must include the newly
        # attached camera keys before the recorder builds the dataset schema.
        self.robot.__dict__.pop("observation_features", None)
        self._record_cameras = cameras
        self.state = "recording"
        self._emit_state()

        if source == "leader":
            teleop = self.teleop
        else:
            from sources.ee_chain import make_input_source

            # Synthetic sources get a per-frame clamp; the leader is human-limited.
            self.robot.config.max_relative_target = 15.0
            teleop = make_input_source(
                source, motor_names=list(self.robot.bus.motors.keys()), seed_obs=seed_obs
            )
        return self.robot, teleop, None

    def after_record(self) -> None:
        """Detach only recorder cameras; keep the configured arm powered.

        The recording loop did not open the real follower or leader, so it must
        not disconnect them. Closing just the temporary cameras lets preview
        capture reclaim their devices while the arm stays ready for the next
        attempt.
        """
        for camera in self._record_cameras.values():
            self._safe_disconnect(camera)
        self._record_cameras = {}
        if self.robot is not None:
            self.robot.cameras = {}
            self.robot.__dict__.pop("observation_features", None)
            self.robot.config.max_relative_target = None
        self.state = "connected" if self.robot is not None else "disconnected"
        self._emit_state()
