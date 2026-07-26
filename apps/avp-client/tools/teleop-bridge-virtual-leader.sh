#!/usr/bin/env bash
# Launch the Mac gateway with the AVP virtual leader in place of the serial leader.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LEROBOT_PYTHON="${LEROBOT_PYTHON:-$HOME/.local/share/uv/tools/lerobot/bin/python}"
FOLLOWER_PORT="${FOLLOWER_PORT:-/dev/tty.usbmodem5AE60832001}"
ROBOT_ID="${ROBOT_ID:-arm}"
LISTEN_PORT="${LISTEN_PORT:-7443}"
DRY_RUN="${DRY_RUN:-0}"
CALIBRATE="${CALIBRATE:-0}"
CALIBRATE_ONLY="${CALIBRATE_ONLY:-0}"

gateway_args=()
for arg in "$@"; do
  case "$arg" in
    --calibrate)
      CALIBRATE=1
      ;;
    --calibrate-only)
      CALIBRATE=1
      CALIBRATE_ONLY=1
      ;;
    *)
      gateway_args+=("$arg")
      ;;
  esac
done

exec_gateway() {
  # Bash 3.2 with `set -u` rejects expansion of an empty array.
  if [[ ${#gateway_args[@]} -gt 0 ]]; then
    exec "$LEROBOT_PYTHON" "$@" "${gateway_args[@]}"
  else
    exec "$LEROBOT_PYTHON" "$@"
  fi
}

if [[ ! -x "$LEROBOT_PYTHON" ]]; then
  echo "LeRobot Python was not found at: $LEROBOT_PYTHON" >&2
  exit 1
fi
if [[ "$CALIBRATE" != "0" && "$CALIBRATE" != "1" ]]; then
  echo "CALIBRATE must be 0 or 1" >&2
  exit 1
fi
if [[ "$CALIBRATE_ONLY" != "0" && "$CALIBRATE_ONLY" != "1" ]]; then
  echo "CALIBRATE_ONLY must be 0 or 1" >&2
  exit 1
fi
if [[ "$DRY_RUN" == "1" && "$CALIBRATE" == "1" ]]; then
  echo "CALIBRATE=1 cannot be combined with DRY_RUN=1" >&2
  exit 1
fi

common_args=(
  "$SCRIPT_DIR/virtual_leader_gateway.py"
  --name "${GATEWAY_NAME:-MacBook Virtual SO-101}"
  --listen-port "$LISTEN_PORT"
  --motion-scale "${MOTION_SCALE:-0.20}"
  --elbow-motion-scale "${ELBOW_MOTION_SCALE:-1.0}"
  --max-speed-deg-s "${MAX_SPEED_DEG_S:-8}"
  --max-gripper-speed "${MAX_GRIPPER_SPEED:-12}"
  --command-timeout-ms "${COMMAND_TIMEOUT_MS:-2000}"
  --collapsed-elbow-tolerance-deg "${COLLAPSED_ELBOW_TOLERANCE_DEG:-10}"
  --log-state-hz "${LOG_STATE_HZ:-2}"
  --shoulder-pan-sign "${SHOULDER_PAN_SIGN:-1}"
  --shoulder-lift-sign "${SHOULDER_LIFT_SIGN:-1}"
  --elbow-flex-sign "${ELBOW_FLEX_SIGN:-1}"
  --wrist-flex-sign "${WRIST_FLEX_SIGN:-1}"
  --wrist-roll-sign "${WRIST_ROLL_SIGN:-1}"
  --gripper-sign "${GRIPPER_SIGN:-1}"
)

if [[ -n "${PAIRING_CODE:-}" ]]; then
  common_args+=(--pairing-code "$PAIRING_CODE")
fi

if [[ "$DRY_RUN" == "1" ]]; then
  echo "Starting virtual leader bridge in DRY RUN mode (no serial connection)."
  exec_gateway "${common_args[@]}" --dry-run
fi

if [[ ! -e "$FOLLOWER_PORT" ]]; then
  echo "Follower serial device does not exist: $FOLLOWER_PORT" >&2
  echo "Set FOLLOWER_PORT=/dev/tty... if its device name changed." >&2
  exit 1
fi
if command -v lsof >/dev/null 2>&1; then
  if port_owner="$(lsof "$FOLLOWER_PORT" 2>&1)"; then
    echo "Follower serial device is already owned by another process:" >&2
    printf '%s\n' "$port_owner" >&2
    echo "Owner command(s):" >&2
    while IFS= read -r owner_pid; do
      ps -p "$owner_pid" -o pid=,ppid=,command= >&2 || true
    done < <(lsof -t "$FOLLOWER_PORT" | sort -u)
    echo "Stop the owner and any supervisor that automatically restarts it before retrying." >&2
    exit 1
  fi
fi

if [[ "$CALIBRATE" == "1" ]]; then
  "$LEROBOT_PYTHON" "$SCRIPT_DIR/calibrate_virtual_leader_follower.py" \
    --robot-port "$FOLLOWER_PORT" \
    --robot-id "$ROBOT_ID"
  if [[ "$CALIBRATE_ONLY" == "1" ]]; then
    echo "Calibration complete; CALIBRATE_ONLY=1 requested, so the gateway was not started."
    exit 0
  fi
fi

cat <<EOF
Starting the AVP virtual leader bridge for the physical follower.
  follower:    $FOLLOWER_PORT
  robot id:    $ROBOT_ID
  arm scale:   ${MOTION_SCALE:-0.20}
  elbow scale: ${ELBOW_MOTION_SCALE:-1.0}
  max speed:   ${MAX_SPEED_DEG_S:-8} degrees/s
  watchdog:    ${COMMAND_TIMEOUT_MS:-2000} ms
  elbow rest:  ${COLLAPSED_ELBOW_TOLERANCE_DEG:-10} degrees beyond calibrated endpoint

No physical SO-101 leader is used. Cameras are intentionally omitted in this
first control test. The Python gateway will require you to type DRIVE before it
opens the follower. If servo EEPROM values differ, it will apply the existing
saved '$ROBOT_ID' calibration with torque disabled, latch the measured pose, and
only then enable holding torque. The AVP must Pair and Arm separately.
EOF

exec_gateway "${common_args[@]}" \
  --allow-motion \
  --apply-saved-calibration \
  --robot-port "$FOLLOWER_PORT" \
  --robot-id "$ROBOT_ID"
