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

## Live artifacts

<!-- filled after smoke test / demo day -->
- Topic: `https://hashscan.io/testnet/topic/<HCS_TOPIC_ID>`
- Example bonus payout: `https://hashscan.io/testnet/transaction/<txid>`
- Example slash: `https://hashscan.io/testnet/transaction/<txid>`
