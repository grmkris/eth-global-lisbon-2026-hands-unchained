"""Real backend — serial SO-101 arms + OpenCV cameras via lerobot 0.6.0.
Connect/teleop structure cribbed from LeLab's teleoperate.py (worker owns disconnect).
"""


from shared import emit, log


class RealBackend:
    name = "real"

    def __init__(self) -> None:
        self.robot = None
        self.teleop = None
        self.state = "disconnected"
        self._ports: dict = {}

    # ---------- lifecycle ----------

    def _emit_state(self) -> None:
        emit({"event": "robot_state", "state": self.state, "backend": self.name})

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
        self._ports = {
            "followerPort": req["followerPort"],
            "leaderPort": req.get("leaderPort"),
            "robotId": robot_id,
        }
        robot = None
        teleop = None
        try:
            robot = SO101Follower(SO101FollowerConfig(port=req["followerPort"], id=robot_id))
            try:
                robot.bus.connect()
            except Exception as exc:
                raise RuntimeError(
                    f"Could not connect to the follower arm on {req['followerPort']}. "
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
        """Release held devices, build FRESH lerobot objects with cameras for the recorder.

        Demos come from cfg["source"]: leader (needs the leader arm) or an
        input-driven source (keys/phone — no leader required, clamped).
        Returns (robot, teleop, on_episode_start).
        """
        from lerobot.cameras.opencv.configuration_opencv import OpenCVCameraConfig
        from lerobot.robots.so_follower import SO101Follower, SO101FollowerConfig
        from lerobot.teleoperators.so_leader import SO101Leader, SO101LeaderConfig

        source = cfg.get("source", "leader")
        if source == "scripted":
            raise ValueError("scripted source is sim-only")
        if source == "leader" and not self._ports.get("leaderPort"):
            raise ValueError("recording needs the leader arm — reconnect with leader")
        # seed for open-loop EE sources: read while we still hold the arm
        seed_obs = self.current_joints_pos() if source != "leader" else None

        # recorder owns the serial ports + cameras from here
        self._safe_disconnect(self.robot)
        self._safe_disconnect(self.teleop)
        self.robot = self.teleop = None
        self.state = "recording"
        self._emit_state()

        cameras = {
            name: OpenCVCameraConfig(
                index_or_path=cam["index"],
                width=cam.get("width", 640),
                height=cam.get("height", 480),
                fps=cam.get("fps", 30),
            )
            for name, cam in (cfg.get("cameras") or {}).items()
        }
        robot = SO101Follower(
            SO101FollowerConfig(
                port=self._ports["followerPort"], id=self._ports["robotId"], cameras=cameras
            )
        )
        if source == "leader":
            teleop = SO101Leader(
                SO101LeaderConfig(port=self._ports["leaderPort"], id=self._ports["robotId"])
            )
        else:
            from sources.ee_chain import make_input_source

            # synthetic sources get a per-frame clamp; the leader is human-limited
            robot.config.max_relative_target = 15.0
            teleop = make_input_source(
                source, motor_names=list(robot.bus.motors.keys()), seed_obs=seed_obs
            )
        return robot, teleop, None

    def after_record(self) -> None:
        # recorder disconnected the devices it owned; back to square one
        self.robot = self.teleop = None
        self.state = "disconnected"
        self._emit_state()
