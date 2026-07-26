# Hedera — AI & Agentic Payments (Hands Unchained market layer)

**Track:** AI & Agentic Payments on Hedera. **What qualifies:** the grading
agent autonomously executes real HBAR transfers on **testnet** — no human
clicks "pay", ever. Raw `@hashgraph/sdk`, two native services (Crypto
Transfer + HCS), zero Solidity on Hedera.

## Payment flow mechanics (read this section, judges)

**The operator holds their own keys.** They connect MetaMask on Hedera
testnet (chain 296 — viem ships the chain definition), fund it from the
[faucet](https://portal.hedera.com/faucet), and sign the stake themselves.
The hub never derives, holds or sees an operator key; it only verifies the
transaction they already signed.

Per graded attempt:

| Step | Transfer | Trigger |
|---|---|---|
| **Stake** | operator's wallet → escrow, `BOND_HBAR` (0.5) | the operator signs it in MetaMask; the hub verifies the tx hash against the mirror node before granting the lease |
| **Pass** | escrow + treasury → operator's wallet, **one atomic tx** (stake back + `BONUS_HBAR`) | the settlement worker, **autonomously**, on the 0G referee's verdict |
| **Slash** | escrow → treasury | operator **claimed success** but the TEE referee failed the episode |
| **Honest discard** | escrow → operator's wallet, no bonus | operator discarded or abandoned — only graded work pays |

The decision-maker for every transfer is the grading agent
(`apps/web/src/market/worker.ts`, a 1 Hz state machine) acting on the 0G
Compute verdict — an agent paying a human for verified work. Settlement
fires on the verdict, not a timer.

**Verification details that matter** (each was a real trap):
- A stake tx hash may fund exactly one bond, or one payment could be replayed
  into unlimited attempts.
- The sender is **not** the transaction payer: for `ETHEREUMTRANSACTION` the
  `transaction_id` belongs to the JSON-RPC relay's account. We read `.from`
  from `/api/v1/contracts/results/{hash}` and normalise "long-zero" addresses
  to the operator's real alias so they see their own wallet.
- Mirror-node amounts are **tinybar** while MetaMask spoke **wei** — a silent
  10^10 error if mixed.
- The escrow account must already exist at its EVM alias, or the first staker
  pays ~661k gas for hollow-account creation instead of ~22.8k.

## The cross-chain link (this is the interesting part)

The grading happens on 0G; the money is on Hedera. Rather than trusting our
backend to relay the verdict, **a Hedera contract verifies 0G's TEE
signature itself**: `contracts/TeeAttestation.sol`, deployed at
[`0xE6ad861D…673CC3`](https://hashscan.io/testnet/contract/0xE6ad861D1c18d2FeFe18b49bCa1B407587673CC3).

0G's broker signs every inference response inside the enclave with plain
EIP-191 over `"<reqSha256>:<respSha256>:<type>:<identity>:<tlsFingerprint>"`,
so the contract rebuilds that string from the raw response bytes, derives the
digest and `ecrecover`s it. Hedera cannot read 0G's registry, so the signer
address is pinned at deploy — but `scripts/deploy-tee-attestation.ts` reads
it **live from 0G's InferenceServing contract on Galileo**, so the constant
is auditable in seconds and is not a per-verdict oracle.

Feed it a tampered response body and it reverts. That is what makes it real
rather than decorative.

## HCS audit trail (bonus criterion)

One topic, created at boot and pinned via `HCS_TOPIC_ID`. Every graded
attempt submits a **≤1024-byte digest** (hard-asserted — the HCS single-
message cap): `{v, attemptId, rig, task, nullifier₁₆, account, claimed,
score, pass, gradeProvider, payoutTx, zgChatID₂₄, teeVerified, zgRoot₂₄}` —
one message binding the World-verified human, the 0G grade and the Hedera
payout. On boot the hub **rehydrates** dashboard totals from the Mirror Node
(`/api/v1/topics/{id}/messages`), so HCS is the durable ledger and hub
memory is only a cache.

## Setup

```sh
# 1. portal.hedera.com testnet account (1000 ℏ)
# 2. isolated smoke test BEFORE wiring the demo:
cd apps/web
HEDERA_OPERATOR_ID=0.0.x HEDERA_OPERATOR_KEY=... MARKET_SECRET=... \
  bun scripts/smoke-hedera.ts
# prints Hashscan links for: derived account, bond, bonus, release, digest
# 3. pin HCS_TOPIC_ID + HEDERA_ESCROW_ID from its output into the env
```

Code: `apps/web/src/market/hedera.ts` (transfers, HCS, mirror rehydrate) ·
`apps/web/src/market/worker.ts` (the autonomous agent).

## Live artifacts (testnet, 2026-07-25)

| What | Link |
|---|---|
| Treasury / operator account | [`0.0.9700388`](https://hashscan.io/testnet/account/0.0.9700388) |
| Escrow account (bonds) | [`0.0.9746375`](https://hashscan.io/testnet/account/0.0.9746375) |
| **HCS provenance topic** | [`0.0.9746374`](https://hashscan.io/testnet/topic/0.0.9746374) |
| Autonomous bonus payout (0.5 ℏ, paid on a 0G `pass`) | [`0.0.9700388-1784993892-227625527`](https://hashscan.io/testnet/transaction/0.0.9700388-1784993892-227625527) |
| Bond lock (operator → escrow) | [`0.0.9700388-1784992610-550787196`](https://hashscan.io/testnet/transaction/0.0.9700388-1784992610-550787196) |
| Bond release (escrow → operator) | [`0.0.9700388-1784992611-089534480`](https://hashscan.io/testnet/transaction/0.0.9700388-1784992611-089534480) |
| Example derived operator account | [`0.0.9746646`](https://hashscan.io/testnet/account/0.0.9746646) |

Digest as written to the topic (one message per graded attempt, 235 bytes):

```json
{"v":1,"a":"att-ms0iil5v-1","rig":"kris-sim","task":"t1","n":"…","acct":"0.0.9746373",
 "claimed":"success","s":100,"p":true,"gp":"0g-compute","tx":"0.0.9700388-…","zg":"…","tee":true,"root":"0x…"}
```

Verified end to end on 2026-07-25: one sim-rig attempt → 0G verdict
(`score 80, teeVerified true`) → autonomous 0.5 ℏ bonus → HCS seq 5 → 0G
Storage root → EpisodeRegistry event. A restart of the hub then rehydrated
its running totals from this topic, proving HCS is the durable ledger.
