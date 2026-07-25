/**
 * Headless stand-in for an operator with MetaMask — lets the whole staking
 * loop be rehearsed without a browser: makes a fresh EVM wallet,
 * funds it from the treasury (which also lazily creates its Hedera account —
 * without that the relay refuses to accept transactions from it at all),
 * then sends the stake to the escrow over the SAME JSON-RPC relay MetaMask
 * uses. Prints the tx hash to feed to /api/market/stake.
 */
import { AccountId, Client, Hbar, PrivateKey, TransferTransaction } from "@hashgraph/sdk";
import { createWalletClient, http, parseEther, publicActions } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { hederaTestnet } from "viem/chains";

const ESCROW = process.env.ESCROW_EVM as `0x${string}`;
const stakeHbar = Number(process.env.BOND_HBAR ?? 0.5);

// reuse a wallet across runs if given, else mint one
const pk = (process.env.TEST_WALLET_KEY ?? generatePrivateKey()) as `0x${string}`;
const account = privateKeyToAccount(pk);
console.log(`test wallet : ${account.address}`);
console.log(`  key       : ${pk}   (export TEST_WALLET_KEY to reuse)`);

const client = createWalletClient({
	account,
	chain: hederaTestnet,
	transport: http(),
}).extend(publicActions);

let balance = await client.getBalance({ address: account.address });
if (balance < parseEther(String(stakeHbar + 1))) {
	console.log("funding it from the treasury (also creates its Hedera account)…");
	const hc = Client.forTestnet().setOperator(
		AccountId.fromString(process.env.HEDERA_OPERATOR_ID as string),
		PrivateKey.fromStringECDSA(process.env.HEDERA_OPERATOR_KEY as string),
	);
	const fund = await new TransferTransaction()
		.addHbarTransfer(process.env.HEDERA_OPERATOR_ID as string, new Hbar(-5))
		.addHbarTransfer(AccountId.fromEvmAddress(0, 0, account.address), new Hbar(5))
		.setMaxTransactionFee(new Hbar(5))
		.execute(hc);
	await fund.getReceipt(hc);
	await new Promise((r) => setTimeout(r, 5000));
	balance = await client.getBalance({ address: account.address });
}
console.log(`balance     : ${Number(balance) / 1e18} ℏ`);

console.log(`staking ${stakeHbar} ℏ -> ${ESCROW} (no manual gas — the relay estimates)`);
const hash = await client.sendTransaction({
	to: ESCROW,
	value: parseEther(String(stakeHbar)),
});
console.log(`STAKE_TX_HASH=${hash}`);
const receipt = await client.waitForTransactionReceipt({ hash });
console.log(`status      : ${receipt.status}  gas used ${receipt.gasUsed}`);
process.exit(0);
