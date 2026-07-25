# Lab Console — spec

Web app replacing phosphobot/LeLab for this lab, grown into a small teleop
platform. Two products in one build:

1. **The lab tool** — run the data flywheel with quality gates: control →
   guided record → grade → train → eval, for the SO-101 on this Mac, lerobot 0.6.0.
2. **The platform** — registered rigs (real arms + MuJoCo sims) streaming to a
   deployed hub; operators browse a lobby, take a rig, and drive it with a
   keyboard or their own leader arm. **Live: https://hub-production-3903.up.railway.app**

> History note: v0 of this spec listed "multi-robot, cloud hosting, auth" as
> non-goals. The platform pivot inverted that — those are now shipped. Still
> out of scope: other robot types, mobile UI, phosphobot pro features.

## Principles (encode the hard-won levers)
1. **Thin wrapper over lerobot 0.6.0.** The driver imports lerobot classes
   in-process from a pinned env (`apps/driver/pyproject.toml`). Never
   reimplement drivers, calibration math, or dataset format.
2. **Quality gates are the product** (lab tool side). Camera confirm +
   brightness band shipped; the fuller preflight/coach is roadmap (below).
3. **Never destructive.** No episode deletion; exclusion lists only.
4. **No database.** HF Hub + the local lerobot cache ARE the state, plus thin
   sidecar JSON (`apps/web/.data/`) for what the Hub can't hold. The hub's
   rig registry is deliberately in-memory — a redeploy costs one re-register.
5. **Boring transports.** 20 Hz HTTP polling + MJPEG re-serve, curl-debuggable,
   identical in dev and prod. No WebSocket/WebRTC until a measured need; the
   single planned upgrade lever is a WS relay if teleop feel demands it.

## Architecture — one build, three roles
```
apps/
  web/      ONE TypeScript app: TanStack Start (React 19, Router, Query,
            shadcn) + Effect v4 HttpApi. Bun. Dockerfile + railway.toml.
  driver/   Python, uv env pinned lerobot==0.6.0 — robot loops only.
            backends/{real,sim}.py · sources/{keys,phone,scripted,remote}.py
            controller.py (operator-side leader-over-wire bridge)
```
Role from `LAB_MODE` at boot (`src/api/config.ts`):
- **hub** — lobby/drive UI + relay. Serves `/api/mode`, `/api/hub/*`, and an
  allowlist (`/api/health`, `/api/docs`, `/api/openapi.json`); every other
  `/api/*` 404s (no arm, no cameras, no cache there). Deployed on Railway:
  1 replica, sleep off — both load-bearing (in-memory registry).
- **console** (default) — the local lab tool; setting `HUB_URL` also registers
  it as a rig.
- **agent** — headless rig: local API + rig link, serves no UI.
  `LAB_AUTOCONNECT=sim|real` brings the backend up at boot.

Server entry `src/server.ts`: explicit `PORT` env (Railway) / 3000 default;
serves `dist/client/assets` itself in prod (TanStack Start ships no static
middleware); `/api/*` → Effect HttpApi handler; rest → SSR.

### Hub ↔ rig ↔ operator (the platform wire)
- **Rig dials OUT** (`src/rig/link.ts`): self-scheduling 50 ms link tick
  (telemetry up, control down on the response) + 125 ms frame push. No inbound
  ports, no reconnect logic — re-registration after a hub restart is implicit.
- **Hub is a pipe, not a repeater** (`src/hub/routes.ts`, `store.ts`): input is
  latest-wins, consume-once, dropped after 500 ms — the deadman. Injectable
  impairment (`HUB_LATENCY_MS`, `HUB_DROP_RATE`) so loopback dev matches WAN.
- **Verb table** (`src/hub/verbs.ts`): the complete surface an operator can
  trigger — connect/teleop/stop/estop. One table; the hub allowlist and the
  rig dispatch both derive from it. NOT a general tunnel: a guest can never
  reach `/api/record/*` on someone's machine.
- **Lease** = single writer per rig (random per-tab clientId, 20 s expiry,
  renewed by input/claim). Safety verbs (`estop`, `teleop_stop`) bypass it;
  "Take over" force-steals it (friends-tier trust).
- **Auth** (`src/hub/auth.ts`): shared secret `HUB_TOKEN` — bearer header
  (API/rig link), cookie (MJPEG `<img>` + sendBeacon can't set headers), query
  param (curl debug). Unset ⇒ open. **Currently unset.** Real identity is a
  later problem; the lease is collision avoidance, not security.
- **Leader-over-wire** (`apps/driver/controller.py` → hub → `sources/remote.py`):
  operator's leader read at 30 Hz, lerobot-space dict (degrees + gripper
  0..100) over one kept-alive HTTPS connection (~16 packets/s WAN). Values
  clamped + non-finite dropped on the rig BEFORE lerobot. Cross-device works
  by construction (each end normalizes through its own calibration); known
  wart: wrist_roll zero is calibration-pose-relative across devices.

### Safety model (remote driving)
15°/tick clamp on synthetic sources (only a rig-local leader runs uncapped) ·
0.5 s hub deadman (hold pose) · servo EEPROM limits from the OWNER's
calibration are the hard stop · e-stop for anyone, lease or not ·
`disable_torque_on_disconnect` ⇒ network drop = arm goes limp.

### Driver protocol
ndjson-RPC over stdio (TS sends `{cmd, config}`, driver emits
`ready/status/joints/robot_state/record_state/episode_saved/error`). Frames on
an OS-assigned localhost MJPEG port reported in `ready` (several rigs per
machine). Spawn is lazy on first RPC; crash → next RPC respawns. `connect
{backend: real|sim}` picks who answers — the console never knows the
difference. Leader arm attach is optional on BOTH backends: attach failure
warns and comes up follower-only (headless agents get one autoconnect attempt).

### Effect architecture (server, as built)
Services (`Context.Service` — correct for the pinned `effect@4.0.0-beta.101`;
one static `layer` each, composed once in `src/api/live.ts`, stashed on
`globalThis` so Vite HMR can't double-init):
- `HfHub` — HF JSON API via `HttpClient`; token from `~/.cache/huggingface`,
  degrades to unauthenticated.
- `DatasetCatalog` — local cache scan (meta/info.json + hyparquet) + Hub merge;
  sim-dataset tags in sidecar.
- `RunsRegistry` — training runs + lineage in sidecar JSON; Hub models
  auto-imported; version-matched Colab cell generation; ckpt polling.
- `Cameras` — probe/preview/confirm + brightness band; mapping persisted in
  sidecar.
- `RobotSvc`, `Recorder` — state machine + session control over the driver.
- `DriverManager` — the Python subprocess singleton (spawn, ndjson decode,
  RPC correlation, `error`/`exit` recovery). The load-bearing seam: everything
  above it is written against 6 methods.

Domain: `Schema.Class` records, `Schema.TaggedErrorClass` errors
(`DriverError`, `PreflightError`), typed per-endpoint errors — no blanket
`catchAll`. Contract = `HttpApi` in `src/api/contract.ts`; the frontend uses a
derived `HttpApiClient` (no hand-written fetch); OpenAPI at `/api/openapi.json`,
Scalar at `/api/docs`. **The contract file + `/api/docs` are the API reference —
this spec doesn't duplicate the route list.** Raw routes beside the contract:
`/api/hub/*` (relay) and `/api/cams/*` (MJPEG passthrough).

Honest deviations from full Effect idiom (next-iteration candidates, not
accidents): env config read directly (`src/api/config.ts`, `src/api/rig.ts`)
instead of `Config`; no `Effect.fn` spans; no test layers/vitest yet; driver
subprocess is a plain class, not a scoped `Command` resource.

## Shipped (v1)
- Local console: robot page (connect/teleop/e-stop, joint grid, cam previews),
  record wizard + HUD (sources: leader/keys/phone*/scripted), datasets
  (local+Hub merge, episode table, length-outlier flags, exclude-list
  builder), trainings (registry, lineage, Colab cell, Hub ckpt polling).
  *phone source currently broken — driver venv lacks the lerobot patches
  (the phone-patch note in `docs/TESTING.md`).
- Platform: deployed hub, lobby, drive page (cams, jog pad, take/steal
  control, safety buttons for bystanders, fault surfacing), headless agents,
  sim + real rigs side by side, leader-over-wire, token auth (off), friend
  onboarding (`docs/friend-setup.md`).
- Sim backend: MuJoCo Menagerie scene, gripper-mounted wrist cam, lerobot-
  frame joint mapping (degrees-from-mid ↔ MJCF offsets), scripted expert,
  optional native viewer (`LAB_SIM_VIEWER=1` + mjpython), records real
  LeRobot datasets. NOT sim2real — plumbing, practice, demo insurance.

## Not built yet (the honest roadmap)
- **Report card v1**: coverage heatmap (threshold+minAreaRect over first
  frames), orientation histogram, brightness-vs-band flags, episode health
  beyond length outliers.
- **Coach** (guided recording): workspace grid via 4-corner homography,
  least-covered-bin prompts, prompted-vs-actual logging.
- **Preflight gate**: hard-block recording on cam-confirm/brightness/
  calibration-age/disk; today only cam confirm + brightness banner exist.
- **Journal draft** on session end (one-click append, never silent).
- **Rollout/eval + DAgger UI**: eval matrix (position×orientation), DAgger
  sessions feeding child training runs. CLI (`lerobot-rollout`) until then.
- **Extend flow**: contract supports `resume`; UI hardcodes new-dataset.
- **Operator recording** (the crowdsourced-data product): task assignment +
  record verbs over the hub — deliberately absent until identity exists.
- Platform hardening: real identity/auth-on, queued-command TTL (stale hub
  commands currently deliver on rig re-register), WS relay if feel demands.

## Risks / open questions (current)
- Hub state is one process — fine at friends-scale; revisit before >~10 rigs.
- MJPEG through Railway's edge verified at 8 fps; long-stream idle cuts not
  yet observed — CamFeed `/snap` polling is the fallback if they appear.
- so101-nexus was evaluated and NOT adopted (own Menagerie glue instead).
- Cross-device wrist_roll zero handshake still undesigned (bites at the first
  friend-leader → real-arm session).
