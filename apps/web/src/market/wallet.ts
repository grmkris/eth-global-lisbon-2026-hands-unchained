/**
 * The operator's wallet — viem only, no wagmi, no WalletConnect.
 *
 * We do exactly one thing on-chain from the browser: send a native HBAR
 * transfer to the escrow. viem ships the Hedera testnet chain definition, so
 * the RPC, explorer and add/switch-chain params all come for free, and we
 * need no React context, no provider nesting and no SSR flag. (wagmi is the
 * layer above this; it earns its keep on multi-connector, contract-heavy
 * apps, which this screen is not.)
 *
 * Deliberately NOT setting `gas`: on Hedera a transfer costs ~22.8k gas to
 * an existing account but ~661k when the destination must be created, and
 * viem forwards to the wallet for injected accounts, so MetaMask estimates
 * correctly against the relay. Hardcoding 21000 would strand the funds.
 */
import { createWalletClient, custom, parseEther } from "viem";
import { hederaTestnet } from "viem/chains";

type Eip1193 = {
	request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

const provider = (): Eip1193 => {
	const injected = (globalThis as { ethereum?: Eip1193 }).ethereum;
	if (!injected)
		throw new Error(
			"No wallet found. Install MetaMask (desktop) to stake and drive.",
		);
	return injected;
};

export const walletAvailable = (): boolean =>
	typeof globalThis !== "undefined" &&
	(globalThis as { ethereum?: unknown }).ethereum !== undefined;

const client = () =>
	createWalletClient({
		chain: hederaTestnet,
		transport: custom(provider()),
	});

/** Connect and make sure we are on Hedera testnet (296), adding it to the
 * wallet if it isn't there yet — 4902 means "chain unknown to this wallet". */
export const connect = async (): Promise<string> => {
	const wc = client();
	const [account] = await wc.requestAddresses();
	if (!account) throw new Error("no account returned by the wallet");
	try {
		await wc.switchChain({ id: hederaTestnet.id });
	} catch {
		await wc.addChain({ chain: hederaTestnet });
		await wc.switchChain({ id: hederaTestnet.id });
	}
	return account;
};

/** Post the stake. Returns the tx hash for the hub to verify against the
 * mirror node — we never send a key anywhere, only a hash. */
export const sendStake = async (
	escrowAddress: string,
	hbar: number,
): Promise<string> => {
	const wc = client();
	const [account] = await wc.requestAddresses();
	if (!account) throw new Error("no account returned by the wallet");
	return wc.sendTransaction({
		account,
		to: escrowAddress as `0x${string}`,
		value: parseEther(String(hbar)),
	});
};

/** Renamed from `explorerTx` when 0G became the chain that matters: an
 * unqualified "explorer" now means chainscan-galileo, and a Hedera link should
 * have to say so. Only rendered for rows that actually carry a Hedera hash. */
export const hederaTx = (hash: string): string =>
	`https://hashscan.io/testnet/transaction/${hash}`;

export const shortAddress = (address: string): string =>
	`${address.slice(0, 6)}…${address.slice(-4)}`;
