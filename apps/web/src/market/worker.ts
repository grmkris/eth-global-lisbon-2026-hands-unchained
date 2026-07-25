/**
 * The settlement worker — a 1 Hz idempotent state machine that walks ledger
 * rows closed → graded → paid/rejected → anchored. Every chain call is
 * behind a `configured` guard and a try/catch: an outage stalls provenance,
 * never grading; grading degrades, never breaks.
 *
 * This is also the "agent" of the Hedera track: it decides and submits every
 * payment itself, on the referee's verdict, with no human in the loop. The
 * operator's stake is returned (plus a bonus) or slashed the moment the
 * verdict lands — not on a timer, so the whole cycle is visible in one take.
 */
import { getRig, leaseHolder } from "#/hub/store";
import { BONUS_HBAR, HEDERA, marketEnabled } from "#/market/config";
import { grade } from "#/market/grader/index";
import { stopSampler } from "#/market/sampler";
import {
	addEarnings,
	type BondState,
	closeRow,
	getBond,
	type LedgerRow,
	listRows,
	openRowFor,
} from "#/market/store";

/** Lease evaporated + rig-side attempt gone this long -> abandoned. */
const ABANDON_MS = 35_000;
/** Worst-case wait after attempt_finish before grading a success claim —
 * the episode save lands late (video encoding). The fast path grades the
 * moment the sampler sees the save. */
const GRADE_GRACE_MS = 15_000;

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
		// A success claim waits for the rig's episode save (the sampler keeps
		// watching record.saved through this window): grade the moment it
		// lands, or after GRADE_GRACE_MS worst-case. Discard/abandon grade
		// immediately — there is nothing to wait for.
		if (
			row.claimed === "success" &&
			row.telemetry.episodeSaved !== true &&
			row.closedAt !== null &&
			Date.now() - row.closedAt < GRADE_GRACE_MS
		)
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
		const bond = row.operator.nullifier
			? getBond(row.operator.nullifier)
			: null;

		if (passed) {
			// stake back + bonus, in ONE transaction to the operator's own wallet
			row.payment = { kind: "bonus", txId: null, amountHbar: 0 };
			if (bond && HEDERA.configured) {
				try {
					const txId = await settle(bond, "released");
					row.payment.txId = txId;
					row.payment.amountHbar = BONUS_HBAR;
					row.operator.evmAddress ??= bond.evmAddress;
					if (row.operator.nullifier)
						addEarnings(row.operator.nullifier, BONUS_HBAR);
				} catch (e) {
					console.error(`[market] payout failed for ${row.id}:`, e);
					return; // stay in graded; retried next tick (txId still null)
				}
			}
			row.status = "paid";
		} else {
			// fail after CLAIMING success = fraud-shaped -> slash the stake
			if (bond && row.claimed === "success" && HEDERA.configured) {
				try {
					await settle(bond, "slashed");
				} catch (e) {
					console.error(`[market] slash failed for ${row.id}:`, e);
					return;
				}
			} else if (bond && row.claimed !== "success" && HEDERA.configured) {
				// honest discard/abandon: give the stake back, no bonus
				try {
					await settle(bond, "released", { bonus: false });
				} catch (e) {
					console.error(`[market] refund failed for ${row.id}:`, e);
					return;
				}
			}
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

/** Close out a stake. Marks the bond first so a retry can never double-pay
 * a wallet: a failed transfer leaves the row in `graded` and the operator
 * has to be settled by hand, which is the safe direction to fail. */
const settle = async (
	bond: BondState,
	outcome: "released" | "slashed",
	opts: { bonus?: boolean } = {},
): Promise<string> => {
	const h = await import("#/market/hedera");
	bond.status = outcome;
	const txId = await h.settleToOperator(bond, outcome, opts);
	bond.settleTxId = txId;
	console.error(`[market] stake ${outcome} for ${bond.evmAddress}: ${txId}`);
	return txId;
};

/** The rig-side attempt may only start once a stake is posted. */
export const hasActiveBond = (nullifier: string | null): boolean =>
	nullifier !== null && getBond(nullifier) !== null;

/** An open row means an attempt is mid-flight against this stake. */
export const bondBusy = (rig: string): boolean => openRowFor(rig) !== null;
