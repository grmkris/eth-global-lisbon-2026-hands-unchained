# Proof of Hands — agent context

Crowdsourced SO-101 teleoperation platform (ETHGlobal Lisbon 2026). One bun
monorepo: `apps/web` (TS — the hub web app `src/server.ts` + the portless
headless-rig entry `src/agent.ts`; no `LAB_MODE`, no roles) + `apps/driver`
(Python, pinned `lerobot==0.6.0`). Tasks/attempts: see docs/SPEC.md — tasks are RIG-side,
the hub is a stateless pipe, owner key printed at rig boot.

## How to work here
- Be concise. Read `docs/SPEC.md` before architectural changes — it is kept
  truthful (shipped vs not-built are labeled).
- Checks: `bun run check` (biome) · `bun run typecheck` · `bun run build` ·
  `bun run driver:ast`. All from repo root.
- Commit + push to `origin main` after meaningful changes; pushes deploy.

## Deploy topology
- Railway project **proof-of-hands**, service **web** — GitHub-connected:
  push to `main` → build `apps/web/Dockerfile` with the REPO ROOT as context
  (config-as-code: root `railway.toml`; service root directory must stay
  the repo root).
- 1 replica + sleep off are LOAD-BEARING: the rig registry is in-memory; a
  redeploy wipes it and rigs re-register within ~50 ms (by design).
- Auth: `HUB_TOKEN` env on the service — unset = open (current state).

## Hard-won constraints (do not relearn)
- Everything rides lerobot **0.6.0** — record/train/infer version match is
  sacred; the driver env is `apps/driver/.venv` (`uv sync`).
- Transport is deliberately boring: 20 Hz HTTP polling + MJPEG. Railway has
  no inbound UDP — no self-hosted TURN/SFU there, ever. The one exception is
  the INPUT plane, which rides a WebSocket when available (`src/hub/ws.ts`)
  and falls back to the HTTP mailbox — keep that fallback working.
- lerobot degree zero = mid of calibrated range; the sim maps it to MJCF
  offsets in `backends/sim.py`. wrist_roll zero is calibration-pose-relative
  across devices — known wart, undesigned.
- The `phone` teleop source needs a 2-line lerobot patch absent from a fresh
  `uv sync` (see so101-lab `phone_teleop/README.md`).
- Serial ports/robot id default to Kristjan's arms — override with
  `FOLLOWER_PORT` / `LEADER_PORT` / `ROBOT_ID`.
