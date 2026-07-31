# BOT Chain Pilot — mini spec

_Draft proposal for the BOT Chain working group (Leon, ecosystem/technical/delivery).
Status: **proposal** — nothing here is deployed yet. 2026-07-31._

## Summary

Deploy Hands Unchained's booking + settlement layer to **BOT Chain testnet and
mainnet**, and run a persistent fleet of **four simulated rigs** — two settled on
testnet, two on mainnet — with two robot types: the SO-101 arm (ships today) and a
walking quadruped (new, makes the demo interactive). 30-day live window.
**All-in pilot price: $500, paid in USDC on-chain.** BOT Chain covers deployment gas
and the on-chain reward pool (per Leon's offer).

## 1. Chain deployment

| | Testnet | Mainnet |
|---|---|---|
| Chain ID | 968 | 677 |
| RPC | `https://rpc.bohr.life` | `https://rpc.botchain.ai` |
| Explorer | scan.bohr.life | scan.botchain.ai |
| Gas | tBOT (faucet.botchain.ai/basic) | BOT (sponsored) |

- **Contract:** `SlotMarket.sol` only — booking-is-staking, FIFO queue, strikes,
  permissionless `settle()`. `EpisodeRegistry.sol` optional add-on.
  `TeeAttestation.sol` is 0G-specific and out of scope.
- **Compatibility: verified live** (2026-07-31): both RPCs run a current Geth fork
  (`Geth/v1.5.13`, July 2026 builds) with Cancun fields active (`excessBlobGas`
  present) — our existing `solc 0.8.28 / evm_version = cancun / via-IR` artifacts
  deploy **unchanged**. Base fee is 0 on both networks, so fees are near-zero.
- **Work:** add both networks to `contracts/foundry.toml` `[rpc_endpoints]`; deploy
  via the existing `forge script`; add viem/ethers custom chain defs so the browser
  booking flow (MetaMask) and the 1 Hz settlement worker target BOT Chain; the
  operator's chain picker gains "BOT testnet" / "BOT mainnet".
- **Sequence:** testnet first, full booking → drive → settle loop verified, then the
  same command against mainnet. Estimated chain-side effort: ~half a day plus
  explorer verification.
- **Keys:** one settler key per network, funded with (t)BOT. Stakes and payouts
  denominate in native BOT, same as the HBAR/0G flows today.

## 2. Rig fleet — 4 persistent sim rigs, 2 robot types

One GPU server runs all four driver processes (each sim: 30 Hz MuJoCo physics +
two 640×480 cameras at ~20 fps — light; four fit comfortably on one
workstation-class GPU):

| Rig | Robot | Settles on | Status |
|---|---|---|---|
| `arm-testnet` | SO-101 arm (MuJoCo) | BOT testnet | ships today |
| `arm-mainnet` | SO-101 arm (MuJoCo) | BOT mainnet | ships today |
| `quad-testnet` | Quadruped (walks) | BOT testnet | **new work** |
| `quad-mainnet` | Quadruped (walks) | BOT mainnet | **new work** |

- **Arm tasks:** existing ("push the cube into the corner" etc.), each graded
  attempt = one labeled LeRobot episode.
- **Quadruped:** MuJoCo Menagerie model (e.g. Unitree Go2) with velocity-command
  teleop (drive it around like an RC dog, task = "walk to the marker"). This is the
  interactive crowd-pleaser; it reuses the existing input plane (axes → velocity)
  but needs a gait controller — the one genuinely new engineering item, scoped as
  such. Fallback if the gait work overruns: 4× arm rigs with different tasks.
- Rigs dial **out** only (HTTPS) — no inbound ports; hub stays on Railway. Our team
  (Kristjan + Lisa) owns deployment and maintenance and keeps the fleet live; the
  BOT Chain team can test any rig at any time through the normal lobby flow.

## 3. Server

Requirement: 8+ cores, 32–64 GB RAM, one RTX A4000 / RTX 4000 Ada-class GPU
(headless EGL rendering). Candidates:

- **Hetzner GEX44** (RTX 4000 SFF Ada 20 GB, i5-13500, 64 GB) — €184/mo + €79 setup,
  dedicated, EU. Preferred for a 24/7 pilot.
- Cloud A4000-class (Hyperstack/RunPod) — ~$110–150/mo, faster to provision.

The GPU box runs sim rendering + episode recording only — **no model training**.

## 4. Grading

Pilot uses the heuristic grader (`GRADER=local`) — deterministic, no external
dependency, can reject but never strike. Optional stretch: keep TEE-attested grading
on 0G Compute with the verdict settled on BOT Chain (the same enclave-signature
pattern we run against Hedera today).

## 5. Pricing — **$500 USDC upfront** (deployment + first month)

| Item | Amount |
|---|---|
| GPU server, 1 month (incl. setup) | $200 |
| Deployment engineering: contracts on 2 networks, chain integration, 4-rig fleet, quadruped teleop | $200 |
| Ops: 30-day monitoring, weekly stats, final report | $100 |
| **Total (upfront)** | **$500 USDC** |

Running cost after the first month is much lower — essentially the GPU server plus
light ops, ~**$200/mo** — so keeping the fleet live beyond the pilot window is cheap
and can be agreed separately (e.g. as part of the Phase 2 sponsorship).

- Paid **on-chain in USDC** — on BOT Chain if native/bridged USDC exists there,
  otherwise Base (address provided in the working group). 50% on kickoff, 50% on
  Phase 1 acceptance (first verifiable mainnet settlement).
- **BOT Chain provides:** deployment gas (both networks), mainnet BOT for the
  operator reward pool, explorer-verification support.
- **Excluded:** real-arm hardware and hosting (that's the Phase 2 sponsorship
  discussion), TEE grading infra, anything past the 30-day window.

## 6. Success metrics (mirrors Leon's Phase 2 list, measured from day 1)

Rig uptime/availability · completed bookings and remote tasks · on-chain
transactions + settlement volume (BOTScan links) · unique verified operators ·
labeled episodes / training-data hours collected · actual operating cost.

## 7. Timeline

- **Week 1** — SlotMarket on testnet, 2 arm rigs live, full loop verified
  end-to-end; mainnet deploy once compatibility is confirmed on testnet.
- **Week 2** — quadruped rigs live on both networks; public dashboard shows the fleet.
- **Weeks 3–4** — open pilot window: BOT Chain team + community book and drive;
  weekly stats; final report + Phase 2 (live real-arm) proposal.

## 8. Open questions for the BOT Chain team

1. Contract verification on BOTScan — Etherscan-compatible API or manual?
2. Is there native/bridged **USDC on BOT Chain**, or should payment settle on Base?
3. Mechanics of the gas sponsorship (direct transfer to our deployer/settler keys?).
4. Reward-pool sizing: how much BOT should back operator bonuses for the pilot?
