/**
 * 0G chain provenance — M3 fills these (EpisodeRegistry.record() via ethers,
 * 0G Storage upload). Best-effort from the worker: failures log and continue.
 */
import type { LedgerRow } from "#/market/store";

/** Upload {telemetry, verdict, frame} to 0G Storage; returns the root hash. */
export const uploadEvidence = async (_row: LedgerRow): Promise<string | null> =>
	null;

/** Emit the EpisodeRegistry event on Galileo; returns the tx hash. */
export const recordEpisode = async (_row: LedgerRow): Promise<string | null> =>
	null;
