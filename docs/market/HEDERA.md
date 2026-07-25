# Hedera — AI & Agentic Payments (Proof of Hands market layer)

**Track:** AI & Agentic Payments on Hedera. **What qualifies:** the grading
agent autonomously executes real HBAR transfers on **testnet** — no human
clicks "pay", ever. Raw `@hashgraph/sdk`, two native services (Crypto
Transfer + HCS), zero Solidity on Hedera.

## Payment flow mechanics (read this section, judges)

Every verified human operator gets a **derived custodial testnet account**:
the hub computes `HMAC-SHA256(MARKET_SECRET, worldIdNullifier)` → ECDSA key →
recovers the account id from the mirror node by EVM-address alias, creating
it with `AccountCreateTransaction().setECDSAKeyWithAlias(pub)
.setInitialBalance(new Hbar(1))` on first sight. No key is ever stored; the
hub is stateless across redeploys. (Custody is the weekend shortcut — stated
openly; threshold-key escrow is the roadmap.)

Per driving session on a rig:

| Step | Transfer | Trigger |
|---|---|---|
| **Bond lock** | operator → escrow, `BOND_HBAR` (0.5) | first `attempt_start` — skin in the game before actuating hardware |
| **Bonus** | treasury → operator, `BONUS_HBAR` (0.5) | the settlement worker, **autonomously**, the moment the 0G referee passes an episode |
| **Release** | escrow → operator | operator walks away with no fraud verdict |
| **Slash** | escrow → treasury | operator **claimed success** but the TEE referee failed the episode |

The decision-maker for every transfer is the grading agent
(`apps/web/src/market/worker.ts`, a 1 Hz state machine) acting on the 0G
Compute verdict — an agent paying a human for verified work.

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
