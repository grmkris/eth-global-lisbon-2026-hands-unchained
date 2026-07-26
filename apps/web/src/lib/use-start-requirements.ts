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
	| "source"
	| "lease";

export interface Requirement {
	key: RequirementKey;
	/** what is needed, in the operator's words — also the tooltip fallback */
	label: string;
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
	const requirements: Requirement[] = [
		{
			key: "online",
			label: "the rig is online",
			met: rig?.online === true,
			actor: "wait",
		},
		{
			key: "verified",
			label: "verified with World ID",
			// only a gate when the market is on; a bare hub has no identity layer
			met: !marketOn || verified,
			actor: "you",
		},
		{
			key: "staked",
			label: `${minutes} min on this arm · ${stake} ${token}`,
			met: !needsStake,
			actor: "you",
		},
		{
			key: "armConnected",
			label: "the arm is connected",
			met: rig?.armState !== undefined && rig.armState !== "disconnected",
			// the Connect button only exists for whoever holds the rig
			actor: iAmDriving ? "you" : "wait",
		},
		{
			key: "cameras",
			// a real rig records from cameras the owner has mapped; the operator
			// cannot fix this one from here, so say whose job it is
			label: "cameras confirmed by the rig owner",
			met:
				rig?.backend !== "real" ||
				(rig.camMapping?.workspace !== null && rig.camMapping?.wrist !== null),
			actor: "owner",
		},
		{
			/**
			 * The fix for the trap that recorded an episode with NOTHING driving the
			 * arm: attempts.ts takes whatever source is live (`priorSource =
			 * robotState.source ?? "keys"`), so an attempt started before choosing
			 * one burns an episode against the task's quota while the arm sits still.
			 */
			key: "source",
			// flips with its own state: once satisfied the row is a status line
			// sitting above chips you can still use, not an unfinished instruction
			label:
				inTeleop && sink !== null
					? `driving — ${sourceName}`
					: "pick how you'll drive",
			met: inTeleop && sink !== null,
			actor: "you",
		},
		{
			key: "lease",
			label: "you hold this rig",
			met: iAmDriving,
			actor: "wait",
		},
	];

	const first = requirements.find((r) => !r.met) ?? null;
	return {
		requirements,
		blockedLabel: first?.label ?? null,
		blocked: first !== null,
	};
}
