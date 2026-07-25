# Lab Console

TanStack Start (React 19) + Effect v4 HttpApi on Bun. One build, three roles —
see `../SPEC.md` for architecture, `../TESTING.md` for checklists.

## Roles

| Role | Start | What it is |
|---|---|---|
| console (default) | `bun run dev` → :3000 | local lab tool (robot, record, datasets, trainings) |
| hub | `bun run hub` (dev :3001) / `bun run hub:prod` (built) | lobby + relay — the thing deployed to Railway |
| agent | `bun run agent` | headless rig: local API + hub link, no UI |

Loopback rehearsal of production: `bun run hub` + `bun run rig:sim` (or
`rig:sim:viewer` for a native MuJoCo window, `rig:real` for the arm on :3002).

## Env vars

- `LAB_MODE` — `hub` | `agent` | unset (console)
- `HUB_URL` — registers this process as a rig with that hub
- `RIG_NAME` — lobby name (default `local-rig`)
- `LAB_AUTOCONNECT` — `sim` | `real`: bring the backend up at boot
- `HUB_TOKEN` — hub shared secret (unset = open)
- `FOLLOWER_PORT` / `LEADER_PORT` / `ROBOT_ID` — override `src/api/rig.ts` defaults
- `HUB_LATENCY_MS` / `HUB_DROP_RATE` — hub-side impairment injection
- `LAB_DRIVER_PYTHON` — driver interpreter override (mjpython for the viewer)
- `PORT` — listen port (Railway sets it; default 3000)

## Python driver

Lives in `../driver` (uv env pinned `lerobot==0.6.0`; `uv sync` there once).
Spawned lazily on the first robot/camera call; ndjson-RPC over stdio; frames
on an OS-assigned localhost MJPEG port.

## Deploy (hub)

`Dockerfile` + `railway.json` here. From this directory:
`railway up --service hub --detach` — live at
https://hub-production-3903.up.railway.app. 1 replica + sleep off are
load-bearing (in-memory rig registry).

## Dev notes

- API contract: `src/api/contract.ts` → Scalar docs at `/api/docs`.
- `bun run check` (biome) + `bunx tsc --noEmit` before committing.
- Contract changes need a dev-server restart (the API handler survives HMR on
  purpose).
- shadcn components are vendored under `src/components/ui/` (add via the
  shadcn MCP/CLI from the repo root).
