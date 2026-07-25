/**
 * Isolated 0G smoke test — run BEFORE flipping GRADER=zg on the hub:
 *
 *   cd apps/web
 *   ZG_PRIVATE_KEY=0x… ZG_PROVIDER=0x… bun scripts/smoke-zg.ts          # Direct SDK
 *   ZG_PRIVATE_KEY=0x… ZG_ROUTER_KEY=sk-… GRADER=zg-router bun scripts/smoke-zg.ts
 *
 * With no ZG_PROVIDER it lists the current provider catalog (read-only, no
 * funds needed) so you can pick one at the booth.
 */
export {};
process.env.MARKET_MODE = "1";

const { ZG } = await import("#/market/config");
const { openRow, closeRow } = await import("#/market/store");

if (!ZG.provider && !ZG.routerKey) {
	console.log("no ZG_PROVIDER / ZG_ROUTER_KEY — listing providers (read-only)…");
	const { createZGComputeNetworkReadOnlyBroker } = await import(
		"@0gfoundation/0g-compute-ts-sdk"
	);
	const ro = await createZGComputeNetworkReadOnlyBroker(ZG.rpc);
	const services = await ro.inference.listService();
	for (const s of services)
		console.log(
			` provider ${(s as { provider: string }).provider}  model ${(s as { model?: string }).model ?? "?"}`,
		);
	console.log("\npick one -> export ZG_PROVIDER=<address> and rerun");
	process.exit(0);
}

// a realistic passing row
const row = openRow({ rig: "smoke-rig", taskId: "smoke", clientId: "op-smoke" });
row.taskTitle = "push the cube into the corner";
row.operator.nullifier = "smoke-nullifier";
row.telemetry = {
	durationS: 42.3,
	jointTravelDeg: 618,
	commandedMotion: 55,
	inputPackets: 700,
	gripperCycles: 3,
	episodeSaved: true,
	samples: 210,
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
closeRow("smoke-rig", "success");

const useRouter = (process.env.GRADER ?? "zg") === "zg-router";
console.log(`grading via ${useRouter ? "0G Router" : "0G Direct SDK"}…`);
const started = Date.now();
const grade = useRouter
	? await (await import("#/market/grader/zg-router")).gradeZgRouter(row)
	: await (await import("#/market/grader/zg")).gradeZg(row);
console.log(`\nverdict in ${((Date.now() - started) / 1000).toFixed(1)}s:`);
console.log(JSON.stringify(grade, null, 2));

if (!useRouter) {
	const tee = (grade.proof as { teeVerified?: boolean | null })?.teeVerified;
	console.log(
		tee === true
			? "\nTEE-attested signature VERIFIED — screenshot this for the video"
			: `\nteeVerified=${tee} — response not TEE-verified (null = no chatID header)`,
	);
}
process.exit(0);
