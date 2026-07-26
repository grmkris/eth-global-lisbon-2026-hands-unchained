import type { RigSummary } from "#/lib/hub-api";
import type { SlotState } from "#/market/use-slot";

/**
 * Everything standing between an operator and one recorded episode, as data.
 *
 * This was a seven-branch ternary collapsed into a single string
 * (`attemptBlockedReason`) that went nowhere but a `title=` attribute — so six
 * sevenths of what the page knew was thrown away, and the one branch that
 * survived was a dead end: "stake to drive" with nothing to press.
 *
 * As a list it does two jobs at once. The task rows render it as a checklist
 * with each unmet item's remedy inline, and `blockedLabel` still hands the old
 * string to whatever wants a tooltip. That is also why the slot gate stopped
 * being its own concept: it is `verified` and `staked`, two rows of this.
 */
export type RequirementKey =
	| "online"
	| "verified"
	| "staked"
	| "armConnected"
	| "cameras"
	| "source";

export interface Requirement {
	key: RequirementKey;
	/**
	 * TWO DIFFERENT KINDS OF THING, and rendering them as one list was the
	 * mistake: five of seven rows were ticked before the operator did anything,
	 * which buried the one or two that were actually theirs to do.
	 *
	 * - `rig` — a precondition. Nobody "passes" it: either it is fine and says
	 *   nothing, or it is broken and is the only thing worth showing.
	 * - `operator` — a step, in order, done by the person reading it.
	 */
	kind: "rig" | "operator";
	/** what is needed, in the operator's words — also the tooltip fallback */
	label: string;
	/** how it reads once cleared: a fact, not a leftover instruction */
	metLabel: string;
	met: boolean;
	/** who can clear it: the operator, the rig's owner, or only time */
	actor: "you" | "owner" | "wait";
}

export interface StartRequirementsState {
	requirements: ReadonlyArray<Requirement>;
	/** the first unmet requirement's label, or null when nothing is in the way.
	 * Byte-for-byte the old `attemptBlockedReason`, so no call site regresses. */
	blockedLabel: string | null;
	blocked: boolean;
}

export function useStartRequirements(input: {
	rig: RigSummary | undefined;
	slot: SlotState;
	marketOn: boolean;
	verified: boolean;
	needsStake: boolean;
	iAmDriving: boolean;
	inTeleop: boolean;
	/** what is consuming input right now — null means nothing is */
	sink: string | null;
	/** the bound remote leader, so `remote` can be named after a person */
	drivingLeaderName?: string | null;
}): StartRequirementsState {
	const {
		rig,
		slot,
		marketOn,
		verified,
		needsStake,
		iAmDriving,
		inTeleop,
		sink,
		drivingLeaderName = null,
	} = input;

	/** `keys`/`leader`/`remote` are driver-side source names. Nobody driving an
	 * arm should have to read "driving — remote" and work out that it means the
	 * leader on someone's desk. */
	const sourceName =
		sink === "keys"
			? "keyboard"
			: sink === "leader"
				? "the rig's own leader arm"
				: sink === "remote"
					? `${drivingLeaderName ?? "a remote"}'s leader`
					: sink;

	const minutes = Math.round(
		(slot.config?.chains[0]?.params?.slotSeconds ?? 1800) / 60,
	);
	const stake = slot.config?.chains[0]?.params?.minStakeOg ?? 0;
	const token = slot.config?.chains[0]?.token ?? "OG";

	/**
	 * ORDER IS LOAD-BEARING. `blockedLabel` is "the first unmet requirement", and
	 * it has to keep matching the ternary chain this replaced or the tooltips and
	 * the disabled states start disagreeing about why.
	 *
	 * `source` deliberately precedes `lease`: picking how you drive CLAIMS the
	 * rig, so clearing the former usually clears the latter, and telling someone
	 * "you don't hold this rig" when the fix is "pick a source" sends them
	 * looking for a Take Control button that does not exist.
	 */
	/** somebody else is holding the arm — picking a source takes it from them */
	const heldByOther = !iAmDriving && rig?.holder != null;

	const requirements: Requirement[] = [
		{
			key: "online",
			kind: "rig",
			label: "this rig is offline",
			metLabel: "the rig is online",
			met: rig?.online === true,
			actor: "wait",
		},
		{
			key: "verified",
			kind: "operator",
			label: "verify with World ID",
			metLabel: "verified",
			// only a gate when the market is on; a bare hub has no identity layer
			met: !marketOn || verified,
			actor: "you",
		},
		{
			key: "staked",
			kind: "operator",
			label: `stake ${stake} ${token} · ${minutes} min`,
			metLabel: `${stake} ${token} staked`,
			met: !needsStake,
			actor: "you",
		},
		{
			key: "armConnected",
			kind: "rig",
			label: "the arm is not connected",
			metLabel: "the arm is connected",
			met: rig?.armState !== undefined && rig.armState !== "disconnected",
			// the Connect button only exists for whoever holds the rig
			actor: iAmDriving ? "you" : "wait",
		},
		{
			key: "cameras",
			kind: "rig",
			// a real rig records from cameras the owner has mapped; the operator
			// cannot fix this one from here, so say whose job it is
			label: "this rig's cameras are not confirmed",
			metLabel: "cameras confirmed",
			met:
				rig?.backend !== "real" ||
				(rig.camMapping?.workspace !== null && rig.camMapping?.wrist !== null),
			actor: "owner",
		},
		{
			/**
			 * The fix for the trap that recorded an episode with NOTHING driving the
			 * arm: attempts.ts takes whatever source is live, so an attempt started
			 * before choosing one burns an episode against the task's quota while
			 * the arm sits still.
			 *
			 * HOLDING THE RIG IS PART OF THIS STEP, not a row of its own. Picking a
			 * source claims the lease (`pickSource` in drive.$rig.tsx claims, then
			 * starts, with a confirm when stealing) — so a separate "you hold this
			 * rig" line only ever sent people looking for a Take Control button that
			 * deliberately does not exist.
			 */
			key: "source",
			kind: "operator",
			label: heldByOther
				? "take over — someone else is driving"
				: "pick how you'll drive",
			metLabel: `driving — ${sourceName}`,
			met: inTeleop && sink !== null && iAmDriving,
			actor: "you",
		},
	];

	const first = requirements.find((r) => !r.met) ?? null;
	return {
		requirements,
		blockedLabel: first?.label ?? null,
		blocked: first !== null,
	};
}
