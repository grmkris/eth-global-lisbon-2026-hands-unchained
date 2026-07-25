# Proof of Hands — spec

Crowdsourced teleop platform grown out of a LeLab-replacement lab tool. One
deployed web app (the hub) + headless rig agents:

1. **The platform** — registered rigs (real arms + MuJoCo sims) streaming to a
   deployed hub; operators browse a lobby, take a rig, and drive it with a
   keyboard or their own leader arm; owners run the whole data flywheel
   (cameras → record → datasets → train) from the same pages via owner verbs.
   **Live: https://web-production-b5106.up.railway.app**
2. **The lab tool is those same hub pages** — there is no separate local
   console; every lab capability rides the rig verb pipe.

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

## Architecture — one web app (the hub) + portless agents
```
apps/
  web/      ONE TypeScript app: TanStack Start (React 19, Router, Query,
            shadcn) + Effect v4 HttpApi. Bun. Dockerfile + railway.toml.
            Two entries: src/server.ts (the hub) · src/agent.ts (a rig).
  driver/   Python, uv env pinned lerobot==0.6.0 — robot loops only.
            backends/{real,sim}.py · sources/{keys,phone,scripted,remote}.py
            controller.py (operator-side leader-over-wire bridge)
```
No `LAB_MODE`, no roles:
- **hub** (`src/server.ts`, the only web server) — lobby/drive UI + relay +
  READ-ONLY (GET-gated) datasets/trainings straight off the HF Hub API,
  including remote-parquet episode report cards (no lerobot cache needed).
  Serves `/api/mode` (healthcheck fossil), `/api/hub/*` and a GET-only
  allowlist (health/docs/openapi + datasets/runs/hf prefixes); everything
  else 404s — all writes ride the rig verb pipe. Railway: 1 replica, sleep
  off — both load-bearing (in-memory registry).
- **agent** (`src/agent.ts`, plain bun) — the entire on-machine rig
  footprint: python driver + outbound link, in-process API, NO LISTENING
  PORT. `LAB_AUTOCONNECT=sim|real` brings the backend up at boot.
  `bun run agent` / `rig:sim` / `rig:real`.

Server entry `src/server.ts`: explicit `PORT` env (Railway) / 3000 default;
serves `dist/client/assets` itself in prod (TanStack Start ships no static
middleware); allowlisted `/api/*` → Effect HttpApi handler; rest → SSR.

### Hub ↔ rig ↔ operator (the platform wire)
- **Rig dials OUT** (`src/rig/link.ts`): self-scheduling 50 ms link tick
  (telemetry up, control down on the response) + 80 ms frame push
  (`LAB_FRAME_MS`, 12.5 fps preview). No inbound ports, no reconnect logic —
  re-registration after a hub restart is implicit.
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
- **Leader-over-wire** (`apps/driver/controller.py` = the LEADER AGENT → hub
  → `sources/remote.py`): symmetric to the rig agent — `bun run teleop`
  auto-detects the leader's port, connects it, and registers on the hub's
  `leaders` registry (dial-out heartbeat `/api/hub/leaders/link`, in-memory,
  redeploy self-heals). A leader is **a bound input device of a browser
  session, never a lease holder**: "Drive with <name>'s leader" requires the
  clicking browser to already hold the rig, and binds the leader to that
  clientId (`boundTo`/`rig` in the leader registry). The hub then queues
  `{drive, rig}` for the agent (consume-once, 15s TTL) and `teleop_start_remote`
  for the rig itself — the agent claims nothing and sends no verbs. Input from
  `leader-<name>` is accepted iff `boundTo === leaseHolder(rig)`, and never
  renews the lease; the browser's own 5 s claim interval keeps it alive, so a
  dead browser expires it in ≤20 s and the leader's input starts 403ing. Why it
  matters: the operator stays the lease holder throughout, so **task attempts
  and a leader coexist** (record source `remote`), and take-over is just the
  lease changing — the agent sees a 403 or `bound: false` on its next heartbeat
  and idles. Streams the leader's lerobot-space dict (degrees + gripper 0..100)
  at 30 Hz; values clamped + non-finite dropped on the rig BEFORE lerobot.
  Cross-device works by construction (each end normalizes through its own
  calibration); known wart: wrist_roll zero is calibration-pose-relative
  across devices.

### Tasks + attempts (the crowdsourcing loop)
Tasks live RIG-SIDE (`.data/tasks.json`, `tasks-registry.ts`) and are
advertised over the link via rev-echo (full array only when the hub's echoed
rev mismatches — a hub redeploy self-heals in ~100ms; the hub stays a
stateless pipe). The owner key is auto-generated at first boot, printed to
the rig terminal, relayed OPAQUELY through the hub and validated only rig-
side (timing-safe). Verb table rows carry `args` allowlists + `owner` /
`stampsHolder` tiers; commands get a 15s TTL + queue cap (a stale
teleop_start firing on link resume was a hazard class).

An **attempt** = one operator try = ONE recorded episode: `attempt_start
{taskId}` starts a 1-episode record session with the task's parameters (the
lerobot per-frame task string = task title — the label rides natively in the
dataset; the operator identity = lease holder, stamped by the hub, not
spoofable). Success → `keep` (episode saved); Discard → the new `discard`
control (buffer cleared, session ends, nothing saved — saved episodes are
never touched). A watcher handles the rest: spin-up grace (dataset create
looks like session-end for ~2s), 30s holder-loss → abandon + discard,
timeout → lerobot's auto-save semantics, teleop auto-restored with the
operator's prior source (except after driver failure). Outcomes append to
`.data/attempts.json` {task, operator, outcome, timestamps}; episode ground
truth stays in the dataset itself.

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
{backend: real|sim}` picks who answers — callers never know the
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
- Hub lab pages (all over the rig verb pipe — owner key required): camera
  setup (probe/preview/confirm on the drive page), free-form record panel
  (sources: leader/keys/phone*/scripted, live HUD from telemetry), datasets
  (Hub merge + remote-parquet episode report cards, length-outlier flags,
  exclude-list builder), trainings (rig-advertised runs ∪ imported Hub
  models, lineage, client-generated Colab cell, HF ckpt polling).
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
