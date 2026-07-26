# AVP virtual leader → SO-101 follower test

This bridge replaces the serial SO-101 leader with the virtual leader running on
Vision Pro. It uses relative clutching and never moves merely because it connects
or arms.

## Safety model

- The physical gateway requires `--allow-motion` and an interactive `DRIVE` confirmation.
- The AVP must separately connect, enter the one-time pairing code, and press **Arm**.
- On connection, the inactive virtual leader automatically fits itself to the follower's measured shoulder, elbow, wrist, roll, and gripper telemetry. This synchronization is one-time per follower/rig selection and never emits active motion.
- Before telemetry arrives the virtual leader starts folded. **Recenter Folded** may reset it only while neither control is grabbed, so the physical follower remains stationary while control travel is restored.
- Grabbing the violet control clutches the five arm joints at the follower's measured pose. The elbow uses an independent 1.0 scale so extending the folded virtual arm can traverse the physical elbow range; the Mac slew limit still caps speed.
- Grabbing the teal control independently clutches the gripper. Relative endpoint mapping keeps engagement jump-free while mapping fully closed/open to the calibrated physical 0/100% endpoints.
- Wrist flex and roll are modeled as separate joints, bounded to ±70°/±75°, and slew-filtered; the violet handle remains above the wrist instead of rolling underneath it.
- Releasing a control holds its last commanded target.
- Stale active commands, a dropped connection, **Stop**, or Control-C disarm the gateway. The transport watchdog is 2000 ms to tolerate LAN latency.
- The AVP sends controls from a bounded network-queue pump. If its UI stops refreshing input for about 120 ms, the pump releases both clutches instead of replaying stale active motion.
- Mac state telemetry is limited to 2 Hz during the 30 Hz control stream so telemetry rendering cannot starve the deadman sender.
- Targets are constrained by the follower calibration, a safety margin, per-cycle LeRobot clipping, and a low slew rate.

Keep the physical power disconnect within reach. The current LAN protocol is
paired but not encrypted, so use only a trusted private network.

## 1. Dry run first

From the repository:

```bash
DRY_RUN=1 ./tools/teleop-bridge-virtual-leader.sh
```

The terminal prints a four-digit pairing code. Three incorrect attempts lock
pairing for 60 seconds. On Vision Pro:

1. Press **Search**.
2. Connect to `MacBook Virtual SO-101`.
3. Enter the terminal's pairing code and press **Pair**.
4. Press **Arm**. The UI must identify this as a dry run.
5. Open the virtual leader and manipulate its controls.

No serial device is opened in dry-run mode. The gateway prints connection,
pairing, arm/stop, clutch, timeout, and live simulated target/actual events to
its terminal. Set `LOG_STATE_HZ=5` for more frequent active-state output or `0`
to disable periodic joint lines.

## 2. Physical follower

Stop any existing `lerobot-teleoperate` process first; only one process may own
the follower serial port. Put the follower in a safe, supported pose and clear its
workspace.

```bash
./tools/teleop-bridge-virtual-leader.sh
```

The defaults match the current setup:

```text
follower port: /dev/tty.usbmodem5AE60832001
robot id:      arm
motion scale:  0.20
max speed:     8 degrees/s
watchdog:      2000 ms
elbow rest:    10 degrees beyond calibrated endpoint
```

Type `DRIVE` on the Mac when prompted. If the servo EEPROM calibration differs,
the launcher applies the existing saved LeRobot profile for `robot.id=arm` while
torque is disabled. It then validates and latches the measured pose before
enabling holding torque.

A collapsed elbow may start up to 10° beyond its calibrated endpoint. The
gateway latches that exact measured pose, never commands farther outward, and
allows only inward motion until the elbow returns inside its normal limits.
Other joints receive no startup tolerance. Override conservatively with
`COLLAPSED_ELBOW_TOLERANCE_DEG`; values above 20° are rejected.

### Recalibrate an invalid or incomplete follower range

If startup reports that a joint is outside its calibrated hardware range, first
try manually repositioning the torque-free follower into a central pose. If the
saved range itself is wrong or incomplete, run:

```bash
./tools/teleop-bridge-virtual-leader.sh --calibrate
```

`CALIBRATE=1` is also supported for environment-based launchers.

The calibration mode requires a separate `CALIBRATE` confirmation, disables
torque, claims exclusive ownership of the serial device, backs up the current
JSON profile, and guides midpoint and complete range-of-motion recording. It
retries transient dropped packets but aborts after a sustained communication
failure. It records each joint separately, shows the required encoder span, and
allows `RETRY` on an incomplete joint without discarding already accepted
joints. Move each named joint gently through both endpoints of its complete safe
mechanical travel without forcing a stop. If calibration is aborted, the
previous motor/file calibration is restored. After a successful sweep,
move the arm to a supported central pose and type `SAVE`. The launcher verifies
the new EEPROM values and then continues to the normal `DRIVE` prompt.

Use `--calibrate-only` (or `CALIBRATE_ONLY=1 CALIBRATE=1`) to exit after
calibration without starting the gateway.

Then connect, pair, and arm from the AVP. The first frame after grabbing a
control captures a zero-delta clutch, so it must not cause a pose jump. Begin
with very small movements.

## Direction and sensitivity overrides

Joint conventions can be inverted without editing code:

```bash
SHOULDER_PAN_SIGN=-1 \
SHOULDER_LIFT_SIGN=1 \
ELBOW_FLEX_SIGN=1 \
WRIST_FLEX_SIGN=1 \
WRIST_ROLL_SIGN=-1 \
GRIPPER_SIGN=1 \
MOTION_SCALE=0.20 \
MAX_SPEED_DEG_S=8 \
./tools/teleop-bridge-virtual-leader.sh
```

Each sign must be `1` or `-1`. Validate one axis at a time and save the confirmed
values before increasing scale or speed. `MOTION_SCALE` applies to the arm
joints except the elbow; `ELBOW_MOTION_SCALE` defaults to `1.0` to preserve
enough travel to unfold from the rest pose. The gripper always retains its full
calibrated endpoint range and is controlled by `MAX_GRIPPER_SPEED`.

Other useful overrides:

```bash
FOLLOWER_PORT=/dev/tty.usbmodem...  # if the serial path changes
LISTEN_PORT=7443
COMMAND_TIMEOUT_MS=2000
MAX_GRIPPER_SPEED=12
GATEWAY_NAME="MacBook Virtual SO-101"
```

Cameras are deliberately omitted from this first motion-control test.
