# PLAN: teleop latency + the 20-episode task loop

> **STATUS (2026-07-25): implemented and deployed.** Phase A `fd6747c`,
> B `ed19adc`, C `dbb0ae4`, D `d347b50` (+ `76a760e`). Checkpoints A/B/C/D
> passed on loopback and against the deployed hub (24 packets/s over the socket
> vs 10/s over HTTP at a 30 Hz target). Deviations, all documented in the
> commits and in `docs/SPEC.md`:
> - Phase B needed one unplanned driver fix: `sources/ee_chain.py`'s
>   `make_input_source` had no `remote` branch, so recording with a bound
>   leader failed with "unknown input source: remote" — the acceptance test.
> - `TaskInfo.episodesDone` is `Schema.optional` (not `NullOr`): a required
>   field would break decoding of existing `tasks.json` rows and of the owner
>   panel's upsert payload.
> - Auto-continue fires ONCE per finished attempt instead of retrying on every
>   telemetry flip — the checkbox only exists on the active-attempt card, so a
>   self-retrying chain could not be turned off.
>
> Still owed (needs hardware + a human present): Checkpoint B row 6 and
> Checkpoint D row 2, both real-arm/real-leader reruns.

Implementation plan for a fresh agent session. Written 2026-07-25 after the
leader-agent feature landed (commit `4a01a0a`). Everything referenced below is
committed and deployed. Work through the phases IN ORDER — each is
independently committable and ends with a checkpoint. Commit + push after each
phase (pushes auto-deploy to Railway).

## Read first

- `AGENTS.md` (repo conventions), `docs/SPEC.md` (architecture — trust it,
  it's kept truthful).
- Deployed hub: **https://web-production-b5106.up.railway.app** (also baked as
  `DEFAULT_HUB` in `apps/web/src/lib/constants.ts` and mirrored in
  `apps/driver/controller.py`).
- Checks after every phase, from `apps/web`:
  `bunx biome check --write src && bunx tsc --noEmit && bun run build`
  and from `apps/driver`:
  `for f in *.py backends/*.py sources/*.py; do .venv/bin/python -c "import ast; ast.parse(open('$f').read())" || echo "FAIL $f"; done`
- Loopback test rig: terminal 1 `bun run hub` (:3001), terminal 2
  `bun run rig:sim` (sim rig `kris-sim`, autoconnects). Owner key is printed
  at agent boot and stored in `apps/web/.data/owner.json`.
- Kill leftovers before restarting: `lsof -ti :3001 | xargs kill -9`,
  `pkill -f "src/agent.ts"`, `pkill -f controller.py`. Zombie dev processes
  poison hub state — always clean first.
- **Effect v4 beta pinned `effect@4.0.0-beta.101`**: services are
  `Context.Service` (NOT `ServiceMap` — ignore any skill/doc saying
  otherwise), background fibers via `Effect.forkDetach`, fallbacks via
  `Effect.catch`/`Effect.orElseSucceed`. Copy the style of the existing
  services in `apps/web/src/api/services/`.
- This plan's line numbers were correct at `4a01a0a`; re-grep if drifted.

## The problem being solved

1. **Teleop lag over the hub** (~100–180 ms felt): (a) the leader agent sends
   one HTTP POST at a time over a keep-alive connection → ~15 packets/s
   (66 ms quantization); (b) the rig only *polls* for input on its 50 ms link
   tick (0–50 ms added jitter); (c) physical RTT to Railway (unavoidable).
   Fix: event-driven input over WebSockets (Phase D). WS makes the
   "overlap several HTTP connections" idea obsolete — do NOT implement that.
2. **Camera feed ~8 fps**: the rig pushes JPEG frames every 125 ms by
   hardcoded constant. Fix: faster, env-tunable cadence (Phase A).
3. **Task attempts don't work with a remote leader**: an attempt is bound to
   the browser's lease, but the leader agent force-claims the lease when it
   drives, so the browser can no longer send `attempt_start`/`attempt_finish`
   (hub 403s non-holders). Fix: make the leader a *bound input device* of the
   browser session instead of a lease holder (Phase B).
4. **No episode-progress loop**: tasks have `maxEpisodes` but the UI shows no
   "13/20 collected", and each next episode needs a manual re-click.
   Fix: advertise `episodesDone`, render progress, auto-continue (Phase C).

---

## Phase A — camera frame cadence (tiny)

File: `apps/web/src/rig/link.ts` lines 16-17:

```ts
const LINK_MS = 50; // 20 Hz control
const FRAME_MS = 125; // 8 fps preview — the recording stays full-rate locally
```

Change `FRAME_MS` to `Number(process.env.LAB_FRAME_MS || 80)` (12.5 fps
default; two 640×480 JPEG streams ≈ 1 MB/s upload — fine). Keep the comment
truthful. Document `LAB_FRAME_MS` in `apps/web/README.md` env-vars list.

**Checkpoint A**: loopback hub + rig:sim; count frames for 5 s:
`curl -s -N --max-time 5 "http://localhost:3001/api/hub/cams/kris-sim/workspace_cam" | grep -c "Content-Type: image/jpeg"`
→ expect ≥ 55 (was ~40).

---

## Phase B — leader becomes a bound input device (no more lease stealing)

### Semantics (the whole point)

Today (`controller.py` `drive()`): leader force-claims the rig lease with
clientId `leader-<name>`, sends `teleop_start_remote`, streams, releases.
New model: **the BROWSER keeps the lease**; commanding "drive" *binds* the
leader to that browser's session; the hub accepts the leader's input packets
whenever its bound browser currently holds the lease. Teleop start/stop is
queued by the hub, stamped with the browser holder. Consequences: attempts
work unchanged with a leader driving (operator = browser holder throughout),
take-over/expiry semantics stay exactly what leases already do, and
`controller.py` shrinks to a pure input streamer.

### Hub changes

`apps/web/src/hub/store.ts` — `Leader` interface: add
`boundTo: string | null` (the browser clientId this leader drives for) and
`rig: string | null` (which rig). Clear both on `stop`. `upsertLeader`
keeps them across heartbeats (do NOT wipe on each link tick — only the
command endpoints mutate them).

`apps/web/src/hub/routes.ts`:

1. `POST /leaders/:name/command` (added at `4a01a0a`, search `leaderMatch`):
   - `action: "drive"` now REQUIRES `clientId` in the body and that
     `leaseHolder(rig) === clientId` (403 `"take control first"` otherwise).
     Then: set `leader.boundTo = clientId`, `leader.rig = rig.name`, queue
     the pending `{action:"drive", rig}` for the leader agent AND push
     `{verb: "teleop_start_remote", holder: clientId, queuedAt: Date.now()}`
     onto `rig.pending` directly (the hub is allowed to enqueue — same shape
     as the `/command` branch builds).
   - `action: "stop"`: clear `boundTo`/`rig`, queue `{action:"stop"}` for the
     leader, and push `{verb: "teleop_stop", holder: null, queuedAt}` onto
     `rig.pending` (teleop_stop is a safety verb — fine).
2. `POST /rigs/:rig/input` (search `action === "/input"`): current rule is
   `leaseHolder(rig) !== clientId → 403`. Add the binding branch: if
   `clientId` starts with `"leader-"`, look up
   `getLeader(clientId.slice("leader-".length))`; accept IFF
   `leader.rig === rig.name && leader.boundTo !== null &&
   leader.boundTo === leaseHolder(rig)`. Do NOT renew the lease on the
   leader path (the browser's own 5 s claim interval keeps it alive; if the
   browser dies, the lease expires in ≤20 s and the leader's input starts
   403ing — that's the intended kill switch).

### Leader agent changes (`apps/driver/controller.py`)

In `drive()`: DELETE the claim / `teleop_start_remote` / release / stop-verb
calls (the hub + browser own those now). The function becomes: stream
`{clientId: leader-<name>, joints}` to `/rigs/<rig>/input` at `--hz`, with
the existing heartbeat-every-15-packets (`/leaders/link {driving: rig}`)
checking for the stop command, and: 403 from input → print
`lost <rig> (control changed) — back to idle` → return. Ctrl-C while driving
→ just return (loop exit); NO release call (nothing was claimed). Keep the
rig `online` pre-check GET. Keep everything else (port detect, registration
loop) untouched.

### Web UI changes (`apps/web/src/routes/drive.$rig.tsx`)

- `sendLeaderCommand` in `apps/web/src/lib/hub-api.ts`: the underlying `post`
  helper already includes `clientId` in every body — verify it reaches the
  leader command endpoint (it does: `post()` spreads `{clientId, ...body}`).
  Nothing to change client-side for auth.
- The "Drive with X's leader" buttons already render only inside the
  `iAmDriving` block — correct, keep.
- Status text: the holder now STAYS the browser while a leader drives, so the
  `holderLeader` mapping (holder === `leader-<name>`) is dead — remove it.
  Instead: when `drivingLeader` (a leader with `driving === rigName`) exists
  and `iAmDriving`, show "you are driving — via <name>'s leader" in the
  StatusBadge. Keep the "Stop <name>'s leader" button as is.
- The KeyJogPad renders while a leader drives (you're still the holder).
  That's acceptable — keyboard axes and leader joints are latest-wins on the
  same mailbox; note it, don't fix it.
- `leadersQuery` summary: add `boundTo` if useful for display; optional.

### Checkpoint B (curl, loopback, no leader hardware needed for most)

1. Fake leader: `curl -X POST :3001/api/hub/leaders/link -d '{"name":"fake","driving":null}'` → registered.
2. Browser-less lease: `claim` rig as `op-test`, then
   `POST /leaders/fake/command {"clientId":"op-test","action":"drive","rig":"kris-sim"}`
   → 200; rig summary: holder STAYS `op-test`, armState flips to teleop
   (source `remote`) within ~1 s.
3. `POST /rigs/kris-sim/input {"clientId":"leader-fake","joints":{...}}` →
   200 (binding accepted). Same with `clientId:"leader-other"` → 403.
4. `attempt_start` as `op-test` (needs a task — create via owner verb, key in
   `.data/owner.json`) while the fake leader is bound → attempt starts,
   operator = `op-test`. `attempt_finish {"success":true}` → episode kept.
   **This is the acceptance test: attempt + leader coexist.**
5. Stop command → binding cleared, next leader input → 403.
6. Real-arm rerun (user present): `bun run teleop` + browser flow from
   `docs/TESTING.md` §4 rows 3-4 — take-over now reads "control changed".

Update `docs/SPEC.md` leader-over-wire paragraph (it currently says the agent
force-claims) and `docs/TESTING.md` row 4 wording.

---

## Phase C — the 20-episode loop

### C1: advertise progress

`apps/web/src/api/contract.ts` `TaskInfo` (~line 326): add
`episodesDone: Schema.NullOr(Schema.Number)`.

`apps/web/src/api/services/tasks-registry.ts` `list()`: for each task, read
`${os.homedir()}/.cache/huggingface/lerobot/${RIG.hfUser}/${task.repoName}/meta/info.json`
(FileSystem service, `Effect.orElseSucceed(() => null)`) and set
`episodesDone` = its `total_episodes` (null when unreadable — dataset not
created yet). This is the same source `attempts.ts:212-223` already uses for
the quota check, just surfaced. A few tasks × one small JSON read per call is
cheap; `list()` is hit by the rig's 2 s `refreshTasks` loop.

`apps/web/src/rig/link.ts` `refreshTasks`: the advertisement rev is a hash of
the task array — `episodesDone` is now part of it, so every saved episode
re-advertises automatically. Verify the rev function hashes the whole task
objects (it does — `rev(value)` djb2 over JSON).

### C2: render progress + completion

`apps/web/src/components/task-panel.tsx` idle card (lines ~89-116):
- Replace the `max ${task.maxEpisodes} eps` text with a `Progress` bar
  (component exists, see `trainings.$runId.tsx` usage) +
  `{task.episodesDone ?? 0}/{task.maxEpisodes}` mono label when
  `maxEpisodes` is set; plain `{episodesDone ?? 0} eps collected` otherwise.
- `const complete = task.maxEpisodes !== null && (task.episodesDone ?? 0) >= task.maxEpisodes`
  → button disabled + a `StatusBadge tone="success"` "complete ✓". (The rig
  also hard-blocks at `attempts.ts:212-223` — this is just honest UI.)
- Button label: `Start attempt` → `Start attempt (${(task.episodesDone ?? 0) + 1}/${task.maxEpisodes})`
  when maxEpisodes set.

### C3: auto-continue

In `task-panel.tsx`: add local state `autoContinue` (a `Checkbox` labeled
"auto-start next attempt", shown on the active-attempt card AND remembered
across the attempt via component state — the panel stays mounted). Chain
logic: `useEffect` that fires when `autoContinue && lastTaskId !== null &&
!attempt?.active && !recording && !complete(lastTask)` → call
`onStart(lastTaskId)` ONCE (guard with a `firedForRef` storing the previous
attemptId so it can't loop). Set `lastTaskId` when the user clicks Start or
Success. The recorder needs a beat to close the old session —
`attempt_start` is refused while `recorder.status().active`
(`attempts.ts:200`), and `recording` comes from the 500 ms rigQuery, so
gating on `!recording` is exactly right; if the verb still races and fails,
`lastCommandResult` surfaces it and the effect retries on the next telemetry
flip (acceptable).

### Checkpoint C (loopback, sim)

1. Owner-create a task with `maxEpisodes: 3` on `kris-sim`.
2. Card shows `0/3` + bar. Start attempt (keyboard) → Success → card returns
   showing `1/3` within ~4 s (save + 2 s advert).
3. Tick auto-continue → Success → next attempt starts by itself after the
   save closes; run to 3/3 → "complete ✓", button disabled, rig-side start
   refusal message if forced via curl.
4. `.data/attempts.json` rows: 3 successes, operator = your clientId.

---

## Phase D — WebSocket input plane (do LAST; everything must work without it)

**Scope discipline: the WS carries ONLY input frames.** Telemetry, commands,
verbs, leases, frames, leader heartbeats all stay on HTTP exactly as they
are. If the WS is down, input falls back to the existing HTTP mailbox path —
same behavior as today, just slower. No protocol version, no migration.

### D1: hub — accept WS connections

`apps/web/src/server.ts`: the default export is a Bun.serve config. Add the
second `server` parameter to `fetch(request, server)` and a `websocket`
handler object. Upgrade branch BEFORE other /api routing:

```ts
if (url.pathname === "/api/hub/ws") {
  if (!hubAuthorized(request, url)) return json({ error: "unauthorized" }, 401);
  const role = url.searchParams.get("role"); // "rig" | "leader"
  const name = url.searchParams.get("name");
  if ((role !== "rig" && role !== "leader") || !name)
    return json({ error: "role and name required" }, 400);
  if (server.upgrade(request, { data: { role, name } })) return undefined as never;
  return json({ error: "upgrade failed" }, 400);
}
```

(Bun: returning `undefined` after a successful upgrade is required; type it
pragmatically.) The `websocket` handlers delegate to a new module
`apps/web/src/hub/ws.ts`:

```ts
// hub/ws.ts — input-plane socket registry (globalThis-stashed like store.ts,
// so Vite HMR can't double-init)
rigSockets: Map<string, ServerWebSocket>     // rig name -> socket
leaderSockets: Map<string, ServerWebSocket>  // leader name -> socket (unused for now, register anyway)
open(ws): register by ws.data.{role,name} (close any previous socket for the same name)
close(ws): unregister (only if it is still the registered one)
message(ws, raw): only meaningful for role=leader:
  parse JSON {t:"input", rig, joints}; look up getLeader(ws.data.name);
  enforce THE SAME rule as HTTP input (Phase B): leader.rig === rig &&
  leader.boundTo === leaseHolder(getRig(rig)); then:
    const sock = rigSockets.get(rig)
    if (sock) sock.send(JSON.stringify({ t: "input", joints }))
    else rig.input = { joints, at: Date.now() }   // mailbox fallback
  apply impair()/shouldDrop() the same as the HTTP input path (import from store).
```

Export `websocketHandlers = { open, message, close }` and in server.ts:
`websocket: websocketHandlers`. Keep `hub/routes.ts` untouched except Phase B.

### D2: rig — receive input over WS

`apps/web/src/rig/link.ts` (`startRigLink`): open
`new WebSocket(base.replace(/^http/, "ws") + "/api/hub/ws?role=rig&name=" + encodeURIComponent(rigName) + (token ? "&token=" + token : ""))`
(Bun has WebSocket built in). `onmessage`: parse `{t:"input", joints|axes}` →
POST to the rig's own `/api/robot/teleop/input` via the existing `localApi`
helper (identical to the mailbox forwarding at link.ts:270-275).
`onclose`/`onerror`: setTimeout reconnect after 2 s (guard with a `closed`
flag so agent shutdown doesn't loop). The HTTP /link tick keeps running
unchanged — double delivery cannot happen because a WS-pushed packet never
enters the hub mailbox.

Check `hub/auth.ts` `hubAuthorized`: it already accepts a token query param
(curl-debug path) — the WS URL uses that. Confirm the param name by reading
the function; use whatever it expects.

### D3: leader — send input over WS

`apps/driver/pyproject.toml` dependencies: add `"websockets>=12"` (then
`uv sync` in apps/driver).

`apps/driver/controller.py`: in `drive()`, try to open
`ws(s)://<hub>/api/hub/ws?role=leader&name=<name>&token=<token>` using
`websockets.sync.client.connect` (the SYNC client — controller.py is
synchronous; do not introduce asyncio). While connected, replace the
`link.post(f"{rig}/input", ...)` call with
`ws.send(json.dumps({"t": "input", "rig": rig_name, "joints": action}))` —
fire-and-forget, no per-packet response, so the loop now truly runs at
`--hz`. Keep the every-15-packets HTTP heartbeat/stop-poll exactly as is.
Detecting revoked binding without per-packet status: on each heartbeat also
GET the rig summary (`api_get`) and stop when `holder` no longer equals the
bound browser… simpler and already available: the heartbeat's
`/leaders/link` response — have the hub include `bound: leader.boundTo !== null`
in that response, and the leader returns to idle when `bound` is false.
(Hub side: one field added to the `/leaders/link` response in routes.ts.)
On ANY WS failure (connect or send): close it and fall back to the existing
HTTP `link.post` path for the rest of the session — the code path must remain.

### Checkpoint D

1. Loopback: hub + rig:sim + fake WS leader via a 10-line bun script (open
   ws as role=leader, bind via the Phase-B command flow, blast 100 input
   frames at 30 Hz) → rig joints update; kill the rig's WS (restart agent
   with WS temporarily disabled) → same script still drives via mailbox.
2. Real leader (user present): `bun run teleop` → packets/s line in the log
   should read ~30/s (was ~15); felt lag noticeably lower; browser take-over
   → leader idles ≤2 s (heartbeat `bound:false`).
3. Impairment rerun: `HUB_LATENCY_MS=120 HUB_DROP_RATE=0.3 bun run hub` —
   still driveable, deadman still holds on silence.
4. Deployed: push, then `bun run teleop` against the default hub — verify WS
   connects through Railway's edge (it supports WebSockets; if the wss
   connect fails, the HTTP fallback keeps working — fix forward).

Update docs: `apps/web/README.md` env list (`LAB_FRAME_MS`), `docs/SPEC.md`
transport paragraph ("boring transports" principle gains: "input plane runs
on a WebSocket when available; everything else stays polled HTTP"),
`docs/TESTING.md` §4 packets/s expectation 15→30.

---

## Explicitly OUT of scope

- Overlapped/parallel HTTP POSTs for the leader (obsoleted by WS).
- Browser keyboard input over WS (keys tolerate HTTP fine).
- Telemetry/commands/frames over WS. Frames stay HTTP POST at LAB_FRAME_MS.
- WebRTC, LiveKit, TURN — never (Railway has no inbound UDP; decided).
- Auth/identity work (wallet spec is another agent's task).
- Touching the frozen `app/` tree in the so101-lab repo.

## Done =

All four checkpoints pass, `git status` clean, pushed, Railway deploy green
(`/api/mode` healthcheck), and `docs/TESTING.md` reflects the new numbers.
