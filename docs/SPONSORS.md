# SPONSORS.md — sponsor integration plan

Written 2026-07-25 for a fresh agent session. `HACKATHON.md` = why/what (pitch,
tracks, demo). **This file = how**: the exact seams, the corrected facts, and the
order of work. Read `AGENTS.md` + `docs/SPEC.md` first — SPEC is kept truthful.

**Another agent is working in this repo concurrently** (`docs/PLAN-latency-episodes.md`).
Read §2 before touching anything.

---

## 1. Corrected facts (these were wrong in earlier planning)

| Claim | Truth |
|---|---|
| "World ID gates the operator ⇒ AgentKit track" | ❌ **AgentKit ≠ World ID.** See §8 — this is the big one. |
| Attempt verbs are `keep` / `discard` | ❌ `attempt_start {taskId}` and **`attempt_finish {success}`** (`hub/verbs.ts:53,58`). `keep`/`discard` are `record_control` *actions* on the owner-tier free-form record path — they never fire for attempts. |
| AVP posts to `/api/rigs/{rig}/teleop/input` | ❌ **`POST /api/hub/rigs/{rig}/input`** with `{clientId, axes}`, after a `POST …/claim`. Raw route in `hub/routes.ts` — **not** in the typed `contract.ts`. |
| Agentic ID (ERC-7857) is required for 0G | ❌ **Conditional**: "*For Agentic ID projects:* link to minted ID". No deployed testnet address exists — you'd deploy your own. **Skip it.** |
| "Stale queued commands" is an open wart | ✅ Fixed (`COMMAND_TTL_MS`, `drainCommands`). |
| Cameras run at 8 fps | 12.5 fps (`LAB_FRAME_MS`, default 80 ms). |
| `remote` source can't record | ✅ Fixed — `sources/ee_chain.py:92` routes `remote` → `RemoteJoints`. |

---

## 2. Concurrency contract — READ THIS FIRST

The other agent owns the teleop-latency + episode-loop work. Collisions here cost
more than any feature gains.

**DO NOT EDIT (theirs):** `hub/routes.ts` · `hub/store.ts` · `hub/ws.ts` ·
`rig/link.ts` · `apps/driver/controller.py` · `api/contract.ts` ·
`api/services/tasks-registry.ts` · `components/task-panel.tsx`.

**Yours (all new):** `apps/web/src/market/**` · `apps/web/src/routes/market.tsx` ·
`contracts/` · `scripts/`.

**Shared — surgical only:** `server.ts` (ONE interceptor branch) · `railway.toml`
(env) · `HACKATHON.md` · `docs/SPEC.md`.

Before starting: `git pull --rebase` — local `main` has diverged from origin
(origin carries the `presentation/` deck).

---

## 3. Architecture — the zero-conflict market layer

Everything hangs off **one pre-router interceptor in `server.ts`**, placed after the
`/api/hub/ws` upgrade branch and before the general `/api/hub/*` routing. It needs
no edits to `hub/routes.ts` or `hub/store.ts` — only read-only imports from the store.

The interceptor does three jobs:

1. **Gate** — `POST /api/hub/rigs/:rig/claim` and `POST /api/hub/leaders/:name/command`.
   These are the only two ways to obtain actuation rights. The WS input plane
   (`hub/ws.ts`) inherits the gate transitively: a leader may only write while
   `leader.boundTo === leaseHolder(rig)`, and binding requires holding the lease.
   **`estop` and `teleop_stop` must stay ungated** — bystander safety is a feature.
2. **Observe** — `POST /api/hub/rigs/:rig/command`; inspect `request.clone().json()`
   for `verb === "attempt_start" | "attempt_finish"` and open/close ledger rows.
   This is the only place the hub sees both the verb *and* the identity
   (attempt outcomes never otherwise reach the hub — they live rig-side in
   `.data/attempts.json`).
3. **Serve** — `/api/market/*`: session, ledger, stats.

**Gate response = HTTP 402 carrying the AgentKit challenge.** Agents understand 402
natively; the browser treats it as "verify required" and renders the World widget.
One status code, both audiences.

**Evidence + telemetry** come from read-only store reads:
`getRig(name).frames.get(cam).data` is the latest JPEG (already re-served at
`/api/hub/cams/:rig/:cam/snap`), and a 5 Hz sampler over `rig.joints` +
`rig.record.saved` while a row is open yields duration, joint travel, gripper cycles,
and **whether an episode actually saved** — so a "success" claim with no saved episode
auto-rejects.

**Persistence without a volume.** HCS is the durable ledger: write the digest on
grade, rehydrate the dashboard from the Mirror Node REST API
(`https://testnet.mirrornode.hedera.com/api/v1/topics/{topicId}/messages`) at boot.
In-memory is a cache. The one secret needing durability is each operator's Hedera
key — **derive it** (`HMAC(MARKET_SECRET, nullifier)` → ed25519 seed) and recover
`accountId` from HCS, so the hub stays stateless across redeploys. Railway volume is
the fallback if derivation fights the SDK.

**Ledger row**

```ts
{ id, rig, taskId,
  operator: { clientId, humanId?, nullifier?, hederaAccountId? },
  claimed: "success" | "discarded",              // what the OPERATOR said
  telemetry: { durationS, jointTravelDeg, gripperCycles, episodeSaved },
  evidence:  { frameJpeg },
  grade:     { score, pass, provider, proof, reason } | null,   // what the REFEREE said
  payment:   { txId, amountHbar } | null,
  provenance:{ hcsSeq, zgRoot, registryTx } | null,
  status: "open" | "closed" | "graded" | "paid" | "rejected" }
```

Keeping `claimed` and `grade` separate is the point — see §9.
A 1 Hz idempotent worker advances the status machine.

---

## 4. Step 0 — credentials (human-blocking; start NOW, in parallel with §5)

Sequenced by irreversibility, not prize size.

1. **Hedera** — portal testnet account → 1000 HBAR → `HEDERA_OPERATOR_ID/KEY`.
   Self-serve, ~30 min, lowest risk of the three. **Bank this track first.**
2. **0G tokens — booth.** Direct SDK needs **3 0G (ledger) + 1 0G per provider**;
   the faucet gives **0.1 0G/day**, so the faucet *mathematically cannot* fund it.
   If tokens don't land quickly → Router fallback (§7).
3. **World — booth.** Ask: (a) does AgentBook accept Selfie-Check-level World ID or
   is Orb required? (b) is Base Sepolia working end to end? (c) may one project enter
   two tracks from one sponsor? Then attempt
   `npx @worldcoin/agentkit-cli register <agent-address>` under a **90-minute timebox**.
   If it fails → Branch B (§8), no time lost.

---

## 5. M1 — ledger + telemetry + local grader (the spine)

New files: `market/{store,interceptor,sampler,routes}.ts`,
`market/grader/{index,local}.ts`, `routes/market.tsx` (public dashboard: rigs online,
attempts, grades, leaderboard, total paid — add a nav entry).

`grade(row) → {score, pass, provider, proof, reason}` is the seam every later track
plugs into. `local.ts` first: duration in band, `episodeSaved === true`, gripper
cycled ≥ 1, joint travel plausible. Ship this before any chain code — it makes the
whole loop demoable with `GRADER=local` and is the permanent fallback.

Gate everything behind `MARKET_MODE=1` (default off ⇒ platform behaves exactly as
today, and stays the fallback demo).

---

## 6. M2 — Hedera (bank it first; ~30–60 min after credentials)

`@hashgraph/sdk` **directly qualifies** — Agent Kit, x402 and A2A are all optional.
The bar is *one* payment executed autonomously by an agent.

- Per operator: `AccountCreateTransaction().setECDSAKeyWithAlias(pub).setInitialBalance(new Hbar(1))`.
  **1 HBAR, not 20** — every creation draws from the operator's 1000 HBAR and the
  daily refill only tops back *up to* 1000 (it does not stack).
- One HCS topic created at boot and reused (**not** one per attempt).
- On `grade.pass`, the **grading agent autonomously** runs `TransferTransaction`
  → store `payment.txId`. That single call satisfies the track.
- HCS message = **≤1024-byte digest** (hard protocol limit):
  `{attemptId, humanId, zgRoot, chatID, score, payoutTx}` — one artifact binding all
  three sponsors. Never put grading output in HCS.
- README needs an explicit **"payment flow mechanics"** section (the track names it).
  Link `https://hashscan.io/testnet/topic/<id>` + a payout tx.
- **Keep x402-on-Hedera off the critical path**: scaffold-hbar's `x402-pay-per-use`
  template appears to be an unmerged bounty (`x402-bounty.md`), and `@x402/hedera`
  is unverified. Bonus only.
- Hedera testnet is **periodically reset** — don't hardcode IDs from days earlier.

---

## 7. M3 — 0G (Direct SDK primary, Router fallback)

Package is `@0gfoundation/0g-compute-ts-sdk` — `@0glabs/0g-serving-broker` is
deprecated and only re-exports. **Trust the installed `.d.ts` over every doc page**:
docs and the starter kit disagree on `addLedger` vs `depositFund` and on
`processResponse` arity. Budget an hour for SDK churn.

**Per-attempt proof artifact** (this is the track's "proof you use 0G Compute"):
`{ chatID (from the ZG-Res-Key response header), providerAddress, model,
teeVerified (the boolean from processResponse), requestHash, responseHash, ts }`.
Persist it on the row and screenshot it in the video.

**Grading input:** testnet Direct SDK is **text-only** → grade on **telemetry**
(joint trajectories, gripper events, duration, episodeSaved). Frame that as a design
choice, not a limitation — trajectory grading is more defensible for a robot
marketplace than frame captioning. The snapshot frame becomes **0G Storage evidence**
instead: upload `{frame, telemetry}` via `@0gfoundation/0g-storage-ts-sdk` (Go-style
`[value, err]` tuples — err-first checks, not try/catch) → root hash onto the row.

**Contract address deliverable:** deploy the ~20-line event-only `EpisodeRegistry.sol`
to Galileo (chain **16602**, RPC `https://evmrpc-testnet.0g.ai`, explorer
`https://chainscan-galileo.0g.ai`) with solc+ethers — faucet gas is plenty.

**Fallback:** Router (`https://router-api.0g.ai/v1`, OpenAI-compatible, `sk-` key from
`pc.0g.ai`) — easy, *has vision models* (so it could grade the actual frame), but
batched settlement means a weaker per-call artifact. Both sit behind the same
`grade()` interface; `GRADER` switches them.

**Skip Agentic ID** (§1). **Don't overclaim**: "TEE-attested signature over the
response", never "cryptographic proof the model ran".

---

## 8. M4 — World (two branches, one gate)

**The correction that matters:** AgentKit is an **x402 extension for agent
delegation**, not a proof-of-humanity widget. A human registers an *agent wallet* into
the on-chain **AgentBook**; the agent later calls your endpoint, you reply 402 with a
SIWE challenge, it signs, you `verifyAgentkitSignature()` then
`agentBook.lookupHuman(addr)` → a **`humanId`**. Quotas track **per human, not per
wallet**. No human is present at verification time. Gating a browser operator is
IDKit/Selfie-Check territory and would **not** qualify for the AgentKit track.

Their exclusion list explicitly kills *agent reputation* and *human-backed benefits
for agents (API calls, discounts)* — so the stock demo is disqualified. **Our angle is
the phrase from World's own blurb: execution rights.** An autonomous agent must prove
human-backing before it can actuate a **physical robot arm**, because a bot swarm
moving real hardware is a safety and liability problem payment cannot solve.

The credential check is one pluggable interface, so the booth answer picks a branch
with zero rework:

**Branch A — AgentKit** (if registration succeeds)
- Hand-roll the 402 inside the existing interceptor with the low-level helpers
  (`parseAgentkitHeader` → `validateAgentkitMessage` → `verifyAgentkitSignature` →
  `createAgentBookVerifier().lookupHuman()`). Avoids adopting Hono/x402 middleware we
  don't otherwise need, and still *is* using AgentKit.
- `mode: free` ⇒ **no facilitator, no real payments, no USDC**. Big de-risk.
- Implement nonce replay protection — a judge retrying a request will otherwise
  replay a nonce and it looks broken.
- **Prove `lookupHuman()` returns non-null in an isolated script before wiring
  anything.** Registration chain (Base) vs verification chain (World Chain) mismatch
  silently returns `null` — the single most likely hours-burning failure.
- Agent client: ~50-line Bun script — handshake → claim a rig → drive the scripted
  pick on the sim rig. Demo it against an **unregistered** wallet too (402, arm stays
  locked).
- Register your *own* wallet in advance; design the demo so **no judge ever registers
  anything** (registration needs World App on mobile, likely Orb-level).

**Branch B — Selfie Check / World ID** (certain; fits the product as built)
- IDKit proof → Developer Portal `/api/v2/verify` → nullifier → session cookie →
  gate. This is the human-operator gate the demo needs regardless.
- Track requires **testing documentation with both developer and user feedback** —
  budget ~45 min of writing; it's a qualification requirement, not a nicety.

Branches are additive. If A works, B is nearly free and plausibly enters a second
World track (confirm multi-track eligibility at the booth).

---

## 9. Demo script — and the beat that proves the thesis

Deny → verify → drive → attempt → grade → pay → provenance. Then the beat:

> **Deliberately botch an attempt, claim success, and show the grader rejecting it —
> no payment.**

The platform currently lets the operator self-declare success (they click ✓). That
hole is real and pre-existing, which is exactly what makes a TEE-verified referee
load-bearing rather than decorative. Say so out loud; the honesty is what makes the
0G integration credible.

Kicker: a second verified operator drives the **sim** rig simultaneously — the market
scales past one robot and needs no hardware to join. Close on live weekend traction
plus the labeled HF dataset.

---

## 10. Cut lines and abort points

Drop order: x402 → HCS-14 → Agentic ID (already cut) → 0G Storage shrinks to
metadata-only → AgentKit falls back to Branch B → real arm falls back to the sim rig.

**Never cut:** one Hedera testnet payment + HCS digest · 0G Compute proof + contract
address + live demo link · a working **deny path** · public repo + per-sponsor README
· **≤3-min video** (0G's cap; it satisfies all three sponsors).

**Pre-committed abort:** pick an hour tonight. If 0G inference isn't returning by
then, flip `GRADER=local` and spend the rest on the video and writeups. Three
half-finished tracks score worse than two finished ones.

---

## 11. Open items to watch

- `episodesDone` (task progress) belongs to the other agent's Phase C — the traction
  display depends on it.
- Real-backend attempts freeze the drive-page video while recording (the recorder owns
  the cameras); sim is unaffected. Don't debug it live — demo attempts on sim, or
  narrate it.
- Cross-device `wrist_roll` zero handshake is still undesigned (bites on
  friend-leader → real-arm).
- `phone` teleop source needs a 2-line lerobot patch absent from a fresh `uv sync`.

---

## 12. Env + reference

```
MARKET_MODE=1              MARKET_SECRET=…            GRADER=zg|local
HEDERA_OPERATOR_ID=…       HEDERA_OPERATOR_KEY=…      HCS_TOPIC_ID=…
ZG_PRIVATE_KEY=…           ZG_RPC=https://evmrpc-testnet.0g.ai    ZG_PROVIDER=…
WORLD_APP_ID=…             WORLD_ACTION=…             AGENTBOOK_CHAIN=…
```

Hub `https://web-production-b5106.up.railway.app` · Railway project `proof-of-hands`,
service `web`, push `main` → deploy · `bun run hub` (:3001) · `bun run rig:sim` ·
checks: `bun run check && bun run typecheck && bun run build && bun run driver:ast`.
