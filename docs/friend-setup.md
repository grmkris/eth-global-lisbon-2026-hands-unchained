# Friend setup — SO-101 + the hub

Two independent things you can do; each works without the other:

- **A. Drive a rig with YOUR leader arm** — steps 0–1, then one command.
- **B. Put your follower on the hub** so others can drive it — steps 0–1, then one command.

Your Mac runs a small headless agent either way; it dials OUT to the hub, so
no port forwarding, no firewall changes, nothing exposed.

Hub: **https://web-production-b5106.up.railway.app** (baked in as the
default — no URL to type)

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

## A. Drive a rig with your leader arm

Plug in your LEADER arm (the small one, no gearing) — nothing else on USB —
then from the repo root (or `apps/web`; both work):

```sh
bun run teleop
```

That's it. The port is auto-detected, the hub is the default, and your first
run walks you through lerobot's calibration wizard (middle position, then
full range of every joint). The script registers your leader under your
hostname and idles.

Now open a rig in the lobby → **Drive with \<your\>'s
leader**. Move your leader — the remote arm follows; the page keeps the
camera view. Stop from the page or Ctrl-C.

Notes: motion is clamped to 15°/tick on the rig side; if the wrist roll sits
at an odd angle, that's the known cross-device wrist_roll zero offset —
recalibrate the leader holding the wrist how you want "zero" to be.

## B. Put your follower on the hub

Plug in the follower (USB + its power supply) — nothing else on USB — and a
webcam pointed at the workspace (the built-in laptop cam is deliberately
ignored). Calibrate once if this arm never has been (from `apps/driver`;
this also writes the servo limits that the hub can never drive past):

```sh
.venv/bin/lerobot-calibrate --robot.type=so101_follower \
  --robot.port=$(ls /dev/tty.usbmodem*) --robot.id=arm
```

Then from `apps/web` (headless, no UI, no open ports):

```sh
LAB_AUTOCONNECT=real bun run agent
```

Port auto-detected, rig named after your hostname, hub defaulted.
(`FOLLOWER_PORT` / `RIG_NAME` / `HUB_URL` override any of that.) Within ~2 s
your rig appears in the Lobby, camera streaming. The terminal prints your
**owner key** — paste it on the drive page to define tasks, set up cameras,
or record. Ctrl-C fully stops it (arm goes limp; intentional).

**Both arms on ONE machine?** Auto-detect can't tell them apart — set the
ports explicitly for the agent (`FOLLOWER_PORT=... bun run agent`), leave
`LEADER_PORT` unset so the agent doesn't grab the leader, and give
`bun run teleop` its port via `LEADER_PORT=...` (or pick from its list).

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
  `HUB_TOKEN=<shared secret>` to both commands — everything else stays the
  same.

## If something's off

- Rig shows offline in the lobby → the agent terminal will say why
  (`[rig-link] hub unreachable …`).
- "no serial device found" → plug the arm in BEFORE starting (auto-connect
  tries once), or set the port env explicitly.
- "leader arm unavailable" warning on the drive page → expected on a
  follower-only rig; keyboard driving is unaffected.
- Port busy → close anything else that talks to the arm (LeLab, another
  terminal).
- No camera feed → check the webcam is USB, not the built-in one.
