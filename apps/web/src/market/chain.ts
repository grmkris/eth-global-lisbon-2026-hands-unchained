/**
 * 0G Galileo, and the two hashes that must agree with SlotMarket.sol byte for
 * byte. Imported by BOTH halves — the hub verifies a PIN against the on-chain
 * commitment, the browser computes the same commitment when booking — so there
 * is exactly one definition of each and they cannot drift apart.
 *
 * The chain literal is hand-written because viem ships two 0G testnets and
 * both are wrong for us:
 *   - `zeroGGalileoTestnet` is id 16601 (dead) but carries the Galileo name
 *   - `zeroGTestnet` has the right id 16602 but the pre-rename A0GI ticker
 * The live RPC answers eth_chainId 0x40da = 16602 and 0G's docs confirm it, so
 * importing either export would point a wallet at the wrong network or show
 * the wrong token. Delete this in favour of viem's when they fix it upstream —
 * do not keep both.
 */
import {
	type Address,
	defineChain,
	encodePacked,
	keccak256,
	stringToBytes,
} from "viem";

export const zgGalileo = defineChain({
	id: 16602,
	name: "0G Galileo Testnet",
	nativeCurrency: { name: "OG", symbol: "OG", decimals: 18 },
	rpcUrls: { default: { http: ["https://evmrpc-testnet.0g.ai"] } },
	blockExplorers: {
		default: { name: "0G Chain Scan", url: "https://chainscan-galileo.0g.ai" },
	},
	testnet: true,
});

export const ZG_FAUCET = "https://faucet.0g.ai";

/** The stale entry a user may already have from any viem-based 0G dapp. */
export const ZG_STALE_CHAIN_ID = 16601;

/**
 * rigId = keccak256("<namespace>|<rigName>"). Namespaced because the contract
 * has no rig registry and takes any bytes32: without a prefix, two hubs sharing
 * one SlotMarket would collide on a rig called "kris-arm" and hand each other's
 * operators the same queue.
 */
export const rigIdOf = (
	rigName: string,
	namespace = "proof-of-hands",
): `0x${string}` => keccak256(stringToBytes(`${namespace}|${rigName}`));

/**
 * pinHash = keccak256(abi.encodePacked(operator, pin)) — must match
 * SlotMarket.sol exactly. `encodePacked(["address","string"])` is 20 raw
 * address bytes followed by the UTF-8 pin with no length prefix, which is what
 * Solidity's abi.encodePacked does. Pinned by
 * `test_PinCommitment_MatchesPackedEncoding` on the Solidity side, because a
 * mismatch here produces a well-formed but wrong hash and surfaces only as
 * "that PIN doesn't match" forever.
 */
/**
 * The on-chain commitment for a booking. The contract requires a non-zero
 * `pinHash` and never checks a preimage — `startSlot(slotId)` takes no
 * secret — so the commitment only has to be deterministic and bound to the
 * booker. Deriving it from the address means there is NO PIN: the wallet is
 * the key, which is stronger than a typed string nobody can remember and
 * anyone can shoulder-surf.
 */
export const walletCommitment = (operator: Address): `0x${string}` =>
	pinHashOf(operator, "proof-of-hands:wallet-is-the-key");

export const pinHashOf = (operator: Address, pin: string): `0x${string}` =>
	// lowercased first: the hash is over the raw 20 bytes so case cannot change
	// the result, but viem validates EIP-55 and would throw on an address whose
	// checksum casing differs from whatever the caller happened to have
	keccak256(
		encodePacked(
			["address", "string"],
			[operator.toLowerCase() as Address, pin],
		),
	);

const explorer = zgGalileo.blockExplorers.default.url;
export const explorerTx = (hash: string): string => `${explorer}/tx/${hash}`;
export const explorerAddress = (address: string): string =>
	`${explorer}/address/${address}`;

/**
 * The same hash on the right explorer.
 *
 * A slot's money lives on whichever chain the operator picked, so a link built
 * from a single hard-coded explorer is wrong half the time — and wrong in the
 * worst way, because a 0G explorer answers "not found" for a real Hedera
 * transaction and reads as "the payout never happened". Both link builders take
 * the chain key the DTO already carries.
 */
const HASHSCAN = "https://hashscan.io/testnet";

export const explorerTxFor = (chainKey: string | null, hash: string): string =>
	chainKey === "hedera" ? `${HASHSCAN}/transaction/${hash}` : explorerTx(hash);

export const explorerAddressFor = (
	chainKey: string | null,
	address: string,
): string =>
	chainKey === "hedera"
		? `${HASHSCAN}/account/${address}`
		: explorerAddress(address);

export const shortAddress = (address: string): string =>
	`${address.slice(0, 6)}…${address.slice(-4)}`;

/**
 * What this chain's money is CALLED.
 *
 * The DTO carries amounts in whole tokens and a chain key, never a symbol, and
 * several places used to print a hardcoded "OG" beside them — so a 0.5 HBAR
 * stake on Hedera rendered as "0.5 OG". Wrong by a factor of whatever the two
 * are worth, and wrong in the one part of the UI that is about money.
 */
export const tokenFor = (chainKey: string | null): string =>
	chainKey === "hedera" ? "HBAR" : "OG";
