/**
 * 0G chain provenance, best-effort from the worker (failures log and the row
 * still anchors):
 * - uploadEvidence: {telemetry, verdict, final frame} onto 0G Storage → root
 *   hash (goes into the row, the HCS digest and the registry event).
 * - recordEpisode: one event on the EpisodeRegistry contract on Galileo —
 *   the track's "contract deployment address" deliverable, exercised live.
 */
import { Indexer, Blob as ZgBlob } from "@0gfoundation/0g-storage-ts-sdk";
import { ethers } from "ethers";
import { ZG } from "#/market/config";
import type { LedgerRow } from "#/market/store";

const g = globalThis as unknown as { __marketZgWallet?: ethers.Wallet };

const wallet = (): ethers.Wallet => {
	if (!ZG.privateKey) throw new Error("ZG_PRIVATE_KEY unset");
	g.__marketZgWallet ??= new ethers.Wallet(
		ZG.privateKey,
		new ethers.JsonRpcProvider(ZG.rpc),
	);
	return g.__marketZgWallet;
};

export const uploadEvidence = async (
	row: LedgerRow,
): Promise<string | null> => {
	if (!ZG.privateKey) return null;
	const payload = {
		attemptId: row.id,
		rig: row.rig,
		task: row.taskTitle ?? row.taskId,
		operatorNullifier: row.operator.nullifier,
		claimed: row.claimed,
		telemetry: row.telemetry,
		grade: row.grade,
		frameJpegB64: row.evidence.frameJpeg
			? Buffer.from(row.evidence.frameJpeg).toString("base64")
			: null,
		ts: Date.now(),
	};
	const file = new ZgBlob(
		new File([JSON.stringify(payload)], `${row.id}.json`, {
			type: "application/json",
		}),
	);
	// Go-style tuples: err-first checks, not try/catch
	const [tree, treeErr] = await file.merkleTree();
	if (treeErr !== null || tree === null)
		throw new Error(`merkle tree failed: ${treeErr}`);
	const indexer = new Indexer(ZG.storageIndexer);
	const [result, uploadErr] = await indexer.upload(file, ZG.rpc, wallet());
	if (uploadErr !== null)
		throw new Error(`0g storage upload failed: ${uploadErr}`);
	const root = tree.rootHash();
	console.error(
		`[market] evidence for ${row.id} on 0G Storage root=${root} tx=${
			(result as { txHash?: string } | null)?.txHash ?? "?"
		}`,
	);
	return root;
};

const REGISTRY_ABI = [
	"function record(bytes32 episodeHash, bytes32 operator, uint16 score, bool pass, bytes32 storageRoot)",
];

export const recordEpisode = async (row: LedgerRow): Promise<string | null> => {
	if (!ZG.privateKey || !ZG.registryAddress) return null;
	const registry = new ethers.Contract(
		ZG.registryAddress,
		REGISTRY_ABI,
		wallet(),
	);
	const episodeHash = ethers.id(`${row.id}|${row.rig}|${row.taskId ?? ""}`);
	const operator = ethers.id(row.operator.nullifier ?? "unknown");
	const storageRoot =
		row.provenance?.zgRoot && row.provenance.zgRoot.startsWith("0x")
			? row.provenance.zgRoot
			: ethers.ZeroHash;
	const tx = await registry.record(
		episodeHash,
		operator,
		row.grade?.score ?? 0,
		row.grade?.pass ?? false,
		storageRoot,
	);
	await tx.wait();
	console.error(`[market] EpisodeRegistry.record ${row.id} tx=${tx.hash}`);
	return tx.hash as string;
};
