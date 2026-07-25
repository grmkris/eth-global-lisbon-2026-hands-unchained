/**
 * Isolated Hedera staking smoke test — run BEFORE touching any UI.
 *
 *   cd apps/web
 *   set -a; source .env.market; set +a
 *   bun scripts/smoke-stake.ts                      # inspect escrow, print what to pin
 *   STAKE_TX_HASH=0x… bun scripts/smoke-stake.ts    # verify a real MetaMask stake
 *   PAYOUT_TO=0x… bun scripts/smoke-stake.ts        # settle a fake bond out to a wallet
 *
 * Proves the three things the whole non-custodial design rests on:
 *   1. the escrow account EXISTS at its EVM alias (so stakers pay ~22.8k gas,
 *      not the ~661k hollow-account-creation price)
 *   2. a MetaMask transaction to that alias is verifiable from the mirror node
 *   3. we can spend what lands there, out to an arbitrary EVM address
 */
export {};
process.env.MARKET_MODE = "1";

const { HEDERA, BOND_HBAR } = await import("#/market/config");
const { escrowKey, escrowEvmAddress, ensureEscrow, verifyStakeTx, settleToOperator } =
	await import("#/market/hedera");

if (!HEDERA.configured) throw new Error("HEDERA_OPERATOR_ID/KEY unset");

const MIRROR = "https://testnet.mirrornode.hedera.com";

console.log("1) escrow key + address");
const key = escrowKey();
const evm = escrowEvmAddress();
console.log(`   EVM address : ${evm}`);
console.log(`   pin this    : HEDERA_ESCROW_KEY=0x${key.toStringRaw()}`);

console.log("\n2) escrow account on-chain");
const acct = (await fetch(`${MIRROR}/api/v1/accounts/${evm}`)
	.then((r) => (r.ok ? r.json() : null))
	.catch(() => null)) as {
	account?: string;
	balance?: { balance: number };
	receiver_sig_required?: boolean;
} | null;

if (!acct?.account) {
	console.log("   ⚠️  NOT FOUND at that alias — stakers would pay ~661k gas to");
	console.log("      create it. Creating it now with a 0 ℏ balance…");
	const created = await ensureEscrow();
	console.log(`   created ${created.accountId}`);
} else {
	console.log(`   account id  : ${acct.account}`);
	console.log(`   balance     : ${(acct.balance?.balance ?? 0) / 1e8} ℏ`);
	console.log(
		`   receiver_sig_required: ${acct.receiver_sig_required} ${
			acct.receiver_sig_required ? "❌ inbound transfers WILL FAIL" : "✅"
		}`,
	);
}

const stakeHash = process.env.STAKE_TX_HASH;
if (stakeHash) {
	console.log(`\n3) verifying stake tx ${stakeHash}`);
	const proof = await verifyStakeTx(stakeHash, BOND_HBAR);
	console.log(`   from   : ${proof.from}`);
	console.log(`   amount : ${proof.amountHbar} ℏ  (needed ≥ ${BOND_HBAR})`);
	console.log("   ✅ a MetaMask stake is verifiable end to end");
} else {
	console.log("\n3) skipped — set STAKE_TX_HASH=0x… after sending 0.5 ℏ to");
	console.log(`   ${evm} from MetaMask on Hedera testnet (chain 296)`);
}

const payoutTo = process.env.PAYOUT_TO;
if (payoutTo) {
	console.log(`\n4) settling a fake bond out to ${payoutTo}`);
	const txId = await settleToOperator(
		{
			nullifier: "smoke",
			evmAddress: payoutTo,
			stakeTxHash: stakeHash ?? "0xsmoke",
			status: "locked",
			settleTxId: null,
			amountHbar: BOND_HBAR,
			lockedAt: Date.now(),
			lastActiveAt: Date.now(),
		},
		"released",
	);
	console.log(`   https://hashscan.io/testnet/transaction/${txId}`);
	console.log("   ✅ escrow can pay an arbitrary EVM address (stake + bonus)");
} else {
	console.log("\n4) skipped — set PAYOUT_TO=0x… to test the payout leg");
}

console.log("\ndone.");
process.exit(0);
