# web — the hub + the rig agent

TanStack Start (React 19) + Effect v4 HttpApi on Bun. One package, two
entries — see `../../docs/SPEC.md` for architecture, `../../docs/TESTING.md`
for checklists.

## Entries

| Entry | Start | What it is |
|---|---|---|
| hub | `bun run hub` (dev :3001) / `bun run hub:prod` (built) | THE web app — lobby, drive, datasets, trainings; deployed to Railway |
| agent | `bun run agent` | headless rig: python driver + outbound hub link, no UI, no listening port |

Loopback rehearsal of production: `bun run hub` + `bun run rig:sim` (or
`rig:sim:viewer` for a native MuJoCo window, `rig:real` for the arm).
Every script here is also proxied from the repo root (`bun run --cwd apps/web`)
— run them from either place. The `--cwd` matters: the sidecar `.data/`
(owner key, tasks, attempts) is resolved from the process's cwd, so an agent
started from the repo root would build a second, empty one.
Owner actions in the hub UI (camera setup, record, tasks, trainings) need the
rig's owner key — printed by the agent at boot (`.data/owner.json`).

## Env vars

- `HUB_URL` — (agent) which hub the rig dials
- `RIG_NAME` — lobby name (default `local-rig`)
- `LAB_AUTOCONNECT` — `sim` | `real`: bring the backend up at boot
- `HUB_TOKEN` — hub shared secret (unset = open)
- `HF_TOKEN` — (hub) HF API token fallback when no `~/.cache/huggingface/token`
- `FOLLOWER_PORT` / `LEADER_PORT` / `ROBOT_ID` — override `src/api/rig.ts` defaults
- `HUB_LATENCY_MS` / `HUB_DROP_RATE` — hub-side impairment injection
- `LAB_FRAME_MS` — (agent) camera push cadence in ms (default 80 = 12.5 fps)
- `LAB_DRIVER_PYTHON` — driver interpreter override (mjpython for the viewer)
- `PORT` — hub listen port (Railway sets it; default 3000)

## Python driver

Lives in `../driver` (uv env pinned `lerobot==0.6.0`; `uv sync` there once).
Spawned lazily by the agent on the first robot/camera call; ndjson-RPC over
stdio; frames on an OS-assigned localhost MJPEG port.

## Deploy (hub)

`Dockerfile` here, `railway.toml` at the repo root — pushes to `main`
auto-deploy. Live at https://web-production-b5106.up.railway.app.
1 replica + sleep off are load-bearing (in-memory rig registry).

## Dev notes

- API contract: `src/api/contract.ts` → Scalar docs at `/api/docs`. The hub
  serves it GET-only (read-only); writes ride the rig verb pipe
  (`src/hub/verbs.ts`).
- `bun run check` (biome) + `bunx tsc --noEmit` before committing.
- Contract changes need a dev-server restart (the API handler survives HMR on
  purpose).
- shadcn components are vendored under `src/components/ui/` (add via the
  shadcn MCP/CLI from the repo root).
- The WS input plane (`/api/hub/ws`, `src/hub/ws.ts`) needs `Bun.serve`, which
  vite dev does not provide — under `bun run hub` input falls back to the HTTP
  mailbox (by design). Exercise it with `bun run build && bun run hub:prod`.
