# HACKATHON.md — ETHGlobal Lisbon 2026 submission plan

**Read `AGENTS.md` + `docs/SPEC.md` first.** This file is only the hackathon layer:
what to build on top of the shipped platform, and what the judges require.
**Implementation detail lives in [`docs/SPONSORS.md`](docs/SPONSORS.md)** — exact
seams, corrected facts, work order, and the concurrency contract with the other agent.

Event: Jul 24–26, Carlos Lopes Pavilion. **Submissions Sunday morning** — Saturday is
the only full build day. Team of 2: Kristjan (platform + chain), friend (Apple Vision
Pro teleop source).

## Tracks — 3 sponsors, ONE track each (locked)

| Sponsor | Track | Prize | Hard requirements |
|---|---|---|---|
| **World** | AgentKit New Use Cases | 🥇$4k 🥈$2.5k 🥉$1.5k | ⚠️ **AgentKit ≠ World ID** — it gates *autonomous agents* (on-chain AgentBook + 402/SIWE handshake → `humanId`), not humans at keyboards. Must gate **execution rights**; **show the deny path**. Disqualifiers: agent reputation, human-backed perks/discounts (API calls), content-gen wrappers. Fallback if AgentBook registration is Orb-gated: **Selfie Check Beta** ($2k/$1.5k). See `docs/SPONSORS.md` §8. |
| **Hedera** | AI & Agentic Payments | 2 × $3k (flat) | ≥1 real payment/token transfer on **testnet**; public repo + README explaining the payment flow; video ≤5 min. Bonus points: x402, HCS audit trail, HCS-14 agent IDs. |
| **0G** | Best AI Product | 🥇$3k 🥈$2k 🥉$1k | **Proof inference runs on 0G Compute**; live demo link; contract deployment address(es); public repo; **video ≤3 min**. (Agentic ID is *conditional* — "for Agentic ID projects" — and has no deployed testnet contract: **skipped**.) |

Make ONE master video **≤3 min** — it satisfies all three.
Dropped deliberately: ENS (Sunday-morning booth obligation), Identity Check beta,
The Graph (Studio has no Hedera support), 1inch/Uniswap/Sui, all Continuity tracks
(not eligible). **Selfie Check Beta is NOT dropped** — it's the World fallback (and a
possible second World entry) since the human-operator gate exists either way.

## The pitch

**Proof of Hands — a labor market where verified humans teach robots, and only graded
work gets paid.**

Robotics has no internet to scrape: robot foundation models learn from human
demonstrations, collected one teleop episode at a time. Tesla/Figure pay operators
$25–48/hr **on-site**. We make that market permissionless: anyone registers a rig (real
SO-101 **or** a MuJoCo sim — zero hardware to participate), any verified human anywhere
drives it, every successful attempt is a labeled LeRobot episode, and payment settles
per graded episode with on-chain provenance.

## Why this needs exactly these three sponsors

The platform **already runs the loop**: owner defines a task → operator takes the
single-writer lease → drives (browser keys or their own leader arm) → clicks Success →
one labeled episode lands in the dataset with operator provenance.

The moment strangers get *paid* for this, three holes open — one per sponsor:

| Hole in the current design | Sponsor | Fix |
|---|---|---|
| Operator identity is a **random per-tab `clientId`** the hub trusts verbatim — sybils get execution rights on physical hardware | **World** | Verification gates lease acquisition: an *agent* proves human-backing via AgentKit, a *human* via Selfie Check/World ID. Unverified → cannot take control. That IS the deny path. |
| **Success is self-declared** by the operator clicking ✓ — the market cannot trust the worker to grade their own work | **0G** | TEE-verified grading on 0G Compute becomes the neutral referee neither side controls. |
| No settlement — and a $0.50 work unit every 20s fits no invoice or bank rail | **Hedera** | x402/HBAR pay-per-graded-attempt, sub-cent fees, HCS provenance. |

That mapping is the architecture slide, and it answers "is your tech load-bearing or
bolted on?" structurally. **The self-declared-success hole is real and pre-existing** —
say so; honesty about it is what makes the 0G integration credible.

## What already ships (DO NOT REBUILD — see docs/SPEC.md "Shipped (v1)")

- Hub live at **https://web-production-b5106.up.railway.app** (Railway project
  `proof-of-hands`, service `web`; push to `main` deploys; 1 replica + sleep off are
  load-bearing — rig registry is in-memory).
- Lobby + drive UI, MJPEG cam feeds (12.5 fps, `LAB_FRAME_MS`), jog pad, take/steal
  control, bystander e-stop, fault surfacing. WebSocket input plane for low-latency
  teleop; HTTP mailbox remains the fallback.
- Headless rig agents dialing OUT (no inbound ports/NAT): sim + real side by side.
- **Tasks + attempts**: rig-side `.data/tasks.json` / `.data/attempts.json`, owner key,
  verb table with args allowlists + owner/holder tiers, 15s command TTL. One attempt =
  one recorded episode, task title = lerobot per-frame label, operator = lease holder
  stamped by the hub (not spoofable).
- Leader-over-wire (`apps/driver/controller.py`), sim backend recording real LeRobot
  datasets, hub lab pages (camera setup, free-form record, datasets, trainings — all
  over the rig verb pipe; the local console role is gone).
- Safety: 15°/tick remote clamp, 0.5s deadman, owner-calibrated servo EEPROM limits,
  torque-drop on disconnect, e-stop for anyone.
- `HUB_TOKEN` auth **built but unset** — the gating seam already exists.

## What to build

All new work is hub-side and gated behind `MARKET_MODE=1` so the standalone platform
keeps working untouched (and remains the fallback demo).

**Persistence without breaking "hub is a stateless pipe":** HCS is the durable ledger —
write the digest on grade, rehydrate the dashboard from the Hedera Mirror Node REST API
at boot; in-memory is only a cache. The one secret needing durability is each operator's
Hedera key: derive it (`HMAC(MARKET_SECRET, nullifier)`) rather than storing it. Railway
volume is the fallback. Rig registry stays in-memory, unchanged.

**Concurrency:** another agent owns `hub/routes.ts`, `hub/store.ts`, `hub/ws.ts`,
`rig/link.ts`, `controller.py`, `contract.ts`, `tasks-registry.ts`, `task-panel.tsx`.
All market code is NEW files plus **one interceptor branch in `server.ts`** — see
`docs/SPONSORS.md` §2–§3.

### Ledger + grading (the spine — no chain yet)
- Hub observes the attempt verbs it already relays — **`attempt_start {taskId}`** and
  **`attempt_finish {success}`** (`hub/verbs.ts`; `keep`/`discard` are `record_control`
  actions on a different, owner-tier path and never fire for attempts) — and writes
  ledger rows: `{rigId, taskId, operator, claimed, ts}`.
- **Evidence capture is nearly free**: the hub already holds the latest MJPEG frame per
  rig for re-serve — snapshot it at attempt end. Telemetry (duration, joint travel,
  gripper cycles, **episodeSaved**) comes from sampling the rig's *telemetry* state, not
  the operator command stream. A "success" claim with no saved episode auto-rejects.
- `grade()` interface with `local.ts` heuristics first (duration in band, gripper closed
  ≥ once, joint travel plausible) → `{score, pass, provider, proof}`.
- Public dashboard route: rigs online, attempts, grades, leaderboard, total paid.

### World — gate lease acquisition (two branches — `docs/SPONSORS.md` §8)
One pluggable credential check on the same gate, so the booth answer costs no rework.
- **Branch A, AgentKit** ($8k pool): agent wallet registered in on-chain AgentBook →
  our 402/SIWE challenge → `verifyAgentkitSignature` → `lookupHuman()` → `humanId` →
  lease granted, quota **per human, not per wallet**. `mode: free` ⇒ no facilitator, no
  payments. Prove `lookupHuman()` non-null in an isolated script *before* wiring.
- **Branch B, Selfie Check / World ID** ($3.5k pool, certain): IDKit → `/api/v2/verify`
  → nullifier → session → lease granted. Requires dev + user **testing documentation**.
- Framing either way: *execution rights over physical hardware*, gated on human-backing.
  Never "perks/discounts for verified humans" — that's on their disqualifier list.

### Hedera — swaps "credits" for real payment
- Auto-create an operator testnet account at verify time — **`new Hbar(1)` initial
  balance, not 20**: every creation draws from the operator's 1000 HBAR and the daily
  refill only tops back *up to* 1000. State the custody shortcut out loud in the demo —
  it reads as maturity, not sloppiness.
- On grade pass → `TransferTransaction` 0.5 HBAR → operator; store tx id; Hashscan link
  on the dashboard.
- One HCS topic at boot (not per attempt); per graded attempt submit a **≤1024-byte**
  digest `{attemptId, humanId, zgRoot, chatID, score, payoutTx}` — one artifact binding
  all three sponsors. Store the sequence number. HCS-14 agent id = cheap bonus.
- `@hashgraph/sdk` **directly qualifies** — Agent Kit / x402 / A2A are optional. Keep
  **x402-on-Hedera off the critical path** (scaffold-hbar's `x402-pay-per-use` looks
  like an unmerged bounty; `@x402/hedera` unverified). Testnet resets periodically —
  don't reuse IDs from earlier days.

### 0G — swaps the grader, adds provenance
- `grader/zg.ts` via **`@0gfoundation/0g-compute-ts-sdk`** (`@0glabs/0g-serving-broker`
  is deprecated). Testnet Direct SDK is **text-only** → grade task string + telemetry
  JSON. Persist `{chatID (ZG-Res-Key header), providerAddress, model, teeVerified from
  processResponse(), request/response hashes}` — that artifact IS the "0G Compute with
  proof" evidence. Final frame stays as human-audit evidence.
- Funding wall: **3 0G ledger + 1 0G per provider** vs a 0.1 0G/day faucet → booth
  tokens, or fall back to the Router (`pc.0g.ai`, OpenAI-compatible, *has vision*).
- `GRADER=zg|local` env switch, fallback always wired. Trust the installed `.d.ts` over
  the docs (`addLedger` vs `depositFund`, `processResponse` arity both conflict).
- ~20-line **event-only** `EpisodeRegistry.sol` on Galileo (chain 16602, solc + ethers,
  no Foundry): `record(episodeHash, humanId, grade, storageRoot)` — satisfies the
  "contract deployment addresses" deliverable; faucet gas is plenty.
- 0G Storage: upload `{finalFrame.jpg, metadata.json}` (Go-style `[value, err]` tuples,
  not exceptions), put the root hash in the event and the HCS digest.
- Say "TEE-attested signature over the response" — **not** "proof the model ran".

### Teammate — Apple Vision Pro (frozen contract, no platform knowledge needed)
Velocity axes, **not** absolute pose (absolute needs new pipeline config + untested IK):
```
1. POST {HUB}/api/hub/rigs/{rig}/claim    {"clientId":"op-xyz"}            ← take the lease first
2. POST {HUB}/api/hub/rigs/{rig}/command  {"clientId":"op-xyz","verb":"teleop_start"}
3. POST {HUB}/api/hub/rigs/{rig}/input    {"clientId":"op-xyz","axes":{"x","y","z","gripper"}}  all [-1,1]
15–30 Hz. Silence >0.5s ⇒ rig holds pose (deadman = her safety net). 15°/tick clamp applies.
Errors: 400 clientId required · 403 not the controller · 404 unknown rig.
Map hand displacement from a pinch-anchor → clamped velocity. Feeds: /api/hub/cams/{rig}/{cam}
Routes are RAW — read apps/web/src/hub/routes.ts (+ hub/verbs.ts), NOT api/contract.ts.
```
xyz + gripper work today; `wx/wy/wz` are **silently discarded** (`sources/keys.py` iterates a
fixed axis set and hardcodes the wrist targets to 0). Plumbing them is a spike — does lerobot's
`EEReferenceAndDelta` consume orientation targets? If not, wrist stays fixed (cut it).

## Order + cut lines

Sequenced by **irreversibility, not prize size** (full detail: `docs/SPONSORS.md` §4).
**Step 0, now, in parallel:** Hedera portal account (self-serve) · 0G tokens at the booth
(the faucet cannot fund the Direct SDK) · World booth + AgentBook registration attempt
under a 90-min timebox.
Then: **ledger + local grader + dashboard** → **Hedera** (bank the guaranteed track
first) → **0G** → **World** (branch decided by the booth answer) → deploy →
**full run-through on the REAL arm over the deployed hub while recording — Saturday
night, not Sunday** → master video ≤3 min → **Sun early** submissions + dress rehearsal.

Cut first → last: x402 buyer-agent demo → HCS-14 → 0G Storage shrinks to metadata-only →
AVP wrist axes → AVP entirely (browser keyjog is the story; AVP becomes b-roll) →
real-arm demo falls back to the sim rig (it's a first-class node — no hardware excuse).

**Never cut:** World verify + deny path · Hedera testnet payment + HCS · 0G Compute
grade with proof + contract address + live link · ≤3-min video · public repo + README
per sponsor. (Agentic ID cut — conditional requirement, no deployed testnet contract.)

## Demo script (rehearse to <2.5 min)

1. Dashboard: rigs online (real arm + sim), attempts graded, total paid.
2. **Deny path first** — unverified browser tries Take Control → refused.
3. Judge verifies on their phone (World ID / Selfie Check) → lease granted.
4. They drive the real arm and run one attempt against the owner's task.
5. Attempt → hub → 0G grade (proof shown) → HBAR lands on Hashscan (second screen) →
   HCS provenance message → EpisodeRegistry event.
6. Kicker: a second verified human drives the **sim** rig at the same time — "the market
   scales past one robot, and needs no hardware to join."
7. Close: weekend stats + the labeled dataset on HF.

**Booth growth hack:** sign reading "Teach this robot. Get paid." + QR to the lobby.
Every visitor session is a real episode + a real on-chain payment, so Sunday's pitch
opens with live traction numbers no other team has.

## Positioning (for the README)

- **PrismaX** ($11M a16z) — browser teleop arcade + AI "Proof-of-View" data scoring, but
  **no proof-of-human on the operator** and no live per-episode settlement.
- **RICE AI** — BYO-robot + token rewards; closest to the full vision.
- **telop.ai** — the only other verified-human + on-chain teleop-data pitch; very early.
- Ecosystem: lerobot's own remote teleop is an **unmerged PR (#1385, WebRTC/LiveKit)**;
  LeKiwi's host/client ZMQ split is LAN-only; DROID / Open-X are closed academic
  consortia. Nobody ships internet-scale BYO-node teleop.
- **Our wedge:** verify the *operator* (not just the pixels) · pay per AI-graded episode ·
  $0-hardware sim nodes · unbroken provenance operator→episode→grade→payment→dataset.

## Risks

- **0G testnet flaky** → `GRADER=local` flip; pre-record one successful 0G-graded attempt
  Saturday night and keep its explorer links so proof-of-integration survives an outage.
- **Venue wifi** → rigs dial OUT over HTTPS only (already proven); no inbound anything.
- **Railway redeploy wipes memory** → HCS is the durable ledger (rehydrate from the
  Mirror Node); rigs re-register in ~50ms by design, leases are lost (expected).
- **World on stage** → register your own agent wallet in advance; design the demo so no
  judge ever registers anything (AgentBook needs World App on mobile, likely Orb-level).
- **Known warts** (docs/NIGHT-NOTES.md): cross-device wrist_roll zero handshake
  undesigned (bites on friend-leader → real-arm); phone teleop source needs a 2-line
  lerobot patch missing from a fresh `uv sync`; real-backend attempts freeze the
  drive-page video while recording (recorder owns the cameras — sim unaffected).

## Reference

```sh
bun run hub            # local hub :3001          bun run rig:sim     # headless sim rig
bun run agent          # headless rig (env-configured)
bun run check && bun run typecheck && bun run build && bun run driver:ast
```
Hub: https://web-production-b5106.up.railway.app · Railway project `proof-of-hands`,
service `web`, push `main` → deploy · new env vars go on that service:
`MARKET_MODE, WORLD_APP_ID, WORLD_ACTION, HEDERA_OPERATOR_ID/KEY, HCS_TOPIC_ID,
ZG_PRIVATE_KEY, ZG_RPC, GRADER`.
