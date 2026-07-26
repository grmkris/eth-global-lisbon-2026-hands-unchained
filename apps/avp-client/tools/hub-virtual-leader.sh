#!/usr/bin/env bash
# Start the Bonjour AVP gateway that follows a web-selected Hands Unchained rig.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Prefer the Hands Unchained driver venv when present: it carries `websockets`,
# which unlocks the hub's full-rate WS input plane (system python falls back
# to keep-alive HTTP at ~10 packets/s).
DRIVER_VENV_PYTHON="$SCRIPT_DIR/../../eth-global-lisbon-2026-hands-unchained/apps/driver/.venv/bin/python"
if [ -z "${PYTHON:-}" ] && [ -x "$DRIVER_VENV_PYTHON" ]; then
  PYTHON="$DRIVER_VENV_PYTHON"
fi
PYTHON="${PYTHON:-python3}"

exec "$PYTHON" "$SCRIPT_DIR/hub_virtual_leader_gateway.py" \
  --hub-url "${HUB_URL:-https://web-production-b5106.up.railway.app}" \
  --leader-name "${LEADER_NAME:-$(hostname -s)-avp}" \
  --name "${GATEWAY_NAME:-MacBook AVP Hub Gateway}" \
  --listen-port "${LISTEN_PORT:-7443}" \
  --command-timeout-ms "${COMMAND_TIMEOUT_MS:-500}" \
  --motion-scale "${MOTION_SCALE:-0.6}" \
  --smoothing-ms "${SMOOTHING_MS:-120}" \
  --max-speed-deg-s "${MAX_SPEED_DEG_S:-60}" \
  --max-gripper-speed "${MAX_GRIPPER_SPEED:-60}" \
  ${ELBOW_MOTION_SCALE:+--elbow-motion-scale "$ELBOW_MOTION_SCALE"} \
  ${SHOULDER_PAN_SCALE:+--shoulder-pan-scale "$SHOULDER_PAN_SCALE"} \
  ${SHOULDER_LIFT_SCALE:+--shoulder-lift-scale "$SHOULDER_LIFT_SCALE"} \
  ${WRIST_FLEX_SCALE:+--wrist-flex-scale "$WRIST_FLEX_SCALE"} \
  ${WRIST_ROLL_SCALE:+--wrist-roll-scale "$WRIST_ROLL_SCALE"} \
  "$@"
