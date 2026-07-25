/**
 * The settlement worker — a 1 Hz idempotent state machine that walks ledger
 * rows closed → graded → paid/rejected → anchored, and manages bonds. Every
 * chain call is behind a `configured` guard and a try/catch: an outage
 * stalls provenance, never grading; grading degrades, never breaks. This is
 * also the "agent" of the Hedera track: payments here are submitted
 * autonomously on the referee's verdict, no human in the loop.
 */
import { getRig, leaseHolder } from "#/hub/store";
import { BOND_HBAR, HEDERA, marketEnabled } from "#/market/config";
import { grade } from "#/market/grader/index";
import { stopSampler } from "#/market/sampler";
import {
	type BondState,
	closeRow,
	getBond,
	type LedgerRow,
	listBonds,
	listRows,
	nullifierFor,
	openRowFor,
	putBond,
} from "#/market/store";

/** Lease evaporated + rig-side attempt gone this long -> abandoned. */
const ABANDON_MS = 35_000;
/** Wait after attempt_finish before grading — the episode save lands late. */
const GRADE_GRACE_MS = 5_000;
/** Bond released after the operator has been gone this long with no open row. */
const BOND_IDLE_MS = 60_000;

const g = globalThis as unknown as {
	__marketWorker?: { timer: ReturnType<typeof setInterval>; busy: boolean };
};

export const ensureWorker = (): void => {
	if (!marketEnabled() || g.__marketWorker) return;
	const state = {
		timer: setInterval(() => void tick(state), 1_000),
		busy: false,
	};
	g.__marketWorker = state;
	if (HEDERA.configured)
		void import("#/market/hedera").then((h) =>
			h.rehydrateFromMirror().catch((e) => {
				console.error("[market] mirror rehydrate failed:", e);
			}),
		);
};

const tick = async (state: { busy: boolean }): Promise<void> => {
	if (state.busy) return; // single-flight: a slow chain call skips ticks
	state.busy = true;
	try {
		abandonStaleRows();
		for (const row of listRows()) await advance(row);
		await settleIdleBonds();
	} catch (e) {
		console.error("[market] worker tick failed:", e);
	} finally {
		state.busy = false;
	}
};

/** The lease is gone AND the rig no longer reports an attempt: the operator
 * walked away mid-attempt. Close as abandoned so it grades (to a reject). */
const abandonStaleRows = (): void => {
	for (const row of listRows()) {
		if (row.status !== "open") continue;
		const rig = getRig(row.rig);
		const attemptLive = rig?.attempt?.active === true;
		const holderLive = rig ? leaseHolder(rig) === row.operator.clientId : false;
		if (attemptLive || holderLive) continue;
		if (Date.now() - row.openedAt < ABANDON_MS) continue;
		stopSampler(row.id);
		closeRow(row.rig, "abandoned");
	}
};

const advance = async (row: LedgerRow): Promise<void> => {
	if (row.status === "closed") {
		// grace window: the rig saves the episode 1-2s AFTER attempt_finish;
		// the sampler keeps watching record.saved until we grade
		if (row.closedAt !== null && Date.now() - row.closedAt < GRADE_GRACE_MS)
			return;
		stopSampler(row.id);
		row.grade = await grade(row);
		row.status = "graded";
		console.error(
			`[market] graded ${row.id}: ${row.grade.pass ? "PASS" : "FAIL"} ` +
				`${row.grade.score} (${row.grade.provider}) — ${row.grade.reason}`,
		);
		return; // one transition per tick keeps the machine legible
	}

	if (row.status === "graded") {
		const passed = row.grade?.pass === true;
		if (passed) {
			row.payment = { kind: "bonus", txId: null, amountHbar: 0 };
			if (HEDERA.configured) {
				const h = await import("#/market/hedera");
				try {
					row.payment.txId = await h.submitBonus(row);
					row.payment.amountHbar = Number(process.env.BONUS_HBAR ?? 0.5);
				} catch (e) {
					console.error(`[market] bonus payment failed for ${row.id}:`, e);
					return; // stay in graded; retried next tick (idempotent: txId null)
				}
			}
			row.status = "paid";
		} else {
			// fail after CLAIMING success = fraud-shaped -> slash the bond
			if (row.claimed === "success" && row.operator.nullifier)
				await slashBond(row.operator.nullifier, row.rig);
			row.payment = { kind: "none", txId: null, amountHbar: 0 };
			row.status = "rejected";
		}
		return;
	}

	if (row.status === "paid" || row.status === "rejected") {
		if (row.provenance !== null) return; // terminal work already done
		row.provenance = { hcsSeq: null, zgRoot: null, registryTx: null };
		if (HEDERA.configured && HEDERA.topicId !== "") {
			const h = await import("#/market/hedera");
			try {
				row.provenance.hcsSeq = await h.submitDigest(row);
			} catch (e) {
				console.error(`[market] HCS digest failed for ${row.id}:`, e);
				row.provenance = null; // retry next tick
				return;
			}
		}
		// best-effort 0G provenance — never blocks the row
		try {
			const zg = await import("#/market/zg-chain");
			row.provenance.zgRoot = await zg.uploadEvidence(row);
			row.provenance.registryTx = await zg.recordEpisode(row);
		} catch (e) {
			console.error(`[market] 0G provenance failed for ${row.id}:`, e);
		}
		row.status = "anchored";
	}
};

/** Bond lock is recorded synchronously at attempt_start (interceptor); the
 * actual transfer is submitted here so attempt_start never waits on-chain. */
export const ensureBondLocked = (clientId: string, rig: string): void => {
	const nullifier = nullifierFor(clientId);
	if (nullifier === null) return;
	const existing = getBond(nullifier, rig);
	if (existing && existing.status === "locked") {
		existing.lastActiveAt = Date.now();
		return;
	}
	const bond: BondState = {
		nullifier,
		rig,
		status: "locked",
		lockTxId: null,
		settleTxId: null,
		amountHbar: BOND_HBAR,
		lockedAt: Date.now(),
		lastActiveAt: Date.now(),
	};
	putBond(bond);
	if (HEDERA.configured)
		void import("#/market/hedera").then((h) =>
			h
				.submitBondLock(bond)
				.then((txId) => {
					bond.lockTxId = txId;
				})
				.catch((e) => console.error("[market] bond lock tx failed:", e)),
		);
};

const slashBond = async (nullifier: string, rig: string): Promise<void> => {
	const bond = getBond(nullifier, rig);
	if (!bond || bond.status !== "locked") return;
	bond.status = "slashed";
	if (HEDERA.configured) {
		const h = await import("#/market/hedera");
		try {
			bond.settleTxId = await h.settleBond(bond, "slashed");
		} catch (e) {
			console.error("[market] slash tx failed:", e);
		}
	}
	console.error(
		`[market] SLASHED bond of ${nullifier.slice(0, 12)}… on ${rig}`,
	);
};

/** Operator gone (no open row, lease elsewhere/expired) -> release the bond. */
const settleIdleBonds = async (): Promise<void> => {
	for (const bond of listBonds()) {
		if (bond.status !== "locked") continue;
		if (Date.now() - bond.lastActiveAt < BOND_IDLE_MS) continue;
		if (openRowFor(bond.rig)?.operator.nullifier === bond.nullifier) continue;
		bond.status = "released";
		if (HEDERA.configured) {
			const h = await import("#/market/hedera");
			try {
				bond.settleTxId = await h.settleBond(bond, "released");
			} catch (e) {
				console.error("[market] bond release tx failed:", e);
			}
		}
		console.error(
			`[market] released bond of ${bond.nullifier.slice(0, 12)}… on ${bond.rig}`,
		);
	}
};
