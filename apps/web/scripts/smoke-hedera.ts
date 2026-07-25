/**
 * Isolated Hedera smoke test — run BEFORE wiring anything into the demo:
 *
 *   cd apps/web
 *   HEDERA_OPERATOR_ID=0.0.x HEDERA_OPERATOR_KEY=302e... MARKET_SECRET=... \
 *     bun scripts/smoke-hedera.ts
 *
 * Exercises the exact calls the worker makes: derived operator account
 * (create + mirror recovery), bond lock, bonus, release, HCS digest, mirror
 * read-back. Prints Hashscan links for every artifact.
 */
export {};
process.env.MARKET_MODE = "1";

const {
	ensureOperatorAccount,
	ensureTopic,
	submitBondLock,
	submitBonus,
	settleBond,
	submitDigest,
} = await import("#/market/hedera");
const { openRow, closeRow, putBond, getBond } = await import("#/market/store");

const nullifier = `smoke-${Date.now().toString(36)}`;
console.log(`nullifier: ${nullifier}`);

console.log("1) derived operator account…");
const { accountId } = await ensureOperatorAccount(nullifier);
console.log(`   account: ${accountId}  https://hashscan.io/testnet/account/${accountId}`);

console.log("2) recovery path (same nullifier -> same account, via mirror)…");
const again = await ensureOperatorAccount(nullifier);
if (again.accountId !== accountId) throw new Error("derivation not stable!");
console.log("   recovered OK");

console.log("3) HCS topic…");
const topicId = await ensureTopic();
console.log(`   topic: ${topicId}  https://hashscan.io/testnet/topic/${topicId}`);

console.log("4) bond lock (operator -> escrow)…");
putBond({
	nullifier,
	rig: "smoke-rig",
	status: "locked",
	lockTxId: null,
	settleTxId: null,
	amountHbar: Number(process.env.BOND_HBAR ?? 0.5),
	lockedAt: Date.now(),
	lastActiveAt: Date.now(),
});
const bond = getBond(nullifier, "smoke-rig");
if (!bond) throw new Error("bond missing");
bond.lockTxId = await submitBondLock(bond);
console.log(`   lock tx: https://hashscan.io/testnet/transaction/${bond.lockTxId}`);

console.log("5) bonus (treasury -> operator, the autonomous payment)…");
const row = openRow({ rig: "smoke-rig", taskId: "smoke", clientId: "op-smoke" });
row.operator.nullifier = nullifier;
closeRow("smoke-rig", "success");
row.grade = {
	score: 100,
	pass: true,
	provider: "local",
	reason: "smoke",
	proof: null,
};
row.payment = {
	kind: "bonus",
	txId: await submitBonus(row),
	amountHbar: Number(process.env.BONUS_HBAR ?? 0.5),
};
console.log(`   bonus tx: https://hashscan.io/testnet/transaction/${row.payment.txId}`);

console.log("6) bond release (escrow -> operator)…");
bond.settleTxId = await settleBond(bond, "released");
console.log(`   release tx: https://hashscan.io/testnet/transaction/${bond.settleTxId}`);

console.log("7) HCS digest…");
const seq = await submitDigest(row);
console.log(`   sequence ${seq}  https://hashscan.io/testnet/topic/${topicId}`);

console.log("8) mirror read-back (may lag a few seconds)…");
await new Promise((r) => setTimeout(r, 6_000));
const mirror = await fetch(
	`https://testnet.mirrornode.hedera.com/api/v1/topics/${topicId}/messages?limit=5&order=desc`,
).then((r) => r.json() as Promise<{ messages: Array<{ message: string }> }>);
console.log(
	`   latest message: ${Buffer.from(mirror.messages[0]?.message ?? "", "base64").toString("utf8")}`,
);

console.log("\nALL GOOD — export these on Railway to pin the artifacts:");
console.log(`  HCS_TOPIC_ID=${topicId}`);
process.exit(0);
