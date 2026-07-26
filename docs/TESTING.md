# Hands Unchained — testing checklists

Everything runs through the hub UI — there is no local console. A "rig" is a
headless agent (`src/agent.ts`) that dials out; you drive and manage it from
the hub's drive page. Never actuate the real arm unattended.

Start a loopback pair (two tabs, both in `apps/web`):

```sh
# tab 1 — the hub (dev twin of the Railway deployment)
bun run hub                                        # → :3001

# tab 2 — a headless sim rig (python driver spawns lazily;
# venv at apps/driver/.venv, `uv sync` in apps/driver if missing)
bun run rig:sim
```

The rig terminal prints its OWNER KEY at boot (also `apps/web/.data/owner.json`).
The **Rig owner** fold on the drive page (tasks, plus camera assignment on a
real rig) needs it once per browser. There is no separate record panel — task
attempts are the only recording path.

## 1 — Sim smoke (no hardware, hub UI only)

All on `http://localhost:3001`:

| # | Step | Expect |
|---|------|--------|
| 1 | Lobby `/` | `kris-sim` card online (autoconnected sim) |
| 2 | Open the card | both cams stream (MuJoCo scene); joints grid live; **Start attempt is greyed** — "pick how you'll drive first" |
| 3 | Click the jog pad (no Teleop button — focusing it starts keys teleop) | W/S/A/D/Q/E jog the arm; O/C gripper |
| 4 | Release all keys / click away | arm holds pose (deadman ~0.5 s) |
| 5 | Rig owner fold → paste key → create a task, max eps 2, 10 s episodes | task card appears (lobby too) reading `0/2` — a new task never inherits another dataset's episodes; the form says which dataset it will collect into |
| 6 | **Drive with keyboard** (one click: takes the rig AND starts keys teleop) → **Start attempt (1/2)** → drive → ✓ Success; tick auto-start → 2/2 | keys drive the arm while recording; `complete ✓`, Start disabled |
| 7 | Datasets page → `report` on the new dataset | episode table renders; exclude an ep → `--dataset.episodes` flag string appears |
| 8 | Trainings → New training → pick the dataset + rig → Create | detail page opens, Colab cell renders (client-generated); run appears in the rig's advertisement within ~2 s |
| 9 | E-STOP during any teleop | physics pauses, state back to connected |

## 2 — Rig session (real arm, user at the rig)

Rig: `bun run rig:real` (or `HUB_URL=<deployed> … bun run agent`). Everything
else happens on the hub's drive page.

Pre-flight (every session — macOS shuffles camera indexes on replug):
- [ ] Drive page → **Rig owner** fold → Cameras → **Probe + preview** → identify
      workspace/wrist on the MAIN feed grid → assign each. Until both are
      assigned, recording is refused (`cameras not confirmed`)
- [ ] Brightness badges inside the 115–131 band (one dominant desk lamp)
- [ ] Both arms powered + plugged (follower `...832001`, leader `...538411`)

| # | Step | Expect |
|---|------|--------|
| 1 | The rig autoconnects at boot; if `armState` is disconnected → Rig owner fold → **Connect (real arm)** | state connected; joints grid live |
| 2 | **Drive with the rig's own leader arm** (the button only exists because an arm is really attached) | follower mirrors leader, no lag spikes |
| 3 | **Stop teleop** → click the jog pad → jog gently | EE-space jog works; big jump attempt → driver stderr shows the 15°/frame clamp warning |
| 4 | E-STOP (raised arm — catch it!) | torque kills instantly, arm goes limp |
| 5 | Task with max 2 eps, tick auto-start, run both attempts with the leader | after EACH attempt the camera feeds come back by themselves within ~2 s and the arm returns to `connected` (it used to end `disconnected` with dark feeds); 2/2 saved |
| 6 | Datasets → report card on the new set | lengths sane, no unexpected `short` flags |

Phone source is currently broken (driver venv lacks the lerobot phone
patches — runbook: so101-lab repo `phone_teleop/README.md`).

## 3 — Remote teleop cluster (no hardware, two processes on one Mac)

Simulates "my rig, her laptop, a cloud in between" without a cloud. The only
difference from production is the value of `HUB_URL`. Setup as in the intro
(optionally `HUB_LATENCY_MS=120 HUB_DROP_RATE=0.05 bun run hub`).

Look for `[rig-link] kris-sim -> http://localhost:3001` in tab 2.

| # | Step | Expect |
|---|------|--------|
| 1 | `:3001/lobby` | `kris-sim` card, online |
| 2 | Open the card → **Drive with keyboard** | both feeds appear within ~2 s; you hold the rig after one click |
| 3 | Click the jog pad → W/S/A/D/Q/E | arm moves in the hub's video; joints grid updates |
| 4 | Release all keys | arm holds — the deadman fires because the hub does **not** replay input |
| 5 | Second browser tab on the same rig | video plays, jog pad hidden, "someone else is driving" |
| 6 | Take over from tab 2, then drive from tab 1 | tab 1 gets 403; one writer at a time |
| 7 | Kill tab 2 (the rig) | lobby flips to offline within 5 s |
| 8 | Restart the rig, then restart the hub | both re-register with no reconnect logic — that is a Railway redeploy |
| 9 | Re-run with `HUB_LATENCY_MS=120 HUB_DROP_RATE=0.3` | still driveable; rig card shows link ≈125 ms; arm still holds on silence |

## 4 — Against the DEPLOYED hub (https://web-production-b5106.up.railway.app)

Deploys are push-to-deploy: a push to `main` touching `apps/web/**` rebuilds
the Railway service (`railway.toml` at the repo root).

```sh
# headless sim rig on your Mac, registered with the cloud hub
HUB_URL=https://web-production-b5106.up.railway.app RIG_NAME=kris-sim \
  LAB_AUTOCONNECT=sim bun run agent
```

| # | Step | Expect |
|---|------|--------|
| 1 | Hub lobby in any browser | rig online, streaming, `link` ≈ your RTT |
| 2 | Drive with the keyboard from another network (phone off wifi) | ~100–200 ms feel; deadman holds on silence |
| 3 | Leader-over-wire: `bun run teleop` (leader plugged in, port auto-detected) → drive page → **Drive with \<name\>'s leader** (one click takes the rig and binds the arm) | sim mirrors the physical leader; badge reads "you are driving — via \<name\>'s leader"; the log reads `packets/s up via socket` at roughly the `--hz` target (measured against the deployed hub: 24/s over the socket vs 10/s over HTTP keep-alive at the same 30 Hz target) |
| 4 | While the leader drives: **Take over** from a second tab | leader agent prints `lost <rig> (control changed)` and idles within ~0.5 s (403 or `bound:false`); the new tab drives immediately; it can lend the same leader by clicking Drive |
| 4b | While the leader drives: **Start attempt** on a task, then ✓ Success | the attempt runs with YOU as operator while the leader drives (record source `remote`), episode saved — the leader never took your lease |
| 5 | As a non-holder: **E-STOP** | works without the lease — safety verbs bypass it |
| 6 | Redeploy mid-session | rig re-registers in seconds; operator re-claims (lease loss expected) |
| 7 | `POST /api/runs` (or any non-GET) against the hub API | 404 `read-only hub` — writes only ride the verb pipe |

Local prod-build twin of the deployment: `bun run build && PORT=3001 bun run hub:prod`.

## Regression suite (run after driver/web changes)

```sh
cd apps/web && bunx tsc --noEmit && bunx biome check src && bun run build
cd apps/driver && for f in *.py backends/*.py sources/*.py; do .venv/bin/python -c "import ast; ast.parse(open('$f').read())" || echo "FAIL $f"; done
# + sim smoke rows 2–8 above
```

Known gaps / by design:
- `bun run hub` is vite dev — no `Bun.serve`, so the WS input plane cannot
  upgrade there and input rides the HTTP mailbox (the rig logs "input socket
  unavailable", leader logs "via http"). To exercise the socket locally:
  `bun run build && PORT=3001 bun run hub:prod`. Railway runs the built server.
- Real-mode video during record stays dark (the recorder owns the devices) — but
  the previews come back by themselves when the session ends.
- Report cards for datasets NOT pushed to the Hub only render on the machine
  that recorded them (remote-parquet reads need the dataset on the Hub).
- Contract changes need a dev-server restart (the API handler survives HMR on purpose).

## 5 — Tasks + attempts (the crowdsourcing loop, sim-verifiable)

Setup as in the intro; paste the owner key into the drive page's owner panel.

| # | Step | Expect |
|---|------|--------|
| 1 | Drive page → **Rig owner** fold (one section: tasks · publish · cameras on a real rig) → paste key → create a task | task card appears (lobby too); wrong key shows `✗ wrong owner key` via lastCommandResult |
| 2 | **Drive with keyboard** → Start attempt | REC pill within ~3 s (spin-up grace covers dataset create), countdown from the task's episodeSeconds |
| 3 | Drive during the attempt (jog pad) | input flows into the recording (record source = your teleop source) |
| 4 | ✓ Success | episode saved — `info.json total_episodes` +1, task title is the per-frame lerobot label; `.data/attempts.json` row {operator, outcome: success} |
| 5 | New attempt → ✗ Discard | episode count UNCHANGED; outcome `discarded` |
| 6 | Let one run out | lerobot timeout semantics auto-save; outcome `timeout` |
| 7 | Close the browser mid-attempt | after 30 s holder-loss: partial discarded, outcome `abandoned`, teleop NOT auto-restarted for a failed driver |
| 8 | Restart the hub mid-attempt | recording uninterrupted; tasks re-advertised (rev-echo); your page reclaims the lease and the attempt continues |

### The episode loop (task with `maxEpisodes`)

| # | Step | Expect |
|---|------|--------|
| 1 | Create a task with max eps 3 (fresh dataset name) | card shows an empty bar + `0/3`, button reads **Start attempt (1/3)** |
| 2 | Run one attempt → ✓ Success | back on the idle card at `1/3` within ~4 s (episode save + the 2 s advertisement) |
| 3 | Start again, tick **auto-start the next attempt**, ✓ Success | the next attempt starts by itself once the recorder's session closes (~5 s: video encode keeps `recording` true) — repeat to 3/3 |
| 4 | At 3/3 | `complete ✓` badge, Start disabled; a forced `attempt_start` via curl is refused rig-side with "task complete" |
| 5 | `.data/attempts.json` | one success row per episode, `operator` = your clientId |

Curl equivalents live in the git history of this checklist (B-gate, commit
"tasks + attempts").

## 6 — The market loop (World + slots + grading + payout)

Everything above runs with `MARKET_MODE` unset. This section is the paid,
gated, graded product. Sim rig is enough — the referee reads the recorded
episode, and a MuJoCo episode is a real episode.

### Env

The market layer needs secrets that are deliberately not in git
(`apps/web/.env.market`, gitignored). Without the two SlotMarket addresses
`SLOTS.configured` is false, `/api/market/slots` answers **501**, and the whole
booking/grading/payout surface silently does not render:

```sh
MARKET_MODE=1
MARKET_SECRET=…                 # HMACs the session cookie
GRADER=zg                       # 0G Compute; falls back to local on any error
SLOT_REQUIRED=1                 # a slot is required to drive at all
ZG_SLOT_MARKET_ADDRESS=0x0EeFee711Ed37dE9C0d892638F9d14ac9047a9D8
HEDERA_SLOT_MARKET_ADDRESS=0x7f37B89DE964DFf7EE6EF6d2E3d58dAF42Ac6863
```

`set -a; source .env.market; set +a` in the HUB tab only — the rig and the
leader are separate processes and need none of it.

### One toggle that exists for testing

| Var | Effect |
|-----|--------|
| `SLOT_AUTOSETTLE=0` | the hub stops settling finished slots. The operator's **Claim** button becomes the only way the money moves — which is the point: `settle` is permissionless, so the stake is not hostage to our uptime. |

There is **no verification bypass**, deliberately. `MARKET_DEV_AUTOVERIFY` used
to mint a verified session with no proof; it is gone. It saved one click per
browser per day (the session cookie lives 24 h) because World's staging
simulator is a web page, not a phone — which is not worth a code path whose job
is to make "verified human" a lie, one env var away, in a product whose first
gate is exactly that.

### World ID, without a phone

We run in `staging` and always will — this app is never going to real World
users. Staging credentials come from **`https://simulator.orb.engineer`** (use
an identity like `/id/0x18d844e5`). It is not a mock of our code: the proof
still goes to `developer.world.org/api/v4/verify`, and it is still rejected if
its signal is not the wallet you connected with.

`require_user_presence` is silently incompatible with the simulator — it wants
a live selfie matched against a credential image. Leave `WORLD_REQUIRE_PRESENCE`
unset.

### Money

Booking IS staking, so this needs real testnet funds in MetaMask: 0G Galileo
(16602, faucet `https://faucet.0g.ai`) or Hedera testnet (296,
`https://portal.hedera.com/faucet`). Same rules either chain. The stake is read
LIVE from each contract's `minStake` — don't hardcode it in your head, the gate
prints the real number.

If your wallet already knows a network called "0G Galileo" at chain id **16601**
(viem shipped that id for a while), `switchChain` fails and the gate says so
explicitly — rename or remove the stale entry.

### The loop

| # | Step | Expect |
|---|------|--------|
| 1 | Drive page on a rig nobody booked | the gate, not the jog pad: 1 connect wallet · 2 prove you're human · 3 book |
| 2 | Connect → verify with the simulator | step 2 reads "verified · bound to your wallet" |
| 3 | **Hard-refresh the page** | step 1 still shows your address, checked, **with no wallet popup** — it is re-read from the session, not from localStorage |
| 4 | Connect a DIFFERENT MetaMask account | an explicit warning that you proved World ID on the other one; the arm only opens for the wallet that booked |
| 5 | Book (the gate names the stake) | one MetaMask signature. The clock does NOT start |
| 6 | **Take control & start** | no second popup (the hub relays `startSlot`); 30:00 counting down |
| 7 | Start an attempt, drive, ✓ Success | the row narrates itself: *reading your episode off the rig* → *0G referee deliberating* → *posting the verdict on chain* → the verdict, with the reason, the provider, the `chatID` and `sig ✓` |
| 8 | Claim ✓ on an episode you did NOT do | fail + **strike**; the task progress does not advance and the bar shows "1 rejected" |
| 9 | **I'm finished — end my slot** | `endEarly` pulls `endAt` to now. Not a forfeit: stake + credits still settle, and a verdict already in flight still lands |
| 10 | Wait for settlement | "Paid to your wallet" with a **settle tx** link — on HashScan for a Hedera slot, ChainScan for a 0G one |
| 11 | Owner panel → **Publish** | with any failed episode present the button reads "dropping failed episodes…" first; the Hub dataset is short by exactly those episodes and the local recording is untouched |

### Booking ahead / the queue

| # | Step | Expect |
|---|------|--------|
| 1 | Second browser + second wallet, on a rig you are driving | "Join the queue" — the contract always took this booking, nothing used to offer it |
| 2 | After booking | "you're next · yours in about N min", counted from what is left of the live slot |
| 3 | End the live slot early | the queue advances; the next operator takes control |
| 4 | Book, never take control, with someone waiting behind you | after `noShowGrace` (90 s) the hub calls `skipHead` and refunds you in full. With an EMPTY queue behind you nothing happens — skipping exists to unblock a line, not to punish reading slowly |

### Settling without the hub

The hub normally settles within a second of the clock running out, so the
Claim button is invisible on the happy path. To see it:

```sh
SLOT_AUTOSETTLE=0 bun run hub          # in addition to sourcing .env.market
```

Book, drive, end early, then wait out the grading window (`gradeGrace`, 150 s
on the deployed contracts — the settler may bypass it, nobody else may). The
panel offers **Claim N to my wallet**; one signature, and the stake plus every
credit lands. That is the whole non-custodial claim, demonstrable rather than
asserted.
