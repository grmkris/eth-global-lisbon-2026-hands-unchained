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

/**
 * The hub settles finished slots for the operator. Set `SLOT_AUTOSETTLE=0` to
 * stop it doing so.
 *
 * Not a performance knob — a DEMONSTRATION one. The claim this design makes is
 * that your stake is never hostage to our uptime: `settle` is permissionless
 * once the grading window closes, so anyone can move the money and it can only
 * move to you. With the hub settling within a second of the clock running out,
 * that path is invisible and therefore unprovable. Turning this off makes the
 * hub look broken on purpose, and the operator gets paid anyway.
 */
export const SLOT_AUTOSETTLE = process.env.SLOT_AUTOSETTLE !== "0";

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

/**
 * The slot market. The SAME contract is deployed on 0G Galileo and on Hedera
 * testnet, and the operator picks which one holds their money — so choosing a
 * chain changes the token, not the rules.
 *
 * A chain is configured by giving it an address and a settler key; unset means
 * that chain simply is not offered. Both unset means the platform runs exactly
 * as it did before slots existed.
 *
 * `valueDecimals` is NOT cosmetic and is the one thing to get right here.
 * Hedera's EVM denominates value in TINYBAR (1e8 = 1 HBAR) — the JSON-RPC
 * relay divides the weibar a wallet sends by 1e10 — so a contract amount read
 * back from Hedera must be scaled by 1e8 and one from 0G by 1e18. Mixing them
 * is a silent factor of ten billion, which is exactly the bug that made a
 * 0.5 HBAR stake read as five billion HBAR on the first deploy.
 */
export interface SlotChain {
	key: string;
	chainId: number;
	label: string;
	token: string;
	address: string;
	settlerKey: string;
	rpc: string;
	explorerTx: (hash: string) => string;
	explorerAddress: (addr: string) => string;
	faucet: string;
	/** 18 on a normal EVM; 8 on Hedera, whose EVM speaks tinybar */
	valueDecimals: number;
	/** true where the contract can read 0G's registry itself */
	liveSigner: boolean;
}

const ZG_CHAIN: SlotChain = {
	key: "0g",
	chainId: 16602,
	label: "0G Galileo",
	token: "OG",
	address: process.env.ZG_SLOT_MARKET_ADDRESS ?? "",
	settlerKey: process.env.ZG_SETTLER_KEY ?? process.env.ZG_PRIVATE_KEY ?? "",
	rpc: process.env.ZG_RPC ?? "https://evmrpc-testnet.0g.ai",
	explorerTx: (h) => `https://chainscan-galileo.0g.ai/tx/${h}`,
	explorerAddress: (a) => `https://chainscan-galileo.0g.ai/address/${a}`,
	faucet: "https://faucet.0g.ai",
	valueDecimals: 18,
	liveSigner: true,
};

const HEDERA_CHAIN: SlotChain = {
	key: "hedera",
	chainId: 296,
	label: "Hedera testnet",
	token: "HBAR",
	address: process.env.HEDERA_SLOT_MARKET_ADDRESS ?? "",
	settlerKey:
		process.env.HEDERA_SETTLER_KEY ?? process.env.HEDERA_EVM_KEY ?? "",
	rpc: process.env.HEDERA_EVM_RPC ?? "https://testnet.hashio.io/api",
	explorerTx: (h) => `https://hashscan.io/testnet/transaction/${h}`,
	explorerAddress: (a) => `https://hashscan.io/testnet/account/${a}`,
	faucet: "https://portal.hedera.com/faucet",
	valueDecimals: 8,
	liveSigner: false,
};

const chainConfigured = (c: SlotChain): boolean =>
	c.address !== "" && c.settlerKey !== "";

/** Only the chains this hub can actually settle on. */
export const slotChains = (): ReadonlyArray<SlotChain> =>
	[ZG_CHAIN, HEDERA_CHAIN].filter(chainConfigured);

export const slotChain = (key: string): SlotChain | null =>
	slotChains().find((c) => c.key === key) ?? null;

export const SLOTS = {
	/** rigId = keccak256("<ns>|<rigName>") — see market/chain.ts */
	namespace: process.env.ZG_SLOT_NS ?? "proof-of-hands",
	/** Require a slot to drive at all. Off = a rig nobody booked stays free. */
	required: process.env.SLOT_REQUIRED === "1",
	slotSeconds: Number(process.env.SLOT_DURATION_S ?? 1800),
	get configured(): boolean {
		return slotChains().length > 0;
	},
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
	/** Ask World ID for a fresh liveness capture (a live selfie matched
	 * against the credential's image). OFF by default because a simulator
	 * has no camera and no enrolled face to match — it fails every time with
	 * `user_presence_failed`. Only turn on against a real World App. */
	requirePresence: process.env.WORLD_REQUIRE_PRESENCE === "1",
	get configured(): boolean {
		return this.appId !== "" && this.rpId !== "";
	},
};
