/**
 * Deploy contracts/EpisodeRegistry.sol to 0G Galileo (chain 16602) with
 * plain solc + ethers — no Foundry/Hardhat. Compile targets CANCUN: newer
 * EVM targets fail or don't verify on chainscan-galileo.
 *
 *   cd apps/web
 *   ZG_PRIVATE_KEY=0x... bun scripts/deploy-registry.ts
 *
 * Gas ≈ 0.001-0.005 OG at ~4 gwei — the 0.1 OG/day faucet covers it.
 */
import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import solc from "solc";

const RPC = process.env.ZG_RPC ?? "https://evmrpc-testnet.0g.ai";
const key = process.env.ZG_PRIVATE_KEY;
if (!key) throw new Error("ZG_PRIVATE_KEY required");

const source = readFileSync(
	new URL("../../../contracts/EpisodeRegistry.sol", import.meta.url),
	"utf8",
);

const input = {
	language: "Solidity",
	sources: { "EpisodeRegistry.sol": { content: source } },
	settings: {
		evmVersion: "cancun",
		optimizer: { enabled: true, runs: 200 },
		outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
	},
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (output.errors ?? []).filter(
	(e: { severity: string }) => e.severity === "error",
);
if (errors.length > 0)
	throw new Error(errors.map((e: { formattedMessage: string }) => e.formattedMessage).join("\n"));

const artifact = output.contracts["EpisodeRegistry.sol"].EpisodeRegistry;
const provider = new ethers.JsonRpcProvider(RPC);
const net = await provider.getNetwork();
console.log(`chain id ${net.chainId} (expect 16602)`);

const wallet = new ethers.Wallet(key, provider);
const balance = await provider.getBalance(wallet.address);
console.log(`deployer ${wallet.address} balance ${ethers.formatEther(balance)} OG`);
if (balance === 0n) throw new Error("deployer has no OG — hit faucet.0g.ai first");

const factory = new ethers.ContractFactory(
	artifact.abi,
	artifact.evm.bytecode.object,
	wallet,
);
const contract = await factory.deploy();
console.log(`deploy tx ${contract.deploymentTransaction()?.hash}`);
await contract.waitForDeployment();
const address = await contract.getAddress();

console.log("\nDEPLOYED");
console.log(`  address:  ${address}`);
console.log(`  explorer: https://chainscan-galileo.0g.ai/address/${address}`);
console.log(`\nexport ZG_REGISTRY_ADDRESS=${address}`);

// prove it works end to end with one event
const registry = new ethers.Contract(
	address,
	["function record(bytes32,bytes32,uint16,bool,bytes32)"],
	wallet,
);
const tx = await registry.record(
	ethers.id("deploy-smoke"),
	ethers.id("deployer"),
	100,
	true,
	ethers.ZeroHash,
);
await tx.wait();
console.log(`smoke event tx: https://chainscan-galileo.0g.ai/tx/${tx.hash}`);
