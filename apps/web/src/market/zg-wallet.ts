/**
 * The operator's wallet, on 0G — viem only, no wagmi, no WalletConnect.
 *
 * Sibling of market/wallet.ts (Hedera, now dormant). Kept separate rather than
 * parameterised because the two chains disagree about everything that matters
 * here — chain id, token, explorer, and whether the call is a transfer or a
 * contract write — and a single "flexible" client would be harder to read than
 * two honest ones.
 *
 * Exactly one transaction is ever signed by an operator: `bookSlot`. Starting
 * the slot, recording every verdict and settling are all relayed by the hub
 * with its own key, so the wallet appears once and then gets out of the way.
 */
import {
	type Chain,
	createWalletClient,
	custom,
	parseEther,
	publicActions,
} from "viem";
import { hederaTestnet } from "viem/chains";
import { slotMarketAbi } from "#/market/abi/slot-market";
import {
	pinHashOf,
	rigIdOf,
	ZG_STALE_CHAIN_ID,
	zgGalileo,
} from "#/market/chain";

type Eip1193 = {
	request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

const provider = (): Eip1193 => {
	const injected = (globalThis as { ethereum?: Eip1193 }).ethereum;
	if (!injected)
		throw new Error(
			"No wallet found. Install MetaMask (desktop) to book a slot.",
		);
	return injected;
};

export const walletAvailable = (): boolean =>
	typeof globalThis !== "undefined" &&
	(globalThis as { ethereum?: unknown }).ethereum !== undefined;

/**
 * viem's `hederaTestnet` is correct (296) and usable as shipped; its 0G
 * definitions are not, which is why zgGalileo is hand-written in
 * market/chain.ts. Two chains, one honest map.
 */
export const viemChain = (key: string): Chain =>
	key === "hedera" ? hederaTestnet : zgGalileo;

const client = (chain: Chain) =>
	createWalletClient({ chain, transport: custom(provider()) }).extend(
		publicActions,
	);

/**
 * Connect and make sure we are on Galileo (16602).
 *
 * The awkward case is real and will happen at a booth: viem shipped 0G Galileo
 * at chain id 16601 for a while, so anyone who has used another 0G dapp has a
 * network saved under that name with the wrong id. `switchChain` then throws
 * 4902 and `addChain` collides on the duplicate name. There is nothing we can
 * do about their wallet from here, so say exactly what is wrong instead of
 * surfacing "stake failed".
 */
export const connect = async (chainKey = "0g"): Promise<`0x${string}`> => {
	const chain = viemChain(chainKey);
	const wc = client(chain);
	const [account] = await wc.requestAddresses();
	if (!account) throw new Error("no account returned by the wallet");
	try {
		await wc.switchChain({ id: chain.id });
	} catch {
		try {
			await wc.addChain({ chain });
			await wc.switchChain({ id: chain.id });
		} catch (e) {
			const current = (await provider().request({
				method: "eth_chainId",
			})) as string;
			if (
				chain.id === zgGalileo.id &&
				Number.parseInt(current, 16) === ZG_STALE_CHAIN_ID
			)
				throw new Error(
					`Your wallet is on the old 0G Galileo network (${ZG_STALE_CHAIN_ID}). ` +
						`This app uses ${zgGalileo.id} — remove or rename the old entry in ` +
						"MetaMask › Settings › Networks, then reconnect.",
				);
			throw e;
		}
	}
	return account;
};

export const currentAddress = async (): Promise<`0x${string}` | null> => {
	if (!walletAvailable()) return null;
	const accounts = (await provider().request({
		method: "eth_accounts",
	})) as string[];
	return (accounts[0] as `0x${string}`) ?? null;
};

/**
 * Book the slot. Deliberately no `gas` override — but for a different reason
 * than the Hedera code it replaces, so don't carry that comment across: there
 * the number swung 30x on whether the destination account had to be created;
 * here it is an ordinary contract write whose cost depends on live storage
 * (queue length, first-touch slots), and viem forwards estimation to the wallet
 * for injected accounts, which gets it right against current state.
 */
export const bookSlot = async (input: {
	rig: string;
	namespace: string;
	pin: string;
	stakeOg: number;
	contract: `0x${string}`;
	chainKey: string;
}): Promise<{ hash: `0x${string}`; account: `0x${string}` }> => {
	const chain = viemChain(input.chainKey);
	const wc = client(chain);
	const account = await connect(input.chainKey);
	const hash = await wc.writeContract({
		account,
		chain,
		address: input.contract,
		abi: slotMarketAbi,
		functionName: "bookSlot",
		args: [rigIdOf(input.rig, input.namespace), pinHashOf(account, input.pin)],
		value: parseEther(String(input.stakeOg)),
	});
	return { hash, account };
};

/** Escape hatch: if the hub's settler key is broke, the operator can start
 * their own slot. Never shown on the happy path — the whole point of the relay
 * is that they don't have to. */
export const startSlotSelf = async (
	contract: `0x${string}`,
	slotId: number,
	chainKey = "0g",
): Promise<`0x${string}`> => {
	const chain = viemChain(chainKey);
	const wc = client(chain);
	const account = await connect(chainKey);
	return wc.writeContract({
		account,
		chain,
		address: contract,
		abi: slotMarketAbi,
		functionName: "startSlot",
		args: [BigInt(slotId)],
	});
};
