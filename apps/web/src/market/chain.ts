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

export const shortAddress = (address: string): string =>
	`${address.slice(0, 6)}…${address.slice(-4)}`;

/**
 * The PIN is a walk-up unlock, not a secret: `pinHash` is public on chain and
 * so is the operator address, so a short numeric PIN is brute-forced offline in
 * microseconds and no amount of server-side rate limiting changes that. Entropy
 * is the only real defence, and the contract has already committed to the hash
 * so no salt or KDF can be added after the fact. Hence: a generated key by
 * default, and a floor under what someone can type instead.
 */
export const MIN_PIN_LENGTH = 8;

/** Crockford base32 minus look-alikes — safe to read off a screen out loud. */
const KEY_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const generateSlotKey = (length = MIN_PIN_LENGTH): string => {
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => KEY_ALPHABET[b % KEY_ALPHABET.length]).join(
		"",
	);
};
