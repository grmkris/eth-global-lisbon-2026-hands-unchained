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
import { BONUS_HBAR, HEDERA, marketEnabled, TEE_BRIDGE } from "#/market/config";
import { grade } from "#/market/grader/index";
import { stopSampler } from "#/market/sampler";
import {
	addEarnings,
	type BondState,
	closeRow,
	getBond,
	type LedgerRow,
	listBonds,
	listRows,
	openRowFor,
} from "#/market/store";

/** Lease evaporated + rig-side attempt gone this long -> abandoned. */
const ABANDON_MS = 35_000;
/** Worst-case wait after attempt_finish before grading a success claim —
 * the episode save lands late (video encoding). The fast path grades the
 * moment the sampler sees the save. */
const GRADE_GRACE_MS = 15_000;
/** Stake comes back after this long with nothing in flight. */
const STAKE_IDLE_MS = 5 * 60_000;

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
		await releaseIdleStakes();
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
		// The rig measures the SAVED EPISODE in the background and reports it
		// on the next telemetry tick; that measurement is the best evidence we
		// will ever get, so a success claim waits for it rather than grading a
		// proxy. Pull it here as well as in the sampler — by now the sampler
		// has usually stopped.
		if (row.telemetry.episode === null) {
			const ep = getRig(row.rig)?.attempt?.lastEpisode;
			if (ep)
				row.telemetry.episode = {
					frames: ep.frames,
					durationS: ep.durationS,
					jointPathDeg: ep.jointPathDeg,
					maxJointRangeDeg: ep.maxJointRangeDeg,
					gripperCycles: ep.gripperCycles,
					stillFraction: ep.stillFraction,
				};
		}
		// Wait out the grace window for either the episode measurement or the
		// save counter. Discard/abandon grade immediately — nothing to wait for.
		if (
			row.claimed === "success" &&
			row.telemetry.episode === null &&
			row.telemetry.episodeSaved !== true &&
			row.closedAt !== null &&
			Date.now() - row.closedAt < GRADE_GRACE_MS
		)
			return;
		if (
			row.claimed === "success" &&
			row.telemetry.episode === null &&
			row.closedAt !== null &&
			Date.now() - row.closedAt < GRADE_GRACE_MS
		)
			return; // the save landed; give the measurement its full window too
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
			// Pay the bonus and LEAVE THE STAKE LOCKED. The stake is the
			// operator's commitment for the whole session — clearing it per
			// attempt forced a MetaMask popup between every episode and made
			// the page look frozen. It comes back when they walk away
			// (settleIdleBonds) or is slashed if they lie.
			row.payment = { kind: "bonus", txId: null, amountHbar: 0 };
			if (bond && HEDERA.configured) {
				try {
					row.payment.txId = await payBonus(bond);
					row.payment.amountHbar = BONUS_HBAR;
					row.operator.evmAddress ??= bond.evmAddress;
					if (row.operator.nullifier)
						addEarnings(row.operator.nullifier, BONUS_HBAR);
					bond.lastActiveAt = Date.now();
				} catch (e) {
					console.error(`[market] payout failed for ${row.id}:`, e);
					return; // stay in graded; retried next tick (txId still null)
				}
			}
			row.status = "paid";
		} else {
			// A failed grade only costs the stake when they CLAIMED success —
			// that is the lie. An honest discard keeps the stake in place so
			// they can try again.
			if (bond && row.claimed === "success" && HEDERA.configured) {
				try {
					await settle(bond, "slashed");
				} catch (e) {
					console.error(`[market] slash failed for ${row.id}:`, e);
					return;
				}
			} else if (bond) {
				bond.lastActiveAt = Date.now();
			}
			row.payment = { kind: "none", txId: null, amountHbar: 0 };
			row.status = "rejected";
		}
		return;
	}

	if (row.status === "paid" || row.status === "rejected") {
		if (row.provenance !== null) return; // terminal work already done
		row.provenance = {
			hcsSeq: null,
			zgRoot: null,
			registryTx: null,
			teeTxHash: null,
		};
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
		// The cross-chain link: hand 0G's TEE signature to a HEDERA contract
		// and let it ecrecover the thing itself. Best-effort — a failure here
		// means the attestation isn't on Hedera, not that the grade is void.
		if (TEE_BRIDGE.configured) {
			try {
				const bridge = await import("#/market/tee-bridge");
				row.provenance.teeTxHash = await bridge.recordGradeOnHedera(row);
			} catch (e) {
				console.error(
					`[market] on-chain TEE attestation failed for ${row.id}:`,
					e,
				);
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

/** treasury -> operator, the bonus only; the stake stays in escrow. */
const payBonus = async (bond: BondState): Promise<string> => {
	const h = await import("#/market/hedera");
	return h.payBonusTo(bond.evmAddress);
};

/** The operator finished for the day: give the stake back, no bonus. Runs
 * only when nothing of theirs is in flight. */
const releaseIdleStakes = async (): Promise<void> => {
	for (const bond of listBonds()) {
		if (bond.status !== "locked") continue;
		if (Date.now() - bond.lastActiveAt < STAKE_IDLE_MS) continue;
		if (
			listRows().some(
				(r) =>
					r.operator.nullifier === bond.nullifier &&
					r.status !== "anchored" &&
					r.status !== "rejected",
			)
		)
			continue;
		try {
			await settle(bond, "released", { bonus: false });
		} catch (e) {
			console.error("[market] idle stake refund failed:", e);
		}
	}
};

/** The rig-side attempt may only start once a stake is posted. */
export const hasActiveBond = (nullifier: string | null): boolean =>
	nullifier !== null && getBond(nullifier) !== null;

/** An open row means an attempt is mid-flight against this stake. */
export const bondBusy = (rig: string): boolean => openRowFor(rig) !== null;
