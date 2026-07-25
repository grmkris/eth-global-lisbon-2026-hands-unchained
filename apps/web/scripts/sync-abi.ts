/**
 * Copy the SlotMarket ABI out of Foundry's build output and into apps/web as a
 * committed TypeScript module.
 *
 *   bun run contracts:abi        (from the repo root)
 *
 * WHY THIS EXISTS. `apps/web/Dockerfile` copies only package.json, bun.lock and
 * apps/web/ — `contracts/` is never in the production image — and railway.toml
 * watches only `apps/web/**`. So the hub cannot import from `contracts/out/`,
 * and widening either would touch the deploy topology that AGENTS.md flags as
 * load-bearing. The ABI therefore travels as a generated, committed file that
 * lives inside apps/web like any other source.
 *
 * Generated, not hand-written: the two existing chain clients
 * (market/zg-chain.ts, market/tee-bridge.ts) hand-write 1-3 human-readable
 * fragments each, which is fine at that size. SlotMarket has ~25 functions and
 * 12 events the UI decodes, and a hand-copied ABI that drifts from the deployed
 * contract fails at runtime with an unhelpful decode error.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
const artifact = `${root}/contracts/out/SlotMarket.sol/SlotMarket.json`;
const target = `${root}/apps/web/src/market/abi/slot-market.ts`;

let raw: string;
try {
	raw = readFileSync(artifact, "utf8");
} catch {
	console.error(
		`no build artifact at ${artifact}\nrun: cd contracts && forge build`,
	);
	process.exit(1);
}

const { abi } = JSON.parse(raw) as { abi: ReadonlyArray<unknown> };
if (!Array.isArray(abi) || abi.length === 0)
	throw new Error("artifact has no abi — did forge build succeed?");

// a Map, not an object literal: one of the ABI entry types is literally
// "constructor", which on a plain object resolves to Object.prototype's
const counts = new Map<string, number>();
for (const entry of abi) {
	const type = (entry as { type?: string }).type ?? "unknown";
	counts.set(type, (counts.get(type) ?? 0) + 1);
}

const body = `/**
 * GENERATED — do not edit. Run \`bun run contracts:abi\` after changing
 * contracts/src/SlotMarket.sol.
 *
 * Committed on purpose: contracts/ is not in the production Docker image, so
 * this file is the hub's and the browser's only route to the ABI. See
 * apps/web/scripts/sync-abi.ts for why.
 */
export const slotMarketAbi = ${JSON.stringify(abi, null, "\t")} as const;
`;

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, body);

// Hand it to biome rather than trying to emit biome-shaped JSON by hand:
// `bun run check` covers every file in apps/web, and a generated file that
// fails the repo's own formatter is a broken build nobody caused.
const fmt = Bun.spawnSync(["bunx", "biome", "format", "--write", target], {
	cwd: `${root}/apps/web`,
	stderr: "pipe",
});
if (fmt.exitCode !== 0)
	console.error(`biome format failed:\n${fmt.stderr.toString()}`);
console.error(
	`wrote ${target.replace(`${root}/`, "")} — ${[...counts]
		.map(([k, v]) => `${v} ${k}`)
		.join(", ")}`,
);
