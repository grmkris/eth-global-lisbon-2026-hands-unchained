# HACKATHON.md — ETHGlobal Lisbon 2026 submission plan

**Read `AGENTS.md` + `docs/SPEC.md` first.** This file is only the hackathon layer:
what to build on top of the shipped platform, and what the judges require.

Event: Jul 24–26, Carlos Lopes Pavilion. **Submissions Sunday morning** — Saturday is
the only full build day. Team of 2: Kristjan (platform + chain), friend (Apple Vision
Pro teleop source).

## Tracks — 3 sponsors, ONE track each (locked)

| Sponsor | Track | Prize | Hard requirements |
|---|---|---|---|
| **World** | AgentKit New Use Cases | 🥇$4k 🥈$2.5k 🥉$1.5k | Verification must gate **access/authorization/execution rights**; working e2e flow; **show the deny path**. Disqualifiers: agent reputation, perks/discounts for humans, content-gen wrappers. |
| **Hedera** | AI & Agentic Payments | 2 × $3k (flat) | ≥1 real payment/token transfer on **testnet**; public repo + README explaining the payment flow; video ≤5 min. Bonus points: x402, HCS audit trail, HCS-14 agent IDs. |
| **0G** | Best AI Product | 🥇$3k 🥈$2k 🥉$1k | **Proof inference runs on 0G Compute**; live demo link; contract deployment address(es); minted **Agentic ID** on the 0G explorer; public repo; **video ≤3 min**. |

Make ONE master video **≤3 min** — it satisfies all three.
Dropped deliberately: ENS (Sunday-morning booth obligation), Selfie/Identity beta
tracks, The Graph (Studio has no Hedera support), 1inch/Uniswap/Sui, all Continuity
tracks (not eligible).

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
| Operator identity is a **nickname stamped by the hub** — sybils get execution rights on physical hardware | **World** | AgentKit/World ID gates lease acquisition. Unverified → cannot take control. That IS the deny path. |
| **Success is self-declared** by the operator clicking ✓ — the market cannot trust the worker to grade their own work | **0G** | TEE-verified grading on 0G Compute becomes the neutral referee neither side controls. |
| No settlement — and a $0.50 work unit every 20s fits no invoice or bank rail | **Hedera** | x402/HBAR pay-per-graded-attempt, sub-cent fees, HCS provenance. |

That mapping is the architecture slide, and it answers "is your tech load-bearing or
bolted on?" structurally. **The self-declared-success hole is real and pre-existing** —
say so; honesty about it is what makes the 0G integration credible.

## What already ships (DO NOT REBUILD — see docs/SPEC.md "Shipped (v1)")

- Hub live at **https://hub-production-3903.up.railway.app** (Railway project
  `proof-of-hands`, service `web`; push to `main` deploys; 1 replica + sleep off are
  load-bearing — rig registry is in-memory).
- Lobby + drive UI, MJPEG cam feeds (8 fps through Railway edge), jog pad, take/steal
  control, bystander e-stop, fault surfacing.
- Headless rig agents dialing OUT (no inbound ports/NAT): sim + real side by side.
- **Tasks + attempts**: rig-side `.data/tasks.json` / `.data/attempts.json`, owner key,
  verb table with args allowlists + owner/holder tiers, 15s command TTL. One attempt =
  one recorded episode, task title = lerobot per-frame label, operator = lease holder
  stamped by the hub (not spoofable).
- Leader-over-wire (`apps/driver/controller.py`), sim backend recording real LeRobot
  datasets, console role (record wizard, datasets, trainings).
- Safety: 15°/tick remote clamp, 0.5s deadman, owner-calibrated servo EEPROM limits,
  torque-drop on disconnect, e-stop for anyone.
- `HUB_TOKEN` auth **built but unset** — the gating seam already exists.

## What to build

All new work is hub-side and gated behind `MARKET_MODE=1` so the standalone platform
keeps working untouched (and remains the fallback demo).

**Deliberate exception to "hub is a stateless pipe":** the market ledger needs to
survive a redeploy. Add persistence for the ledger ONLY (Railway volume + `bun:sqlite`,
or a JSON file if sqlite fights you). Document it in SPEC. Rig registry stays in-memory.

### M1 — Ledger + grading (no chain yet)
- Hub observes attempt verbs it already relays (`attempt_start` / `keep` / `discard`)
  and writes ledger rows: `{rigId, taskId, operator, outcome, ts}`.
- **Evidence capture is nearly free**: the hub already holds the latest MJPEG frame per
  rig for re-serve — snapshot it at attempt end. Plus telemetry (duration, joint travel,
  gripper-closed) from the command stream.
- `grade()` interface with `local.ts` heuristics first (duration in band, gripper closed
  ≥ once, joint travel plausible) → `{score, pass, provider, proof}`.
- Public dashboard route: rigs online, attempts, grades, leaderboard, total paid.

### M2 — World (swaps the nickname stub)
- IDKit widget on the lobby → hub verifies against World `/api/v2/verify` → session
  carries the nullifier → **lease acquisition requires a verified session**.
- Use the **production** app (not staging) so judges' real World App works. Accept
  Selfie Check level so judges without an Orb can onboard mid-demo.
- Framing: *human-backed operators get execution rights on physical hardware*. Never
  "verified humans get perks/discounts" — that's their disqualifier list.

### M3 — Hedera (swaps "credits")
- Auto-create an operator testnet account at verify time (~1 HBAR seed, keypair stored
  hub-side, "reveal key" button). State the custody shortcut out loud in the demo — it
  reads as maturity, not sloppiness.
- On grade pass → `TransferTransaction` 0.5 HBAR → operator; store tx id; Hashscan link
  on the dashboard.
- HCS topic; per graded attempt submit `{episodeHash, nullifier, taskId, grade,
  provider, payTx}`; store sequence number. HCS-14 agent id = cheap bonus.
- Start from `scaffold-hbar` templates (`templates/x402-pay-per-use`).

### M4 — 0G (swaps the grader + adds provenance)
- `grader/zg.ts` via `@0glabs/0g-serving-broker`: assume **no vision model** — grade the
  task string + telemetry JSON; persist the broker's verification metadata (provider
  address, attestation/signature headers) as `grade_proof`. That artifact IS the "0G
  Compute with proof" evidence. Final frame stays as human-audit evidence.
- `GRADER=zg|local` env switch, fallback always wired.
- ~20-line **event-only** `EpisodeRegistry.sol` on Galileo testnet (solc + ethers, no
  Foundry): `record(episodeHash, nullifier, grade, storageRoot)`.
- 0G Storage: upload `{finalFrame.jpg, metadata.json}`, put the root in the event.
- **Mint one Agentic ID for the rig** — required checklist item; keep it isolated (a
  dashboard link is enough), don't integrate deeper.

### Teammate — Apple Vision Pro (frozen contract, no platform knowledge needed)
Velocity axes, **not** absolute pose (absolute needs new pipeline config + untested IK):
```
POST {HUB}/api/rigs/{rig}/teleop/input   {"axes":{"x","y","z","gripper","wx","wy","wz"}}  all [-1,1]
15–30 Hz. Silence >0.5s ⇒ rig holds pose (deadman = her safety net). 15°/tick clamp applies.
Map hand displacement from a pinch-anchor → clamped velocity. Feeds: the drive page MJPEG URLs.
Needs the lease (take control first). Verify exact verb/route names in apps/web/src/api/contract.ts.
```
xyz + gripper work today. Wrist axes need `wx/wy/wz` plumbed in `apps/driver/sources/keys.py`
(currently zeroed) — spike whether lerobot's `EEReferenceAndDelta` consumes orientation
targets; if not, wrist stays fixed (cut it).

## Order + cut lines

**Sat AM** M1 ledger + local grader + dashboard · **Sat midday** M2 World (biggest
prize, whole story depends on the gate) · **Sat PM** M3 Hedera (cheap from template) ·
**Sat evening** M4 0G (biggest checklist) → deploy → **full run-through on the REAL arm
over the deployed hub while recording — do this Saturday night, not Sunday** ·
**Sat night** master video ≤3 min · **Sun early** submissions, READMEs, dress rehearsal.

Cut first → last: x402 buyer-agent demo → HCS-14 → 0G Storage shrinks to metadata-only →
AVP wrist axes → AVP entirely (browser keyjog is the story; AVP becomes b-roll) →
real-arm demo falls back to the sim rig (it's a first-class node — no hardware excuse).

**Never cut:** World verify + deny path · Hedera testnet payment + HCS · 0G Compute
grade with proof + contract address + Agentic ID + live link · ≤3-min video · public
repo + README per sponsor.

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
- **Railway redeploy wipes memory** → ledger must be on the volume; rigs re-register in
  ~50ms by design, leases are lost (expected).
- **World on stage** → production app + Selfie Check so any judge can onboard.
- **Known warts** (docs/NIGHT-NOTES.md): stale queued hub commands delivered on rig
  re-register; cross-device wrist_roll zero handshake undesigned (bites on
  friend-leader → real-arm); phone teleop source broken in `apps/driver/.venv`.

## Reference

```sh
bun run hub            # local hub :3001          bun run rig:sim     # headless sim rig
bun run agent          # headless rig (env-configured)
bun run check && bun run typecheck && bun run build && bun run driver:ast
```
Hub: https://hub-production-3903.up.railway.app · Railway project `proof-of-hands`,
service `web`, push `main` → deploy · new env vars go on that service:
`MARKET_MODE, WORLD_APP_ID, WORLD_ACTION, HEDERA_OPERATOR_ID/KEY, HCS_TOPIC_ID,
ZG_PRIVATE_KEY, ZG_RPC, GRADER`.
