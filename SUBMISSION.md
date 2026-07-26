# SUBMISSION.md — ETHGlobal Lisbon 2026 form answers

Copy-paste source for the submission form. One heading per field.

---

## Project name

Hands Unchained

## What category does your project belong to?

Artificial Intelligence

## What emoji best represents your project?

🙌 (alt: 🦾)

## Demonstration link

https://web-production-b5106.up.railway.app

## Short description

*(max 100 chars — this one is 99)*

Rent a real robot arm by the half hour. Book on chain, drive from your browser, get paid if it works.

Alternates:

- (96) Crowdsourced robot teleoperation: World ID gates the arm, AI grades the episode, the chain pays.
- (96) Drive real robot arms over the internet. World ID gates the arm, AI grades the work, chain pays.
- (87) A labor market for robot arms: verified humans teleoperate, AI referees, 0G settles.

## Description

*(min 280 chars — this is ~4,500)*

**Hands Unchained — a labor market where verified humans teleoperate real robots, and only AI-graded work gets paid.**

**The problem.** Robot foundation models don't have an internet to scrape. They learn from human demonstrations, collected one teleoperation episode at a time. Tesla and Figure pay operators $25–48/hr to do this *on-site*. We make that market permissionless and remote: anyone plugs in a robot arm (or a zero-hardware MuJoCo sim), any verified human anywhere drives it over the public internet, and every successful attempt becomes one labeled LeRobot episode in the rig owner's dataset.

**The platform.** A cloud hub holds a registry of "rigs." A rig is a headless agent running on any Mac — a real SO-101 arm over serial, or a MuJoCo sim. Operators browse a lobby, take a single-writer lease on a rig, and drive it from browser keys, their own leader arm (leader-over-wire), or a phone or VR/AR headset. 
The rig owner defines a task ("push the cube into the corner"); operators attempt it; the task title becomes the per-frame label; each ✓ writes a real LeRobot episode with operator provenance.

**The hole, and the market layer.** That loop has one honest flaw: success is **self-declared**. The operator clicks ✓ and the episode counts. The moment strangers get paid, that hole and two others must close — one per sponsor:

- **World ID gates execution rights.** Operating a physical robot arm is machinery operation with real liability, so the market requires an Identity Check credential (`minimum_age: 18`) before the lease is granted. Unverified → **HTTP 402**, the arm stays locked (an unverified visitor can still watch every camera feed — it's an eligibility gate, not a login). Data minimization is strict: one attribute requested, one value kept — the per-action nullifier, which also binds the operator's payout wallet. No name, nationality, or document number ever reaches the hub.
- **0G Compute is the referee.** A **TeeML**-verifiable model on 0G Compute grades the *recorded episode itself* (30 Hz joint state — the actual work product), and its verdict, not the operator's click, decides payment. The provider is registered on 0G's `InferenceServing` with `verifiability: "TeeML"`, and every grade persists the verification artifact `{chatID, providerAddress, model, teeVerified, requestHash, responseHash}`.
- **Booking IS staking.** `SlotMarket` gives an operator 30 exclusive minutes on a rig, purchased by staking from their own MetaMask wallet, with an on-chain FIFO queue so nobody can take the arm out from under you mid-episode. Pass → stake returned plus a bonus from the reward pool. Claim success and fail the TEE referee → a strike; three strikes slashes the stake. **Nobody profits from a slash** — voided stakes return to the reward pool, never a treasury, because the settler is the one component you're asked to trust and it must not also earn from voiding people. `settle()` is permissionless; a 1 Hz settlement worker executes every payment autonomously on the verdict. The hub never holds or derives an operator key.

**The cross-chain part is cryptographic, not a promise.** 0G's broker signs each inference response inside the enclave with plain EIP-191. `contracts/TeeAttestation.sol`, deployed on **Hedera**, rebuilds that digest and `ecrecover`s it against the signer address 0G's own registry publishes on Galileo (read live at deploy time, not hardcoded). Our backend carries the bytes across and *cannot forge them* — feed the contract a tampered response and it reverts. Stated plainly, because it matters: this proves the grading output came out of 0G's TEE. It does not prove what was asked, and our backend still chooses which graded attempt to submit. A grade with no attestation (0G down, local heuristic fallback) can still pay you but can never cost you a strike — without the enclave the market may be lenient, never punitive.

Both chains run the same `SlotMarket` — 0G Galileo (16602) and Hedera testnet (296) — and the operator picks which one to stake on at booking time.

**Live testnet contracts:** SlotMarket on 0G Galileo `0x0EeFee711Ed37dE9C0d892638F9d14ac9047a9D8` · SlotMarket on Hedera `0x7f37B89DE964DFf7EE6EF6d2E3d58dAF42Ac6863` · EpisodeRegistry `0x80669DE19A96F0004adbC3C81c528Ef1abB9a494` · TeeAttestation (Hedera) `0xE6ad861D1c18d2FeFe18b49bCa1B407587673CC3`.

## How it's made

*(min 280 chars — this is ~5,200)*

**Shape.** A Bun monorepo. One TypeScript app (TanStack Start + React 19, Effect v4, Tailwind v4, Vite, Biome) with **two entrypoints**: `src/server.ts` is the hub (the deployed web app), `src/agent.ts` is a headless rig. Alongside it a Python driver (uv, `lerobot==0.6.0` pinned, MuJoCo, OpenCV) behind one ndjson-RPC protocol, with two interchangeable backends — real SO-101 over Feetech serial, or a MuJoCo sim. The sim model and IK URDF are vendored, so the repo is self-contained and a rig costs zero hardware.

**Transport, and why it's boring on purpose.** The rig dials OUT and never listens: a 50 ms HTTP poll carries telemetry up and control down in the *same* request, and camera frames push separately at 12.5 fps as MJPEG. No WebRTC, no LiveKit, no SDK. That choice buys three things a socket wouldn't: it behaves identically in `vite dev` and in production, it survives a Railway redeploy with no reconnect logic at all, and every hop is curl-debuggable at a hackathon table on venue wifi. A WebSocket input plane sits on top purely for low-latency teleop, with the HTTP mailbox always live as fallback. Authority is a verb table with per-verb argument allowlists, owner/holder tiers and a 15 s command TTL, plus a single-writer lease — so "who may move this arm right now" is one enum, not scattered `if`s.

**Market layer, surgically attached.** All of it is new files plus **one interceptor branch in `server.ts`**, gated on `MARKET_MODE`. Unset, the platform is byte-for-byte the free version — which was also the fallback demo.

**World ID** (`@worldcoin/idkit@4.2.1`): the `IDKitRequestWidget` with the Identity Check preset `minimum_age: 18`, `allow_legacy_proofs: false`. `rp_context` is signed **server-side** per request (`signRequest` from `@worldcoin/idkit-core/signing`, 300 s TTL) and handed to the widget, so the relying-party context can't be swapped by the browser; the result is verified against `POST /api/v4/verify/{rp_id}`. We keep exactly one value out of it — the per-action nullifier — and bind it to the operator's wallet address, so there's no secondary identity store to leak. The deny path is a real HTTP **402** on lease acquisition, not a hidden button.

**0G Compute** (`@0gfoundation/0g-compute-ts-sdk@0.9.0`, Direct SDK, `qwen/qwen2.5-omni-7b`): the grader gets the task string plus the sampled telemetry of the episode and returns `{score, pass}`. We persist the `ZG-Res-Key` chatID, provider address, model, `teeVerified` from `processResponse()`, and sha256 of both request and response — that artifact *is* the proof-of-inference evidence. Concretely that's 0G's **TeeML** path: the provider (`0xa48f0128…`, dstack TEE) is registered on `InferenceServing` with `verifiability: "TeeML"`, and `processResponse()` refuses to return true unless the service is verifiable, the TEE signer is acknowledged on chain, and the enclave's EIP-191 signature over the response `ecrecover`s to the registered signer. We don't verify the TDX remote-attestation quote itself, and we don't touch OpML or ZKML — so the claim stays "TEE-attested signature over the response", never "proof the model ran". `GRADER=zg|local` switches to a heuristic grader, and the fallback is always wired, because a testnet outage should degrade grading, not break the loop. Episode artifacts go to 0G Storage; its Go-style `[value, err]` tuples (not exceptions) caught us once.

**Evidence capture is the subtle part.** `market/sampler.ts` samples the hub's *own* rig state at 5 Hz while a ledger row is open — the operator's claim is never an input to grading. Two realities of the stack forced the design, and both were found the hard way: (1) `rig.joints` **freezes** while the LeRobot recorder owns the robot bus — and every attempt is a recording — so motion evidence comes from the **input plane** (browser axes / leader joint targets), which the hub relays and which cannot freeze; (2) the episode save lands 1–2 s *after* `attempt_finish`, so sampling continues through a grace window and the worker delays grading to match. A "success" claim with no saved episode auto-rejects before a model is even asked.

**Contracts** are Foundry (solc 0.8.x), `SlotMarket.sol` deployed **byte-identical to both** 0G Galileo (16602) and Hedera testnet (296). Booking is staking: `bookSlot(rigId, pinHash)` takes payment and a hash of a PIN only the operator knows, so the 30-minute clock starts at `startSlot` — when they actually show up — not at booking. Per-rig FIFO queue, strikes, `endEarly`, `skipHead`, `cancel`, and a **permissionless** `settle()`.

**The cross-chain link is the hacky bit worth reading.** There is no bridge and no light client between 0G and Hedera, and we didn't build a trusted relay. What crosses is the TEE's own signature: 0G's broker signs each inference response in-enclave with plain EIP-191, and `TeeAttestation.sol` on Hedera re-derives the digest and `ecrecover`s it against the signer address — which the deploy script reads **live from 0G's on-chain registry** rather than hardcoding. Our backend carries bytes it cannot forge; a tampered response reverts. `recordEpisode` on SlotMarket does the same check, which is why the settler key can *choose* a verdict but never *fabricate* one — and can't profit from voiding anyone either, since slashed stakes go to the reward pool, not the treasury. Withholding is the only power it has left: a liveness assumption, not a custody one, because `settle`/`cancel`/`skipHead`/`withdraw` all work without it.

**Hedera** is raw `@hashgraph/sdk` — Crypto Transfer plus an HCS topic for provenance — with mirror-node REST verification of every stake. Four traps, each a real bug first: a stake tx hash must fund exactly one bond or a single payment replays into unlimited attempts; for `ETHEREUMTRANSACTION` the `transaction_id` belongs to the JSON-RPC relay, so the real sender has to be read from `.from` on `/api/v1/contracts/results/{hash}` and long-zero addresses normalized back to the operator's alias; the mirror node reports **tinybar** while MetaMask speaks **wei** (a silent 10¹⁰ error); and the escrow account must already exist at its EVM alias, or the first staker pays ~661k gas for hollow-account creation instead of ~22.8k.

**Settlement** is `market/worker.ts`: a 1 Hz **idempotent** state machine walking every ledger row `closed → graded → paid/rejected → anchored`, every chain call behind a `configured` guard and a try/catch. It is also the "agent" of the payments story — it decides and submits each transfer itself, on the referee's verdict, with no human clicking pay, and it fires on the verdict rather than a timer so the whole cycle fits in one demo take. `viem` in the browser (chain defs, MetaMask), `ethers` on the server (contract calls, EIP-191).

**Deploy** is Railway config-as-code: Dockerfile from the repo root, 1 replica and sleep off — both load-bearing, since the rig registry is in-memory by design and rigs re-register in ~50 ms after a redeploy.

## Describe how AI tools were used in your project

*(optional field — this is ~2,700 chars)*

**Claude Code (Claude Opus 5 and Claude Fable 5) wrote most of this repo.** 71 of 79 commits carry a Claude co-author trailer — the history is public and honest about it. It was used as a pair programmer with a hard leash, not a code generator:

- **A checked-in agent contract.** `AGENTS.md` at the repo root is the working agreement every session loads: how to run the checks (`bun run check` · `typecheck` · `build` · `driver:ast` · `contracts:test`), the deploy topology, and a "hard-won constraints — do not relearn" section (lerobot 0.6.0 version-matching is sacred; Railway has no inbound UDP so no TURN/SFU ever; forge must be 1.5.1-stable because `forge fmt` output differs between versions and CI pins it). Every trap we hit once became a line in that file so it couldn't cost us a second afternoon.
- **`docs/SPEC.md` as the source of truth**, kept explicitly labeled *shipped* vs *not built*. The most useful discipline of the weekend was refusing to let the docs describe things that didn't exist — an agent that reads an aspirational spec confidently builds on top of vapor.
- **Two agents in parallel, with file ownership.** During the hackathon build the market layer and the core hub were developed concurrently by separate agent sessions, so `docs/SPONSORS.md` carries an explicit concurrency contract: one session owned `hub/routes.ts`, `hub/store.ts`, `hub/ws.ts`, `rig/link.ts`, `controller.py`; the other was restricted to **new files plus one interceptor branch in `server.ts`**. That constraint is why the entire market layer is bolt-on and `MARKET_MODE`-gated — the architecture came out of the merge-conflict discipline. A teammate's agent contributed the leader-packet-tracking commits on the same terms.
- **Where it was genuinely load-bearing:** reading unfamiliar SDK surfaces fast and distrusting their docs (0G's shipped `.d.ts` contradicts its documentation on `addLedger`/`depositFund` and `processResponse` arity — we trusted the types), Solidity we could then attack with Foundry tests, and the mirror-node forensics behind the tinybar/wei and `ETHEREUMTRANSACTION` sender bugs.
- **Where it wasn't:** every claim about the physical arm was verified by moving the physical arm. No agent can tell you that `rig.joints` freezes while the LeRobot recorder owns the robot bus — we found that by grading an attempt and watching the evidence come back empty.

Separately, **AI is the product, not just the tooling**: the market's referee is a TEE-attested model on 0G Compute (`qwen/qwen2.5-omni-7b`), and the whole point of the platform is producing labeled LeRobot episodes to train robot policies (ACT / SmolVLA) — see the Description and How it's made fields.

## Notes

- Repo: public, MIT-ish, `README.md` carries the same architecture with per-sponsor deep dives in `docs/market/{WORLD,HEDERA,0G}.md`.
- Video: ≤3 min master cut (satisfies all three sponsor limits).
