/**
 * Hedera settlement — M2 fills these bodies (accounts, bond/bonus/release/
 * slash transfers, HCS digest, mirror-node rehydrate). Stubbed so the worker
 * and typecheck are complete from M1; every caller already guards on
 * HEDERA.configured, so these throwing is unreachable until configured.
 */
import type { BondState, LedgerRow } from "#/market/store";

const notWired = (what: string): never => {
	throw new Error(`hedera ${what} not wired yet (M2)`);
};

/** Derive (and create if needed) the operator's testnet account. */
export const ensureOperatorAccount = async (
	_nullifier: string,
): Promise<{ accountId: string }> => notWired("ensureOperatorAccount");

/** operator -> escrow, BOND_HBAR. Returns the tx id. */
export const submitBondLock = async (_bond: BondState): Promise<string> =>
	notWired("submitBondLock");

/** treasury -> operator, BONUS_HBAR. The autonomous payment. */
export const submitBonus = async (_row: LedgerRow): Promise<string> =>
	notWired("submitBonus");

/** escrow -> operator (release) or escrow -> treasury (slash). */
export const settleBond = async (
	_bond: BondState,
	_outcome: "released" | "slashed",
): Promise<string> => notWired("settleBond");

/** ≤1024-byte digest to the HCS topic; returns the sequence number. */
export const submitDigest = async (_row: LedgerRow): Promise<number> =>
	notWired("submitDigest");

/** Boot-time stats rehydration from the Mirror Node. */
export const rehydrateFromMirror = async (): Promise<void> => {};
