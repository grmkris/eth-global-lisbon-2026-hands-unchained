# Friend setup — SO-101 + the hub

Two independent things you can do; each works without the other:

- **A. Drive Kristjan's sim with YOUR leader arm** — needs only steps 0–1 + "A" below.
- **B. Put your follower on the hub** so others can drive it — steps 0–5.

Your Mac runs a small headless agent; it dials OUT to the hub, so no port
forwarding, no firewall changes, nothing exposed. Kristjan (or anyone with the
lobby URL) sees your camera feed and drives the arm with their keyboard.

Hub: **https://web-production-b5106.up.railway.app**

## 0. Prereqs (Apple Silicon Mac)

```sh
# bun (JS runtime)
curl -fsSL https://bun.sh/install | bash
# uv (python env manager)
curl -LsSf https://astral.sh/uv/install.sh | sh
```

## 1. Clone + install

```sh
git clone https://github.com/grmkris/eth-global-lisbon-2026-proof-of-hands.git
cd eth-global-lisbon-2026-proof-of-hands/apps/web && bun install
cd ../driver && uv sync        # installs lerobot 0.6.0 + opencv (+ mujoco)
```

## A. Drive Kristjan's sim with your leader arm

Plug in your LEADER arm (the small one, no gearing). Find its port
(`ls /dev/tty.usbmodem*`) and calibrate it once (from `apps/driver`):

```sh
.venv/bin/lerobot-calibrate --teleop.type=so101_leader \
  --teleop.port=/dev/tty.usbmodemXXXX --teleop.id=arm
```

Then check `kris-sim` is online in the lobby and:

```sh
.venv/bin/python controller.py \
  --hub https://web-production-b5106.up.railway.app \
  --rig kris-sim \
  --port /dev/tty.usbmodemXXXX
```

Move your leader — the simulated arm at
https://web-production-b5106.up.railway.app/drive/kris-sim follows (open it
for the camera view; you'll be "driving", video stays live). Ctrl-C releases
the rig. Notes: motion is clamped to 15°/tick on the rig side; if the wrist
roll sits at a odd angle, that's the known cross-device wrist_roll zero
offset — recalibrate the leader holding the wrist how you want "zero" to be.

## 2. (Track B) Plug in the follower, find its port

Follower arm on USB + its power supply. Then:

```sh
ls /dev/tty.usbmodem*          # -> e.g. /dev/tty.usbmodem58FA0812345
```

If you see two entries, unplug/replug the arm and note which one changes.

## 3. Calibrate (once)

From `apps/driver`:

```sh
.venv/bin/lerobot-calibrate --robot.type=so101_follower \
  --robot.port=/dev/tty.usbmodemXXXX --robot.id=arm
```

Middle position first, then move every joint through its full range.
This writes limits into the servos — it is also the safety envelope: the hub
can never drive your arm past what YOU calibrated.

## 4. Camera

Plug any USB webcam pointed at the arm's workspace (the built-in laptop cam
is deliberately ignored). No config — the agent finds it.

## 5. Run the agent

From `apps/web` (one line — headless, no UI, no open ports):

```sh
HUB_URL=https://web-production-b5106.up.railway.app \
RIG_NAME=friend-arm \
LAB_AUTOCONNECT=real \
FOLLOWER_PORT=$(ls /dev/tty.usbmodem* | head -1) \
bun run agent
```

Within ~2 s your rig appears at the hub's Lobby, camera streaming. You're done —
leave the terminal running. Ctrl-C fully stops it (arm goes limp and torque
drops on disconnect; that is intentional).

## Safety, please actually read

- **Clear the workspace** — nothing fragile within arm's reach, arm not near
  the table edge.
- **Stay next to it** the first session. Your kill switches: Ctrl-C in the
  terminal, or unplug the arm's power — and anyone watching the drive page
  can hit E-STOP / Stop teleop without holding control. The driver also
  clamps every remote step (max 15° per tick) and a 0.5 s network deadman
  stops motion when packets stop.
- **Auth is built but currently switched off** (`HUB_TOKEN` unset on the hub)
  — anyone with the URL can drive whatever rig is registered. Only run the
  agent while we're actually testing. If Kristjan sets a token, add
  `HUB_TOKEN=<shared secret>` to the agent command (and controller runs get
  it too) — everything else stays the same.

## If something's off

- Rig shows offline in the lobby → the agent terminal will say why
  (`[rig-link] hub unreachable …`).
- "leader arm unavailable" warning on the drive page → expected, ignore. You
  have no leader arm; keyboard driving is unaffected.
- Port busy → close anything else that talks to the arm (LeLab, another
  terminal).
- No camera feed → check the webcam is USB, not the built-in one.
