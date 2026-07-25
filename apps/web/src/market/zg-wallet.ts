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
	rigIdOf,
	walletCommitment,
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
	stakeOg: number;
	contract: `0x${string}`;
	chainKey: string;
	/**
	 * Fired once the operator has approved in their wallet and the transaction
	 * is in flight. Those are two very different waits — "we are waiting for a
	 * human" and "we are waiting for a chain" — and the caller narrates them
	 * separately, so the boundary has to be observable from out here.
	 */
	onSigned?: (hash: `0x${string}`) => void;
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
		args: [rigIdOf(input.rig, input.namespace), walletCommitment(account)],
		value: parseEther(String(input.stakeOg)),
	});
	input.onSigned?.(hash);
	/**
	 * WAIT FOR IT TO BE REAL.
	 *
	 * `writeContract` resolves when the transaction is accepted into the
	 * mempool, not when it is mined — so returning here handed the caller a
	 * hash for a booking the chain could not see yet. Every read that followed
	 * raced it: `noteBooked` refreshed a rig whose queue had not changed, and
	 * the UI only recovered because a 5-second poll eventually caught up.
	 *
	 * Survivable while booking was the end of the interaction. Not survivable
	 * once anything is chained onto it — relaying `startSlot` against a slot
	 * that does not exist yet reverts.
	 */
	await wc.waitForTransactionReceipt({ hash });
	return { hash, account };
};

/**
 * Every other operator-signed call is the same three lines: connect, write one
 * slotId, return the hash. Kept as one helper so a new lifecycle button is a
 * one-liner and cannot forget the chain switch that `connect` performs.
 */
const slotWrite = async (
	functionName: "startSlot" | "endEarly" | "cancel" | "settle",
	contract: `0x${string}`,
	slotId: number,
	chainKey: string,
): Promise<`0x${string}`> => {
	const chain = viemChain(chainKey);
	const wc = client(chain);
	const account = await connect(chainKey);
	return wc.writeContract({
		account,
		chain,
		address: contract,
		abi: slotMarketAbi,
		functionName,
		args: [BigInt(slotId)],
	});
};

/** Escape hatch: if the hub's settler key is broke, the operator can start
 * their own slot. Never shown on the happy path — the whole point of the relay
 * is that they don't have to. */
export const startSlotSelf = (
	contract: `0x${string}`,
	slotId: number,
	chainKey = "0g",
): Promise<`0x${string}`> => slotWrite("startSlot", contract, slotId, chainKey);

/**
 * "I'm done" — pull `endAt` forward to now.
 *
 * NOT a forfeit: the contract only moves the deadline, so the stake and every
 * credit already earned still pay out on the ordinary settle path, and a
 * verdict still in flight lands inside the grading grace window. Operator-only,
 * `Running` only, and refuses once `endAt` has passed (settle handles that).
 */
export const endEarlySlot = (
	contract: `0x${string}`,
	slotId: number,
	chainKey = "0g",
): Promise<`0x${string}`> => slotWrite("endEarly", contract, slotId, chainKey);

/** Booked but never started, and you changed your mind: full refund. The
 * contract refuses once the clock is running — that is what endEarly is for. */
export const cancelSlot = (
	contract: `0x${string}`,
	slotId: number,
	chainKey = "0g",
): Promise<`0x${string}`> => slotWrite("cancel", contract, slotId, chainKey);

/**
 * Pay yourself out, without asking the hub.
 *
 * `settle` is permissionless once the grading window has closed, which is the
 * part of this design worth demonstrating: the hub normally settles for you so
 * you never touch a wallet, but if it is down, dishonest, or simply gone, the
 * money is still yours to take and anyone can move it for you.
 */
export const settleSelf = (
	contract: `0x${string}`,
	slotId: number,
	chainKey = "0g",
): Promise<`0x${string}`> => slotWrite("settle", contract, slotId, chainKey);

/** Sweep a deferred payout to its owner. Callable by anyone, for anyone — so
 * a stuck balance is never one wallet's problem. */
export const withdrawSelf = async (
	contract: `0x${string}`,
	payee: `0x${string}`,
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
		functionName: "withdraw",
		args: [payee],
	});
};
