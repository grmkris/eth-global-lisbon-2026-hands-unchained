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
  datasets, trainings, tasks/attempts) and **the agent**
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
# open http://localhost:3001 → Drive with keyboard → WASD/QE
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
operator: pick how to drive (keyboard / their leader) → Start attempt → do the task
        → ✓ Success (episode saved)  /  ✗ Discard (buffer dropped)
dataset: grows episode by episode, labeled, on the rig owner's machine
```

Drive a rig with your own leader arm (also zero config — port auto-detected,
registers under your hostname; then click "Drive with your leader" on any
rig's drive page):

```sh
bun run teleop
# already driving a rig? Stop teleop on its page first — the driver refuses a
# second session, so the remote source would never start.
```

## The market — verified humans, graded work, real payment

`MARKET_MODE=1` turns the platform into a labor market. The loop above has
one honest hole: **success is self-declared** — the operator clicks ✓ and the
episode counts. The moment strangers get *paid* for this, that hole (and two
others) must close, one per sponsor:

| Hole | Fix |
|---|---|
| Operator identity is a random per-tab `clientId` — sybils get execution rights on physical hardware | **World ID** gates lease acquisition. Unverified → **HTTP 402**, arm stays locked. |
| The worker grades their own paid work | **0G Compute** is the referee: a TEE-attested model judges the telemetry, and its verdict — not the operator — decides payment. |
| A $0.50 work unit every 20 s fits no invoice or bank rail | **Hedera**: HBAR bond + per-episode bonus, sub-cent fees, HCS audit trail. |

```
verify (World ID, 18+ & live)  →  lease granted
  ↓ first attempt                 bond 0.5 ℏ  operator → escrow
drive · attempt · claim ✓/✗
  ↓ hub-observed telemetry (motion, gripper, episode-saved — unforgeable)
0G Compute referee  →  {score, pass, teeVerified}
  ↓ pass                          bonus 0.5 ℏ  treasury → operator   (autonomous)
  ↓ fail after claiming success   bond SLASHED escrow  → treasury
anchor: HCS digest · 0G Storage root · EpisodeRegistry event
```

Every payment is submitted by the settlement worker on the referee's verdict —
no human clicks pay. The `/market` dashboard shows each attempt with its
grade, TEE badge, payout link and evidence frame.

**Per-sponsor detail:** [WORLD](docs/market/WORLD.md) (gate + Identity Check
testing docs) · [HEDERA](docs/market/HEDERA.md) (payment flow mechanics) ·
[0G](docs/market/0G.md) (proof of inference + contract).

Live testnet artifacts:

| What | Where |
|---|---|
| HCS provenance topic | [`0.0.9746374`](https://hashscan.io/testnet/topic/0.0.9746374) |
| EpisodeRegistry (0G Galileo, 16602) | [`0x80669DE19A96F0004adbC3C81c528Ef1abB9a494`](https://chainscan-galileo.0g.ai/address/0x80669DE19A96F0004adbC3C81c528Ef1abB9a494) |
| Example autonomous payout | [`0.0.9700388-1784993892-227625527`](https://hashscan.io/testnet/transaction/0.0.9700388-1784993892-227625527) |

Off by default: with `MARKET_MODE` unset the platform behaves exactly as the
sections above describe — no gate, no chain, no market.

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
