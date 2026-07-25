# Proof of Hands

**ETHGlobal Lisbon 2026.** Crowdsourced robot teleoperation: real SO-101 arms
and MuJoCo sims register as **rigs** on a cloud hub; operators browse a lobby
and drive them over the public internet — browser keyboard or their **own
leader arm** — with a single-writer lease, bystander e-stop, and a 0.5 s
network deadman. Plain HTTP end to end: curl-debuggable, no WebRTC, no SDKs.

```
                   ┌──────────────────────────┐
   browser ───────▶│  HUB (Railway)           │  lobby · drive UI · relay
   (operator)      │  in-memory rig registry  │  lease · verb table
                   └───────────▲──────────────┘
                      outbound │ HTTP only (50ms control / 8fps MJPEG)
            ┌──────────────────┴───────────────────┐
            │ RIG AGENT (any Mac)                   │  headless; dials OUT —
            │ apps/web (agent role) + apps/driver   │  no ports, no NAT config
            │ → MuJoCo sim  OR  real SO-101 arm     │
            └───────────────────────────────────────┘
   controller.py ── your leader arm ──▶ hub ──▶ any rig   (leader-over-wire)
```

## Layout

- `apps/web` — one TypeScript app (TanStack Start + Effect v4, Bun), three
  roles by env: **hub** (deployed), **agent** (headless rig), **console**
  (local lab tool: record datasets, trainings, camera preflight).
- `apps/driver` — Python (uv, pinned `lerobot==0.6.0`): real-arm serial +
  MuJoCo sim backends, teleop sources (keys/leader/phone/remote/scripted),
  `controller.py` (drive a remote rig with your leader arm). Sim model and
  IK URDF are vendored — the repo is self-contained.
- `docs/` — [SPEC](docs/SPEC.md) (architecture) · [TESTING](docs/TESTING.md)
  (checklists) · [UX](docs/UX.md) · [friend-setup](docs/friend-setup.md)
  (put your arm on the hub in 5 steps).

## Quickstart

```sh
bun install
cd apps/driver && uv sync && cd ../..     # python driver (macOS, python 3.12)

# loopback rehearsal of production (two tabs):
bun run hub                                # hub → :3001
bun run rig:sim                            # sim rig → :3000, autoconnects
# open http://localhost:3001 → Take control → Teleop (keys) → WASD/QE
```

Register a rig with the deployed hub:

```sh
HUB_URL=<hub url> RIG_NAME=my-arm LAB_AUTOCONNECT=real \
FOLLOWER_PORT=$(ls /dev/tty.usbmodem* | head -1) bun run agent
```

Drive a rig with your own leader arm:

```sh
apps/driver/.venv/bin/python apps/driver/controller.py \
  --hub <hub url> --rig <rig-name> --port /dev/tty.usbmodemXXXX
```

## Safety model

15°/tick clamp on remote input · 0.5 s deadman (hold pose on silence) · servo
EEPROM limits from the rig OWNER's calibration are the hard stop · e-stop
works for anyone watching, lease or not · torque drops on disconnect.

## Deploy

Railway, config-as-code in `apps/web/railway.toml` (Dockerfile build from the
repo root, 1 replica + no sleep — the rig registry is in-memory by design).
Pushes to `main` deploy automatically.

## Provenance

Grown from [so101-lab](https://github.com/grmkris/so101-lab) — the imitation-
learning lab notebook for the same arm, where the ML track (datasets, ACT/
SmolVLA training, evals) continues to live.
