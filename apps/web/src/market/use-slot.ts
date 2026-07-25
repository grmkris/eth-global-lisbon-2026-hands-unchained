import { useQuery } from "@tanstack/react-query";
import {
	type MarketSessionInfo,
	type RigSlotInfo,
	rigSlotQuery,
	type SlotsConfig,
	slotsQuery,
} from "#/market/market-api";

/**
 * Everything the drive page needs to know about who owns this arm right now,
 * derived once.
 *
 * Extracted because drive.$rig.tsx is already 600 lines and this would
 * otherwise land as another eighty of derived booleans in a route component
 * that is at its limit.
 */
export interface SlotState {
	/** the hub has a slot contract configured; false = the old platform */
	enabled: boolean;
	config: SlotsConfig | null;
	info: RigSlotInfo | null;
	/** running, unexpired */
	live: RigSlotInfo["live"];
	/** booked, clock not started */
	pending: RigSlotInfo["pending"];
	/** ran out (or was ended early) and still holds the operator's money */
	ended: RigSlotInfo["ended"];
	/** this browser holds a valid token for the live slot */
	hasToken: boolean;
	/** this browser owns the slot, running OR finished — what decides whether
	 * the ledger and the payout are shown. Distinct from hasToken, which stays
	 * live-scoped so it cannot suppress the next operator's unlock prompt. */
	mine: boolean;
	/** seconds after endAt before anyone but the hub may settle */
	gradeGraceSeconds: number;
	/** nobody has booked this rig and one is required */
	needsBooking: boolean;
	/** a slot exists but this browser has not proved it owns it */
	needsUnlock: boolean;
	maxStrikes: number;
	/** why you cannot drive, in the operator's words; null when you can */
	blockedReason: string | null;
}

export const useSlot = (
	rig: string,
	session: MarketSessionInfo | undefined,
): SlotState => {
	const slots = useQuery(slotsQuery);
	const rigSlot = useQuery(rigSlotQuery(rig));

	const config = slots.data ?? null;
	const info = rigSlot.data ?? null;
	const enabled = config?.configured === true;

	const live = info?.live ?? null;
	const pending = info?.pending ?? null;
	const ended = info?.ended ?? null;
	const hasToken = info?.you?.hasToken === true;
	const mine = (info?.you?.mine ?? null) !== null;
	const verified = session?.verified === true;

	const needsBooking =
		enabled && live === null && pending === null && config?.required === true;
	const needsUnlock =
		enabled && !hasToken && (live !== null || pending !== null);

	const blockedReason = !enabled
		? null
		: !verified
			? "verify your World ID to drive"
			: needsBooking
				? "stake to drive this rig"
				: needsUnlock
					? live !== null
						? "someone else is driving this rig right now"
						: "press Take control to start your 30 minutes"
					: null;

	return {
		enabled,
		config,
		info,
		live,
		pending,
		ended,
		hasToken,
		mine,
		needsBooking,
		needsUnlock,
		maxStrikes: config?.chains[0]?.params?.maxStrikes ?? 3,
		gradeGraceSeconds: config?.chains[0]?.params?.gradeGraceSeconds ?? 150,
		blockedReason,
	};
};
