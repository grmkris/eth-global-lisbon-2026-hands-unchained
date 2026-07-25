/**
 * Market-layer configuration — all env reads in one place (pattern:
 * src/api/config.ts). The entire market layer is OFF unless MARKET_MODE=1,
 * and every module must behave as a no-op when disabled so the standalone
 * platform stays byte-identical (it is the fallback demo).
 */
import { randomBytes } from "node:crypto";

export const marketEnabled = (): boolean => process.env.MARKET_MODE === "1";

/** Signs session cookies and derives operator Hedera keys. A missing secret
 * gets a per-boot random one (sessions die on redeploy — fine for dev, loud
 * warning so it is never silently the case in production). */
const bootSecret = (): string => {
	const env = process.env.MARKET_SECRET;
	if (env) return env;
	if (marketEnabled())
		console.error(
			"[market] MARKET_SECRET unset — using a per-boot secret; sessions and derived accounts will NOT survive a redeploy",
		);
	return randomBytes(32).toString("hex");
};
export const MARKET_SECRET = bootSecret();

/** Local dev only: every session request auto-mints a verified session so the
 * full ledger→grade→pay loop is testable before World credentials exist.
 * NEVER set on Railway — production sessions require a real World ID proof. */
export const DEV_AUTOVERIFY = process.env.MARKET_DEV_AUTOVERIFY === "1";

/** zg (0G Direct SDK) | zg-router (OpenAI-compatible) | local (heuristics).
 * Whatever is picked, errors always fall back to local — grading can degrade
 * but never break the loop. */
export const GRADER = process.env.GRADER ?? "local";

export const BOND_HBAR = Number(process.env.BOND_HBAR ?? 0.5);
export const BONUS_HBAR = Number(process.env.BONUS_HBAR ?? 0.5);

export const HEDERA = {
	operatorId: process.env.HEDERA_OPERATOR_ID ?? "",
	operatorKey: process.env.HEDERA_OPERATOR_KEY ?? "",
	topicId: process.env.HCS_TOPIC_ID ?? "",
	escrowId: process.env.HEDERA_ESCROW_ID ?? "",
	get configured(): boolean {
		return this.operatorId !== "" && this.operatorKey !== "";
	},
};

export const ZG = {
	privateKey: process.env.ZG_PRIVATE_KEY ?? "",
	rpc: process.env.ZG_RPC ?? "https://evmrpc-testnet.0g.ai",
	provider: process.env.ZG_PROVIDER ?? "",
	routerKey: process.env.ZG_ROUTER_KEY ?? "",
	/** testnet router is NOT router-api.0g.ai (that's mainnet) */
	routerUrl:
		process.env.ZG_ROUTER_URL ??
		"https://router-api-testnet.integratenetwork.work/v1",
	routerModel: process.env.ZG_ROUTER_MODEL ?? "",
	registryAddress: process.env.ZG_REGISTRY_ADDRESS ?? "",
	storageIndexer:
		process.env.ZG_STORAGE_INDEXER ??
		"https://indexer-storage-testnet-turbo.0g.ai",
};

export const WORLD = {
	appId: process.env.WORLD_APP_ID ?? "",
	rpId: process.env.WORLD_RP_ID ?? "",
	/** RP ECDSA signing key (hex) from the Developer Portal — signs rp_context */
	rpKey: process.env.WORLD_RP_KEY ?? "",
	apiKey: process.env.WORLD_API_KEY ?? "",
	action: process.env.WORLD_ACTION ?? "drive-a-rig",
	/** identity-check (min age 18 + liveness) | proof-of-human (fallback if
	 * the Identity Check preview is not granted at the booth). */
	preset: process.env.WORLD_PRESET ?? "identity-check",
	get configured(): boolean {
		return this.appId !== "" && this.rpId !== "";
	},
};
