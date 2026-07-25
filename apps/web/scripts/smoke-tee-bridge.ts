/**
 * Prove the cross-chain link with one real grade:
 *   0G Compute grades → its TEE signs → a HEDERA contract ecrecovers that
 *   signature and accepts (or rejects) it.
 *
 *   cd apps/web
 *   set -a; source .env.market; set +a
 *   TEE_ATTESTATION_ADDRESS=0x… bun scripts/smoke-tee-bridge.ts
 */
export {};
process.env.MARKET_MODE = "1";

const { closeRow, openRow } = await import("#/market/store");
const { gradeZg } = await import("#/market/grader/zg");
const { attestationParts, verifyAttestation, recordGradeOnHedera } = await import(
	"#/market/tee-bridge"
);

const row = openRow({ rig: "bridge-smoke", taskId: "t1", clientId: "op-smoke" });
row.taskTitle = "push the cube into the corner";
row.operator.evmAddress = "0x0973e60fe117935b82a887761c6e0241d2aa7d44";
row.telemetry = {
	durationS: 41.2,
	jointTravelDeg: 590,
	commandedMotion: 48,
	inputPackets: 620,
	gripperCycles: 3,
	episodeSaved: true,
	samples: 200,
	episode: {
		episodeIndex: 0,
		frames: 1240,
		durationS: 41.3,
		jointPathDeg: 812.4,
		maxJointRangeDeg: 96.2,
		gripperCycles: 3,
		stillFraction: 0.12,
	},
};
closeRow("bridge-smoke", "success");

console.log("1) grading on 0G Compute (TEE)…");
row.grade = await gradeZg(row);
const proof = row.grade.proof as Record<string, unknown>;
console.log(`   verdict     : ${row.grade.score} ${row.grade.pass ? "PASS" : "FAIL"}`);
console.log(`   teeVerified : ${proof.teeVerified}`);
console.log(`   chatID      : ${proof.chatID}`);

console.log("\n2) the TEE's own signature over that response");
const parts = attestationParts(row);
if (!parts) throw new Error("no attestation captured — cannot bridge");
console.log(`   reqHash : ${parts.requestHashHex.slice(0, 24)}…`);
console.log(`   tlsFp   : ${parts.tlsFingerprintHex.slice(0, 24)}…`);
console.log(`   sig     : ${parts.signature.slice(0, 26)}…`);

console.log("\n3) asking the HEDERA contract to verify it (read-only)…");
const ok = await verifyAttestation(parts);
console.log(`   contract says: ${ok ? "✅ signed by 0G's TEE" : "❌ REJECTED"}`);
if (!ok) throw new Error("Hedera could not verify the 0G attestation");

console.log("\n4) a tampered response must be REJECTED…");
const tampered = await verifyAttestation({
	...parts,
	responseBody: `${parts.responseBody} `,
});
console.log(`   contract says: ${tampered ? "❌ ACCEPTED (BAD!)" : "✅ rejected"}`);
if (tampered) throw new Error("contract accepted a forged response");

console.log("\n5) writing the verified grade on-chain…");
const hash = await recordGradeOnHedera(row);
console.log(`   https://hashscan.io/testnet/transaction/${hash}`);

console.log("\n✅ 0G graded it, Hedera verified the TEE signature in-contract.");
process.exit(0);
