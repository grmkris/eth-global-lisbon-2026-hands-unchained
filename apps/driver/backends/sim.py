"""Sim backend — MuJoCo (Menagerie SO-ARM100) behind the same driver protocol.

Everything the console sees is identical to the real backend: joints events,
MJPEG frames named workspace_cam/wrist_cam, record sessions writing genuine
LeRobot datasets. Policies trained on sim RGB do NOT transfer to the real arm
(locked-in boundary) — this backend exists for plumbing, UI testing, teleop
practice and demo insurance.

"Teleop" in sim-1 = a scripted pick choreography (SimExpert). It subclasses the
real lerobot Teleoperator because record_loop isinstance-checks its teleop.
"""

import os
import random
import threading
import time
from pathlib import Path

import cv2
import mujoco
import numpy as np

from shared import BRIGHTNESS, FRAMES, LOCK, emit, log
from sources.scripted import ScriptedExpert

MENAGERIE_DIR = Path(__file__).parent.parent / "assets/mujoco_menagerie/trs_so_arm100"
SCENE_FILE = MENAGERIE_DIR / "lab_scene.xml"

# (lerobot_name, mujoco_joint) — mujoco actuators share the joint names
JOINT_MAP = [
    ("shoulder_pan", "Rotation"),
    ("shoulder_lift", "Pitch"),
    ("elbow_flex", "Elbow"),
    ("wrist_flex", "Wrist_Pitch"),
    ("wrist_roll", "Wrist_Roll"),
    ("gripper", "Jaw"),
]

SCENE_XML = """<mujoco model="so101 lab scene">
  <include file="so_arm100.xml"/>
  <statistic center="0.15 0 0.1" extent="0.6"/>
  <visual>
    <headlight diffuse="0.7 0.7 0.7" ambient="0.45 0.45 0.45" specular="0 0 0"/>
    <global azimuth="150" elevation="-25" offwidth="640" offheight="480"/>
  </visual>
  <asset>
    <texture type="2d" name="mat" builtin="checker" rgb1="0.10 0.10 0.10" rgb2="0.16 0.16 0.16"
      width="200" height="200"/>
    <material name="mat" texture="mat" texrepeat="6 6"/>
  </asset>
  <worldbody>
    <light pos="0.3 0 1.2" dir="0 0 -1" directional="true"/>
    <geom name="floor" type="plane" size="1.5 1.5 0.05" material="mat"/>
    <body name="cube" pos="0.22 0.0 0.016">
      <freejoint name="cube_free"/>
      <geom type="box" size="0.015 0.015 0.015" rgba="0.92 0.92 0.97 1" mass="0.02"/>
    </body>
    <camera name="workspace_cam" pos="0.42 -0.34 0.46" mode="fixed"
      xyaxes="0.5914 0.8064 0.0000 -0.6098 0.4472 0.6543" fovy="58"/>
  </worldbody>
</mujoco>
"""

# Wrist camera mount, solved at the home pose: offset to the side of the jaws so
# the gripper body does not occlude, looking down the grasp axis.
WRIST_CAM_BODY = "Fixed_Jaw"
WRIST_CAM_POS = [-0.0029, 0.0373, 0.055]
WRIST_CAM_QUAT = [0.77816, -0.57901, 0.19512, 0.14542]

# scripted pick choreography: (rad targets in JOINT_MAP order, seconds to get there)
KEYFRAMES = [
    ([0.0, -1.57, 1.57, 1.57, -1.57, 0.6], 1.0),   # home, jaw open
    ([0.25, -1.00, 1.25, 1.30, -1.57, 0.9], 1.2),  # reach over cube
    ([0.25, -0.55, 0.95, 1.35, -1.57, 0.9], 1.0),  # descend
    ([0.25, -0.55, 0.95, 1.35, -1.57, 0.0], 0.6),  # close jaw
    ([0.25, -1.30, 1.50, 1.40, -1.57, 0.0], 1.2),  # lift
    ([-0.35, -1.10, 1.35, 1.35, -1.57, 0.0], 1.4), # carry left
    ([-0.35, -0.70, 1.05, 1.35, -1.57, 0.9], 0.8), # lower + release
    ([0.0, -1.57, 1.57, 1.57, -1.57, 0.6], 1.4),   # back home
]


class SimBackend:
    name = "sim"

    def __init__(self) -> None:
        if not (MENAGERIE_DIR / "so_arm100.xml").exists():
            # The model is vendored in this repo (Apache-2.0, MuJoCo Menagerie
            # trs_so_arm100) — missing means a broken checkout, not a setup step.
            raise RuntimeError(
                f"Menagerie model missing at {MENAGERIE_DIR} — it ships with "
                "the repo; restore apps/driver/assets/mujoco_menagerie/"
            )
        SCENE_FILE.write_text(SCENE_XML)
        # The wrist camera must hang off a body defined in the *included* arm
        # model, which an XML <include> cannot reach into — so attach it through
        # MjSpec. It then moves with the gripper, like the real Innomaker mount.
        spec = mujoco.MjSpec.from_file(str(SCENE_FILE))
        wrist = spec.body(WRIST_CAM_BODY).add_camera()
        wrist.name = "wrist_cam"
        wrist.pos = WRIST_CAM_POS
        wrist.quat = WRIST_CAM_QUAT
        wrist.fovy = 75
        self.model = spec.compile()
        self.data = mujoco.MjData(self.model)
        self.sim_lock = threading.Lock()

        self.joint_qpos = []
        self.joint_range = []
        self.actuator_ids = []
        for _, mj_name in JOINT_MAP:
            jid = self.model.joint(mj_name).id
            self.joint_qpos.append(self.model.jnt_qposadr[jid])
            self.joint_range.append(tuple(self.model.jnt_range[jid]))
            self.actuator_ids.append(self.model.actuator(mj_name).id)
        # lerobot's DEGREES zero is the MID of the calibrated range, but MJCF
        # zero is wherever the model author put it — for Pitch/Elbow that is a
        # joint LIMIT (~90° from mid). Map lerobot degrees relative to each
        # joint's mid so a real leader's pose lands on the same sim pose (and
        # the IK URDF, which is symmetric about mid, matches the sim frame).
        self.joint_mid = [(lo + hi) / 2.0 for lo, hi in self.joint_range]
        self.cube_qpos = self.model.jnt_qposadr[self.model.joint("cube_free").id]

        home = KEYFRAMES[0][0]
        for i, q in enumerate(home):
            self.data.qpos[self.joint_qpos[i]] = q
            self.data.ctrl[self.actuator_ids[i]] = q
        mujoco.mj_forward(self.model, self.data)

        self.state = "connected"
        self.paused = False
        self._alive = True
        self.teleop = None  # optional real leader arm driving the sim
        threading.Thread(target=self._physics_loop, name="sim-physics", daemon=True).start()
        threading.Thread(target=self._render_loop, name="sim-render", daemon=True).start()
        if os.environ.get("LAB_SIM_VIEWER") == "1":
            threading.Thread(target=self._viewer_loop, name="sim-viewer", daemon=True).start()
        log("sim backend up (MuJoCo)")

    # ---------- unit conversion (lerobot: degrees, gripper 0..100) ----------

    def rad_to_lerobot(self, rad: list[float]) -> dict[str, float]:
        out = {}
        for i, (lname, _) in enumerate(JOINT_MAP):
            if lname == "gripper":
                lo, hi = self.joint_range[i]
                out["gripper.pos"] = round((rad[i] - lo) / (hi - lo) * 100.0, 2)
            else:
                out[f"{lname}.pos"] = round(np.degrees(rad[i] - self.joint_mid[i]), 2)
        return out

    def lerobot_to_rad(self, action: dict[str, float]) -> list[float]:
        rad = []
        for i, (lname, _) in enumerate(JOINT_MAP):
            v = float(action.get(f"{lname}.pos", 0.0))
            if lname == "gripper":
                lo, hi = self.joint_range[i]
                rad.append(lo + (max(0.0, min(100.0, v)) / 100.0) * (hi - lo))
            else:
                rad.append(self.joint_mid[i] + np.radians(v))
        return rad

    def _qpos_rad(self) -> list[float]:
        return [float(self.data.qpos[adr]) for adr in self.joint_qpos]

    @property
    def lerobot_joint_names(self) -> list[str]:
        return [lname for lname, _ in JOINT_MAP]

    def current_joints_pos(self) -> dict[str, float]:
        """Observation-shaped joints: {"<name>.pos": value} in lerobot units."""
        with self.sim_lock:
            return self.rad_to_lerobot(self._qpos_rad())

    def get_joints(self) -> dict[str, float]:
        with self.sim_lock:
            return {k.removesuffix(".pos"): v for k, v in self.rad_to_lerobot(self._qpos_rad()).items()}

    def apply_action(self, action: dict[str, float]) -> None:
        rad = self.lerobot_to_rad(action)
        with self.sim_lock:
            for i, aid in enumerate(self.actuator_ids):
                lo, hi = self.joint_range[i]
                self.data.ctrl[aid] = max(lo, min(hi, rad[i]))

    # ---------- threads ----------

    def _physics_loop(self) -> None:
        step = self.model.opt.timestep  # 0.002
        per_tick = max(1, int(0.01 / step))
        while self._alive:
            if not self.paused:
                with self.sim_lock:
                    for _ in range(per_tick):
                        mujoco.mj_step(self.model, self.data)
            time.sleep(0.01)

    def _render_loop(self) -> None:
        renderer = mujoco.Renderer(self.model, height=480, width=640)
        n = 0
        while self._alive:
            for cam in ("workspace_cam", "wrist_cam"):
                with self.sim_lock:
                    renderer.update_scene(self.data, camera=cam)
                rgb = renderer.render()
                ok, jpg = cv2.imencode(".jpg", cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR),
                                       [cv2.IMWRITE_JPEG_QUALITY, 80])
                if ok:
                    with LOCK:
                        FRAMES[cam] = jpg.tobytes()
                if n % 15 == 0:
                    with LOCK:
                        BRIGHTNESS[cam] = round(float(cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY).mean()), 1)
            n += 1
            time.sleep(1 / 15)

    def _viewer_loop(self) -> None:
        """Native MuJoCo window. macOS needs the process launched via mjpython —
        see LAB_DRIVER_PYTHON in the run scripts."""
        try:
            import mujoco.viewer
        except Exception as exc:  # noqa: BLE001
            log(f"viewer unavailable: {exc}")
            return
        try:
            with mujoco.viewer.launch_passive(
                self.model, self.data, show_left_ui=False, show_right_ui=False
            ) as viewer:
                log("MuJoCo viewer window open")
                while self._alive and viewer.is_running():
                    with self.sim_lock:
                        viewer.sync()
                    time.sleep(1 / 30)
        except Exception as exc:  # noqa: BLE001 — a dead window must not kill the sim
            log(f"viewer closed: {exc}")

    # ---------- protocol commands ----------

    def connect(self, req: dict) -> dict:
        # A real leader arm can drive the sim: its get_action() is already in
        # lerobot space (degrees + gripper 0..100), which is exactly what
        # apply_action consumes. Optional — without it the scripted expert and
        # the browser sources still work.
        leader_port = req.get("leaderPort")
        if leader_port:
            from lerobot.teleoperators.so_leader import SO101Leader, SO101LeaderConfig

            try:
                teleop = SO101Leader(
                    SO101LeaderConfig(port=leader_port, id=req.get("robotId", "arm"))
                )
                teleop.connect()
                self.teleop = teleop
                log(f"sim: leader arm attached on {leader_port}")
            except Exception as exc:  # noqa: BLE001
                # The leader is an optional extra for a sim — a rig whose arm
                # is unplugged must still come up (headless agents autoconnect
                # with withLeader=true and only get ONE attempt). Keyboard and
                # scripted driving are unaffected; teleop_ready still refuses
                # source="leader" while self.teleop is None.
                emit({
                    "event": "error",
                    "where": "sim.connect",
                    "error": f"leader arm unavailable on {leader_port} ({exc}) — sim up without it",
                })
                log(f"sim: leader attach failed ({exc}) — continuing without leader")
        emit({"event": "robot_state", "state": self.state, "backend": self.name})
        return {"state": self.state, "leader": self.teleop is not None}

    def disconnect(self) -> dict:
        self._alive = False
        self.state = "disconnected"
        if self.teleop is not None:
            try:
                self.teleop.disconnect()
            except Exception:  # noqa: BLE001 — best effort, port must be freed
                pass
            self.teleop = None
        with LOCK:
            FRAMES.pop("workspace_cam", None)
            FRAMES.pop("wrist_cam", None)
        emit({"event": "robot_state", "state": self.state, "backend": self.name})
        return {"state": "disconnected"}

    def torque(self, on: bool) -> dict:
        self.paused = not on
        return {"torque": on}

    def estop(self) -> dict:
        """Sim E-stop = pause physics (muscle memory parity with the real button)."""
        self.paused = True
        self.state = "connected"
        emit({"event": "robot_state", "state": self.state, "backend": self.name})
        return {"estopped": True}

    def teleop_ready(self, source: str) -> None:
        """Called by the driver before its unified teleop loop starts."""
        if source == "leader" and self.teleop is None:
            raise ValueError("connect with the leader arm first (sim + leader)")
        self.paused = False

    # ---------- record ----------

    def _jitter_cube(self) -> None:
        """Cube jitter between episodes (coverage-ish variation). Caller holds no lock."""
        with self.sim_lock:
            self.data.qpos[self.cube_qpos + 0] = 0.22 + random.uniform(-0.03, 0.03)
            self.data.qpos[self.cube_qpos + 1] = random.uniform(-0.04, 0.04)
            self.data.qpos[self.cube_qpos + 2] = 0.016
            mujoco.mj_forward(self.model, self.data)

    def _reset_arm_home(self) -> None:
        with self.sim_lock:
            for i, q in enumerate(KEYFRAMES[0][0]):
                self.data.qpos[self.joint_qpos[i]] = q
                self.data.ctrl[self.actuator_ids[i]] = q
            mujoco.mj_forward(self.model, self.data)

    def prepare_record(self, cfg: dict):
        source = cfg.get("source", "scripted")
        if source == "leader" and self.teleop is None:
            raise ValueError("connect with the leader arm first (sim + leader)")
        self.paused = False
        self.state = "recording"
        emit({"event": "robot_state", "state": self.state, "backend": self.name})

        if source == "scripted":
            expert = ScriptedExpert(self, KEYFRAMES)

            def on_episode_start() -> None:
                self._reset_arm_home()
                self._jitter_cube()
                expert.reset()

            return SimArm(self), expert, on_episode_start

        from sources.ee_chain import make_input_source

        teleop = make_input_source(
            source, motor_names=self.lerobot_joint_names, seed_obs=self.current_joints_pos()
        )
        # human-driven: only the scene varies — the arm stays where the driver left it
        return SimArm(self), teleop, self._jitter_cube

    def after_record(self) -> None:
        self.state = "connected"
        emit({"event": "robot_state", "state": self.state, "backend": self.name})


class SimArm:
    """Robot-duck for record_loop: get_observation / send_action over the sim."""

    name = "so101_follower"  # keeps dataset robot_type consistent with real datasets

    def __init__(self, backend: SimBackend) -> None:
        self.b = backend
        self.cameras = {"workspace_cam": None, "wrist_cam": None}
        self.calibration = None
        self._renderer: mujoco.Renderer | None = None

    @property
    def action_features(self) -> dict:
        return {f"{lname}.pos": float for lname, _ in JOINT_MAP}

    @property
    def observation_features(self) -> dict:
        return {
            **{f"{lname}.pos": float for lname, _ in JOINT_MAP},
            "workspace_cam": (480, 640, 3),
            "wrist_cam": (480, 640, 3),
        }

    @property
    def is_connected(self) -> bool:
        return True

    def connect(self, calibrate: bool = True) -> None:  # noqa: ARG002
        self._renderer = mujoco.Renderer(self.b.model, height=480, width=640)

    def disconnect(self) -> None:
        self._renderer = None

    def get_observation(self) -> dict:
        obs: dict = {}
        with self.b.sim_lock:
            obs.update(self.b.rad_to_lerobot(self.b._qpos_rad()))
            for cam in ("workspace_cam", "wrist_cam"):
                self._renderer.update_scene(self.b.data, camera=cam)
                obs[cam] = self._renderer.render().copy()
        return obs

    def send_action(self, action: dict) -> dict:
        self.b.apply_action(action)
        return action
