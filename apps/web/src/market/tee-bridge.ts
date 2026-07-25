/**
 * The cross-chain link: carry 0G's TEE attestation onto Hedera and have a
 * Hedera contract verify it.
 *
 * There is no bridge or light client between 0G Galileo and Hedera, and we
 * did not build a trusted relay. What travels between chains is the TEE's
 * own signature: 0G's broker signs every response inside the enclave with
 * plain EIP-191, so `contracts/TeeAttestation.sol` re-derives the digest and
 * runs `ecrecover` against the signer address that 0G's own registry
 * publishes on Galileo. Our backend carries the bytes but cannot forge them.
 */
import { ethers } from "ethers";
import { HEDERA_EVM, TEE_BRIDGE } from "#/market/config";
import type { LedgerRow } from "#/market/store";

const ABI = [
	"function recordGrade(bytes32 attemptId, bytes32 operator, uint16 score, bool pass, string chatID, string requestHashHex, bytes responseBytes, string tlsFingerprintHex, bytes teeSignature)",
	"function verify(string requestHashHex, bytes responseBytes, string tlsFingerprintHex, bytes teeSignature) view returns (bool)",
	"function zgSigner() view returns (address)",
];

const g = globalThis as unknown as { __teeBridge?: ethers.Contract };

const contract = (): ethers.Contract => {
	if (!TEE_BRIDGE.address || !TEE_BRIDGE.key)
		throw new Error("TEE_ATTESTATION_ADDRESS / HEDERA_EVM_KEY unset");
	g.__teeBridge ??= new ethers.Contract(
		TEE_BRIDGE.address,
		ABI,
		new ethers.Wallet(
			TEE_BRIDGE.key,
			new ethers.JsonRpcProvider(HEDERA_EVM.rpc),
		),
	);
	return g.__teeBridge;
};

export interface AttestationParts {
	requestHashHex: string;
	tlsFingerprintHex: string;
	signature: string;
	responseBody: string;
}

/**
 * The signed text is "<reqSha256>:<respSha256>:<type>:<identity>:<tlsFp>".
 * We need the first and last fields; the response hash is recomputed by the
 * contract from the raw body, which is what binds signature to verdict.
 */
export const attestationParts = (row: LedgerRow): AttestationParts | null => {
	const proof = row.grade?.proof as
		| {
				attestation?: { text?: string; signature?: string };
				responseBody?: string;
		  }
		| undefined;
	const text = proof?.attestation?.text;
	const signature = proof?.attestation?.signature;
	const responseBody = proof?.responseBody;
	if (!text || !signature || !responseBody) return null;
	const fields = text.split(":");
	if (fields.length < 5) return null;
	return {
		requestHashHex: fields[0],
		tlsFingerprintHex: fields[fields.length - 1],
		signature,
		responseBody,
	};
};

/** Dry-run the same check the contract does, without spending gas. */
export const verifyAttestation = async (
	parts: AttestationParts,
): Promise<boolean> =>
	contract().verify(
		parts.requestHashHex,
		ethers.toUtf8Bytes(parts.responseBody),
		parts.tlsFingerprintHex,
		parts.signature,
	) as Promise<boolean>;

/** Put the verified grade on Hedera. Reverts if 0G's TEE didn't sign it. */
export const recordGradeOnHedera = async (
	row: LedgerRow,
): Promise<string | null> => {
	const parts = attestationParts(row);
	if (!parts) return null; // local/router grader — nothing to attest
	const tx = await contract().recordGrade(
		ethers.id(row.id),
		ethers.id(row.operator.evmAddress ?? row.operator.nullifier ?? "unknown"),
		Math.max(0, Math.min(65535, Math.round(row.grade?.score ?? 0))),
		row.grade?.pass ?? false,
		(row.grade?.proof?.chatID as string | undefined) ?? "",
		parts.requestHashHex,
		ethers.toUtf8Bytes(parts.responseBody),
		parts.tlsFingerprintHex,
		parts.signature,
		{ gasLimit: 1_500_000 },
	);
	await tx.wait();
	console.error(
		`[market] 0G attestation verified ON HEDERA for ${row.id}: ${tx.hash}`,
	);
	return tx.hash as string;
};
