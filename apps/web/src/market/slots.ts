/**
 * The slot mirror: a cache of what the chain says, per rig.
 *
 * THE CHAIN IS THE SOURCE OF TRUTH, and that is the whole point of this file.
 * Everything hub-side is an in-memory Map that dies on redeploy — which is
 * exactly how the Hedera bond map strands stakes today: the money is on chain,
 * the record of it was in RAM, and a Railway deploy loses the second one. Here
 * the record IS on chain, so `reconcile()` reads it back and a hub that
 * restarts mid-slot picks the slot up again with the right operator and the
 * right remaining seconds.
 *
 * Two rules the call sites depend on:
 *  - Reads FAIL OPEN. An RPC blip must never revoke a live operator's slot, so
 *    a cached slot keeps being honoured while the network is down; `endAt` is
 *    already known and arithmetic on it needs no network.
 *  - Writes FAIL CLOSED. An unlock we cannot verify is refused, because minting
 *    a capability we could not check is the one unsafe direction.
 */
import { listRigs } from "#/hub/store";
import { SLOTS, type SlotChain, slotChain, slotChains } from "#/market/config";
import type { SlotView } from "#/market/zg-slots";

/** ethers stays OUT of the boot path — the hub must start, and MARKET_MODE=0
 * must stay dep-free at runtime, without any chain SDK loading. Same rule the
 * grader and tee-bridge follow. */
const chain = () => import("#/market/zg-slots");

/** What one chain says about one rig. */
export interface ChainSlots {
	chainKey: string;
	/** head of the queue — `booked` (waiting for a PIN) or `running` */
	head: SlotView | null;
	queue: SlotView[];
	/** when the head reached the front; the no-show clock, not bookedAt */
	headSince: number;
}

export interface RigSlots {
	rig: string;
	/** one entry per configured chain — a rig can be booked on either */
	chains: ChainSlots[];
	polledAt: number;
	/** last RPC failure, surfaced rather than swallowed */
	error: string | null;
}

/** What actually moved the money at the end of a slot. `withdrawTx` is often
 * null and that is not a failure: `settle` pays straight to the operator
 * unless the transfer fails, in which case the amount is deferred to `owed`
 * and a separate `withdraw` pushes it. */
export interface SlotPayout {
	chainKey: string;
	settleTx: string | null;
	withdrawTx: string | null;
	/** who called it — the hub's settler, or the operator's own wallet */
	by: "hub" | "self";
	at: number;
}

interface MirrorState {
	byRig: Map<string, RigSlots>;
	/** clientId -> slotId, learned at unlock — the analogue of noteClient */
	clientSlot: Map<string, { slotId: number; at: number }>;
	/** slotIds whose end-of-slot enforcement already ran (once per slot) */
	enforced: Set<number>;
	/** in-flight settle/skip guard, so a 1 Hz tick cannot stack transactions */
	inFlight: Set<string>;
	/** slotId -> the transactions that PAID, kept because the worker used to
	 * throw these hashes away and "you were paid" with nothing to click is
	 * indistinguishable from a claim */
	payouts: Map<number, SlotPayout>;
	timer: ReturnType<typeof setInterval> | null;
	busy: boolean;
}

const g = globalThis as unknown as { __slotMirror?: MirrorState };
g.__slotMirror ??= {
	byRig: new Map(),
	clientSlot: new Map(),
	enforced: new Set(),
	inFlight: new Set(),
	payouts: new Map(),
	timer: null,
	busy: false,
};
const state = g.__slotMirror;

/** A live slot is refreshed often; an idle rig is not worth the RPC. */
const POLL_LIVE_MS = 3_000;
const POLL_QUEUED_MS = 5_000;
const POLL_IDLE_MS = 15_000;
const TICK_MS = 1_000;

const heads = (entry: RigSlots): SlotView[] =>
	entry.chains.map((c) => c.head).filter((h): h is SlotView => h !== null);

const staleAfter = (entry: RigSlots): number => {
	const hs = heads(entry);
	if (hs.length === 0) return POLL_IDLE_MS;
	return hs.some((h) => h.status === "running") ? POLL_LIVE_MS : POLL_QUEUED_MS;
};

export const refreshRig = async (rig: string): Promise<RigSlots | null> => {
	if (!SLOTS.configured) return null;
	try {
		const c = await chain();
		const chains = await Promise.all(
			slotChains().map(async (sc): Promise<ChainSlots> => {
				const [head, queue, since] = await Promise.all([
					c.headSlot(sc, rig),
					c.queueFor(sc, rig),
					c.headSince(sc, rig),
				]);
				return { chainKey: sc.key, head, queue, headSince: since ?? 0 };
			}),
		);
		const entry: RigSlots = {
			rig,
			chains,
			polledAt: Date.now(),
			error: null,
		};
		state.byRig.set(rig, entry);
		return entry;
	} catch (e) {
		// Keep the last good read. An RPC blip is not a reason to take someone's
		// slot away — see the fail-open rule in the header.
		const previous = state.byRig.get(rig);
		const message = e instanceof Error ? e.message : "chain read failed";
		if (previous) {
			previous.error = message;
			return previous;
		}
		const entry: RigSlots = {
			rig,
			chains: [],
			polledAt: Date.now(),
			error: message,
		};
		state.byRig.set(rig, entry);
		return entry;
	}
};

/** Re-read a slot we already know the id of (post-write confirmation). */
export const refreshSlot = async (
	sc: SlotChain,
	slotId: number,
): Promise<SlotView | null> =>
	SLOTS.configured ? (await chain()).readSlot(sc, slotId) : null;

export const cachedRig = (rig: string): RigSlots | null =>
	state.byRig.get(rig) ?? null;

/**
 * The one derived value everything gates on. Note it goes null the instant the
 * clock passes `endAt`, BEFORE the chain is settled — so "refuse further claims
 * and let the next operator in" falls out of the gate rather than needing a
 * second mechanism, and it keeps working with the RPC down.
 */
export const liveSlot = (rig: string): SlotView | null => {
	const entry = state.byRig.get(rig);
	if (!entry) return null;
	// A rig can be booked on either chain, but only ONE person may hold the arm.
	// The hub enforces that at unlock (it refuses to relay startSlot on chain B
	// while chain A is live), so at most one of these should ever be running —
	// and if two somehow are, the earliest start wins and stays winning.
	const running = heads(entry)
		.filter((h) => h.status === "running" && h.endAt * 1000 > Date.now())
		.sort((a, b) => a.startedAt - b.startedAt);
	return running[0] ?? null;
};

/** The chain a given slot's money lives on. */
export const chainOf = (slot: SlotView): SlotChain | null =>
	slotChain(slot.chainKey);

/** Booked but never unlocked — the head is waiting for someone to type a key. */
export const pendingSlot = (rig: string): SlotView | null => {
	const entry = state.byRig.get(rig);
	if (!entry) return null;
	return heads(entry).find((h) => h.status === "booked") ?? null;
};

/** Every head across every chain — what the enforcement tick walks. */
export const allHeads = (rig: string): SlotView[] => {
	const entry = state.byRig.get(rig);
	return entry ? heads(entry) : [];
};

export const remainingMs = (slot: SlotView): number =>
	Math.max(0, slot.endAt * 1000 - Date.now());

// --- clientId <-> slot binding ----------------------------------------------

export const noteSlotClient = (clientId: string, slotId: number): void => {
	state.clientSlot.set(clientId, { slotId, at: Date.now() });
};

export const slotIdForClient = (clientId: string): number | null =>
	state.clientSlot.get(clientId)?.slotId ?? null;

// --- one-shot guards ---------------------------------------------------------

export const markEnforced = (slotId: number): boolean => {
	if (state.enforced.has(slotId)) return false;
	state.enforced.add(slotId);
	return true;
};

export const beginInFlight = (key: string): boolean => {
	if (state.inFlight.has(key)) return false;
	state.inFlight.add(key);
	return true;
};

export const endInFlight = (key: string): void => {
	state.inFlight.delete(key);
};

// --- payout receipts ---------------------------------------------------------

export const notePayout = (
	slotId: number,
	patch: Partial<SlotPayout> & { chainKey: string },
): void => {
	const existing = state.payouts.get(slotId);
	state.payouts.set(slotId, {
		chainKey: patch.chainKey,
		settleTx: patch.settleTx ?? existing?.settleTx ?? null,
		withdrawTx: patch.withdrawTx ?? existing?.withdrawTx ?? null,
		by: patch.by ?? existing?.by ?? "hub",
		at: Date.now(),
	});
};

export const payoutFor = (slotId: number): SlotPayout | null =>
	state.payouts.get(slotId) ?? null;

// --- the poller --------------------------------------------------------------

const pollDue = async (): Promise<void> => {
	if (state.busy) return;
	state.busy = true;
	try {
		for (const rig of listRigs()) {
			const entry = state.byRig.get(rig.name);
			if (entry && Date.now() - entry.polledAt < staleAfter(entry)) continue;
			await refreshRig(rig.name);
		}
	} catch (e) {
		console.error("[slots] poll failed:", e);
	} finally {
		state.busy = false;
	}
};

/**
 * Boot recovery. Called from ensureWorker beside the Hedera mirror rehydrate:
 * read every registered rig's slot state back off the chain so a redeploy
 * mid-slot resumes instead of stranding the operator.
 *
 * What is NOT recovered, said out loud rather than left to be discovered: the
 * clientId -> slot binding, which lived only in this process. The PIN is the
 * recovery mechanism — the operator re-types it, the hub re-verifies it against
 * the on-chain commitment, and the binding is rebuilt with no wallet popup and
 * no lost minute.
 */
export const ensureSlotMirror = (): void => {
	if (!SLOTS.configured || state.timer !== null) return;
	state.timer = setInterval(() => void pollDue(), TICK_MS);
	void (async () => {
		for (const rig of listRigs()) await refreshRig(rig.name);
		const known = [...state.byRig.values()].flatMap((e) =>
			heads(e).map((h) => `${e.rig}#${h.slotId}@${h.chainKey}(${h.status})`),
		);
		if (known.length > 0)
			console.error(`[slots] reconciled from chain: ${known.join(", ")}`);
	})();
	console.error(
		`[slots] mirror live on ${slotChains()
			.map((c) => `${c.label} ${c.address.slice(0, 10)}…`)
			.join(" + ")} (ns "${SLOTS.namespace}")`,
	);
};
