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
            │ apps/web src/agent.ts + apps/driver   │  no ports, no NAT config
            │ → MuJoCo sim  OR  real SO-101 arm     │
            └───────────────────────────────────────┘
   controller.py ── your leader arm ──▶ hub ──▶ any rig   (leader-over-wire)
```

## Layout

- `apps/web` — one TypeScript app (TanStack Start + Effect v4, Bun), two
  entries: **the hub** (`src/server.ts`, the deployed web app — lobby, drive,
  datasets, trainings, camera setup, recording) and **the agent**
  (`src/agent.ts`, a headless rig). Every owner action reaches the rig over
  the hub's verb pipe — nothing runs locally but the agent.
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
bun run rig:sim                            # headless sim rig (no port), autoconnects
# open http://localhost:3001 → Take control → Teleop (keys) → WASD/QE
```

Register a rig with the deployed hub (zero config — hub URL is the baked-in
default, follower port auto-detected, rig named after your hostname):

```sh
cd apps/web
LAB_AUTOCONNECT=real bun run agent
# headless: no UI, no listening port — the rig only dials out.
# The terminal prints your RIG OWNER KEY — you need it to define tasks.
```

## Tasks — the point of all this

The rig owner defines a task on the drive page ("push the cube into the
corner"); operators who take the rig attempt it. **Each successful attempt
is one labeled lerobot episode** (the task title is the per-frame label) in
the task's dataset — crowdsourced training data with per-episode operator
provenance (`.data/attempts.json` on the rig).

```
owner: task_upsert (owner key) ──▶ task card in lobby + drive
operator: Take control → drive → Start attempt → do the task
        → ✓ Success (episode saved)  /  ✗ Discard (buffer dropped)
dataset: grows episode by episode, labeled, on the rig owner's machine
```

Drive a rig with your own leader arm (also zero config — port auto-detected,
registers under your hostname; then click "Drive with your leader" on any
rig's drive page):

```sh
cd apps/web && bun run teleop
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
