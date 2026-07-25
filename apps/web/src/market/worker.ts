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
import {
	getRig,
	leaseHolder,
	listRigs,
	MAX_PENDING,
	revokeLease,
} from "#/hub/store";
import {
	BONUS_HBAR,
	HEDERA,
	marketEnabled,
	SLOTS,
	slotChain,
	TEE_BRIDGE,
} from "#/market/config";
import { grade } from "#/market/grader/index";
import { stopSampler } from "#/market/sampler";
import {
	allHeads,
	beginInFlight,
	chainOf,
	endInFlight,
	ensureSlotMirror,
	liveSlot,
	markEnforced,
	refreshRig,
} from "#/market/slots";
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
import type { SlotView } from "#/market/zg-slots";

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
		timer: setInterval(() => tick(state), 1_000),
		busy: false,
	};
	g.__marketWorker = state;
	ensureSlotMirror();
	if (HEDERA.configured)
		void import("#/market/hedera").then((h) =>
			h.rehydrateFromMirror().catch((e) => {
				console.error("[market] mirror rehydrate failed:", e);
			}),
		);
};

const tick = (state: { busy: boolean }): void => {
	// Cache-only and synchronous, ABOVE the single-flight guard on purpose:
	// ending someone's slot on time must never queue behind a slow 0G RPC
	// call, and everything below this line is serialized under `busy`.
	try {
		enforceSlots();
	} catch (e) {
		console.error("[market] slot enforcement failed:", e);
	}
	if (state.busy) return; // single-flight: a slow chain call skips ticks
	state.busy = true;
	void slowTick(state);
};

const slowTick = async (state: { busy: boolean }): Promise<void> => {
	try {
		abandonStaleRows();
		for (const row of listRows()) await advance(row);
		await releaseIdleStakes();
		await settleDueSlots();
	} catch (e) {
		console.error("[market] worker tick failed:", e);
	} finally {
		state.busy = false;
	}
};

/**
 * The clock, enforced from cache. A slot that has run out (or been voided by a
 * third strike) loses the arm here: the in-flight attempt is closed as
 * `slot_expired` — NOT as a discard, because the operator never claimed
 * anything and must not be graded as though they had — the recorder is told to
 * stop, and the lease is revoked and capped so `/input` cannot renew it back.
 */
const enforceSlots = (): void => {
	if (!SLOTS.configured) return;
	for (const rig of listRigs()) {
		const live = liveSlot(rig.name);
		if (live !== null) {
			rig.leaseHardExpiry = live.endAt * 1000; // keep the ceiling fresh
			continue;
		}
		const heads = allHeads(rig.name);
		if (heads.length === 0) {
			rig.leaseHardExpiry = null;
			continue;
		}
		for (const head of heads) {
			const expired =
				head.status === "running" && head.endAt * 1000 <= Date.now();
			const voided = head.status === "voided";
			if (!expired && !voided) continue;
			if (!markEnforced(head.slotId)) continue;
			endSlotOnRig(rig.name, head, voided ? "voided" : "expired");
		}
	}
};

const endSlotOnRig = (
	rigName: string,
	slot: SlotView,
	why: "voided" | "expired",
): void => {
	const rig = getRig(rigName);
	if (!rig) return;
	const open = openRowFor(rigName);
	if (open !== null) {
		stopSampler(open.id);
		closeRow(rigName, "slot_expired");
	}
	// finish first, then stop: letting the recorder close its own session is
	// cleaner than leaving the rig-side watcher's 30s abandon path to do it.
	// They drain in order on one link tick.
	const holder = leaseHolder(rig);
	if (rig.pending.length + 2 <= MAX_PENDING) {
		if (open !== null)
			rig.pending.push({
				verb: "attempt_finish",
				args: { success: false },
				holder,
				queuedAt: Date.now(),
			});
		rig.pending.push({ verb: "teleop_stop", holder, queuedAt: Date.now() });
	}
	revokeLease(rig);
	rig.leaseHardExpiry = Date.now();
	console.error(
		`[market] slot ${slot.slotId} on ${rigName} ${why} — control revoked` +
			(open !== null ? ` (attempt ${open.id} closed as slot_expired)` : ""),
	);
};

/**
 * Money, once the clock is no longer anyone's problem. `settle` is
 * permissionless after the grading window, but the hub does it so the operator
 * is paid without touching a wallet. Held back until none of that slot's rows
 * are still grading, or a late verdict would be settled away.
 */
const settleDueSlots = async (): Promise<void> => {
	if (!SLOTS.configured) return;
	for (const rig of listRigs()) {
		for (const head of allHeads(rig.name)) {
			const settleable =
				(head.status === "running" && head.endAt * 1000 <= Date.now()) ||
				head.status === "voided";
			if (!settleable) continue;
			const pending = listRows().some(
				(r) =>
					r.slotId === head.slotId &&
					r.status !== "anchored" &&
					r.status !== "rejected",
			);
			if (pending) continue;
			const chain = chainOf(head);
			if (chain === null) continue;
			const key = `settle:${head.chainKey}:${head.slotId}`;
			if (!beginInFlight(key)) continue;
			try {
				const slots = await import("#/market/zg-slots");
				await slots.settleSlot(chain, head.slotId);
				await refreshRig(rig.name);
			} catch (e) {
				console.error(`[market] settle ${head.slotId} failed:`, e);
			} finally {
				endInFlight(key);
			}
		}
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
					episodeIndex: ep.episodeIndex,
					frames: ep.frames,
					durationS: ep.durationS,
					jointPathDeg: ep.jointPathDeg,
					maxJointRangeDeg: ep.maxJointRangeDeg,
					gripperCycles: ep.gripperCycles,
					stillFraction: ep.stillFraction,
				};
		}
		// Wait out the grace window for the episode measurement — it is the
		// best evidence we get, and it lands 1-20s after the save. Anything
		// other than a success claim grades immediately: there is nothing to
		// wait for. (This used to be two guards; the second was a strict
		// superset of the first, so the first never fired.)
		if (
			row.claimed === "success" &&
			row.telemetry.episode === null &&
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
			slotTx: null,
			slotAttested: null,
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
		// THE VERDICT. Deliberately here and not in the `graded` branch: the
		// contract wants a storageRoot, and zgRoot does not exist until the
		// upload above has run. Submitting earlier would mean anchoring every
		// episode to ZeroHash and throwing the evidence link away.
		//
		// This is what pays the operator and what can strike them, and the
		// contract checks 0G's enclave signature itself — so the worst this
		// hub can do is choose which verdict to bring, never invent one.
		if (SLOTS.configured && row.slotId !== null) {
			try {
				const slots = await import("#/market/zg-slots");
				const chain = slotChain(row.slotChain ?? "");
				if (chain !== null) {
					const result = await slots.recordEpisodeOnSlot(
						chain,
						row,
						row.slotId,
					);
					if (result !== null) {
						row.provenance.slotTx = result.txHash;
						row.provenance.slotAttested = result.attested;
						if (row.operator.evmAddress)
							void slots.withdrawFor(chain, row.operator.evmAddress);
					}
				}
			} catch (e) {
				console.error(`[market] slot verdict failed for ${row.id}:`, e);
			}
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
