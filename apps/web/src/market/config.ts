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

/** `wallet` = the operator stakes their own HBAR from MetaMask (the product).
 * `custodial` = the old hub-funded path, kept only as a break-glass rollback
 * if the wallet flow fails during a live demo. Never advertised. */
export const STAKE_MODE = process.env.STAKE_MODE ?? "wallet";

export const HEDERA = {
	operatorId: process.env.HEDERA_OPERATOR_ID ?? "",
	operatorKey: process.env.HEDERA_OPERATOR_KEY ?? "",
	topicId: process.env.HCS_TOPIC_ID ?? "",
	escrowId: process.env.HEDERA_ESCROW_ID ?? "",
	/** Escrow's private key. Explicit beats derived now that exactly one
	 * hub-held key exists (see docs/market/HEDERA.md). */
	escrowKey: process.env.HEDERA_ESCROW_KEY ?? "",
	get configured(): boolean {
		return this.operatorId !== "" && this.operatorKey !== "";
	},
};

/** Hedera testnet EVM — the chain the operator's MetaMask talks to. viem
 * ships the full chain definition (`hederaTestnet`); this is only what the
 * server needs to state in /api/market/config. */
export const HEDERA_EVM = {
	chainId: 296,
	rpc: process.env.HEDERA_EVM_RPC ?? "https://testnet.hashio.io/api",
	mirror: "https://testnet.mirrornode.hedera.com",
	faucet: "https://portal.hedera.com/faucet",
};

/** The cross-chain proof link: a Hedera contract that ecrecovers 0G's TEE
 * signature (see market/tee-bridge.ts). Unset = the market runs exactly as
 * before, just without the on-chain attestation step. */
export const TEE_BRIDGE = {
	address: process.env.TEE_ATTESTATION_ADDRESS ?? "",
	key: process.env.HEDERA_EVM_KEY ?? process.env.HEDERA_OPERATOR_KEY ?? "",
	get configured(): boolean {
		return this.address !== "" && this.key !== "";
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
	/** staging (default — simulator, no Orb, what the demo runs on) |
	 * production. The RP is registered in BOTH registries, so the same
	 * app_id/rp_id/key work either way. Asserted server-side on verify:
	 * without that check a simulator proof could mint a production session. */
	env: process.env.WORLD_ENV ?? "staging",
	get configured(): boolean {
		return this.appId !== "" && this.rpId !== "";
	},
};
