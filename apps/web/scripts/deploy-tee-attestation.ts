/**
 * Deploy TeeAttestation.sol to HEDERA testnet EVM (chain 296) — the contract
 * that lets Hedera verify a 0G TEE attestation without reading 0G's chain.
 *
 *   cd apps/web
 *   set -a; source .env.market; set +a
 *   HEDERA_EVM_KEY=0x<ecdsa key with HBAR> bun scripts/deploy-tee-attestation.ts
 *
 * `zgSigner` is read LIVE from 0G's InferenceServing contract on Galileo, so
 * the pinned constant is never guessed — it is whatever 0G itself reports
 * for our grading provider, and anyone can re-check it the same way.
 */
import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import solc from "solc";

const HEDERA_RPC = process.env.HEDERA_EVM_RPC ?? "https://testnet.hashio.io/api";
const ZG_RPC = process.env.ZG_RPC ?? "https://evmrpc-testnet.0g.ai";
const INFERENCE_SERVING = "0xa79F4c8311FF93C06b8CfB403690cc987c93F91E";
const provider = process.env.ZG_PROVIDER;
const key = process.env.HEDERA_EVM_KEY ?? process.env.HEDERA_OPERATOR_KEY;
if (!key) throw new Error("HEDERA_EVM_KEY (or HEDERA_OPERATOR_KEY) required");
if (!provider) throw new Error("ZG_PROVIDER required");

console.log("1) reading the TEE signer from 0G Galileo (the trust anchor)…");
const zg = new ethers.JsonRpcProvider(ZG_RPC);
const serving = new ethers.Contract(
	INFERENCE_SERVING,
	[
		"function getService(address provider) view returns (tuple(address provider, string serviceType, string url, uint256 inputPrice, uint256 outputPrice, uint256 updatedAt, string model, string verifiability, string additionalInfo, address teeSignerAddress, bool teeSignerAcknowledged))",
	],
	zg,
);
const svc = await serving.getService(provider);
const zgSigner: string = svc.teeSignerAddress;
const additional: string = svc.additionalInfo ?? "";
console.log(`   provider  : ${provider}`);
console.log(`   model     : ${svc.model}`);
console.log(`   teeSigner : ${zgSigner}`);
if (!zgSigner || zgSigner === ethers.ZeroAddress)
	throw new Error("provider has no TEE signer registered");

let providerType = "centralized";
let providerIdentity = "aliyun";
try {
	const info = JSON.parse(additional) as {
		ProviderType?: string;
		ProviderIdentity?: string;
	};
	providerType = info.ProviderType ?? providerType;
	providerIdentity = info.ProviderIdentity ?? providerIdentity;
} catch {
	console.log("   (additionalInfo not JSON — using defaults)");
}
console.log(`   descriptor: ${providerType}/${providerIdentity}`);

console.log("\n2) compiling TeeAttestation.sol (cancun)…");
const source = readFileSync(
	new URL("../../../contracts/TeeAttestation.sol", import.meta.url),
	"utf8",
);
const out = JSON.parse(
	solc.compile(
		JSON.stringify({
			language: "Solidity",
			sources: { "TeeAttestation.sol": { content: source } },
			settings: {
				evmVersion: "cancun",
				// the attestation function takes 9 args and builds a string —
				// legacy codegen runs out of stack slots, viaIR does not
				viaIR: true,
				optimizer: { enabled: true, runs: 200 },
				outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
			},
		}),
	),
);
const errors = (out.errors ?? []).filter(
	(e: { severity: string }) => e.severity === "error",
);
if (errors.length)
	throw new Error(
		errors.map((e: { formattedMessage: string }) => e.formattedMessage).join("\n"),
	);
const artifact = out.contracts["TeeAttestation.sol"].TeeAttestation;

console.log("\n3) deploying to Hedera testnet EVM…");
const hedera = new ethers.JsonRpcProvider(HEDERA_RPC);
const net = await hedera.getNetwork();
console.log(`   chain id  : ${net.chainId} (expect 296)`);
const wallet = new ethers.Wallet(key, hedera);
const balance = await hedera.getBalance(wallet.address);
console.log(`   deployer  : ${wallet.address}  ${ethers.formatEther(balance)} HBAR`);
if (balance === 0n) throw new Error("deployer has no HBAR");

const factory = new ethers.ContractFactory(
	artifact.abi,
	artifact.evm.bytecode.object,
	wallet,
);
const contract = await factory.deploy(zgSigner, providerType, providerIdentity, {
	gasLimit: 3_000_000,
});
await contract.waitForDeployment();
const address = await contract.getAddress();

console.log("\nDEPLOYED");
console.log(`  address : ${address}`);
console.log(`  explorer: https://hashscan.io/testnet/contract/${address}`);
console.log(`\nexport TEE_ATTESTATION_ADDRESS=${address}`);
process.exit(0);
