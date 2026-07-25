/**
 * Heuristic grader — the permanent fallback and the M1 bring-up referee.
 * Grades on the same telemetry the 0G grader sees, so swapping graders
 * changes the judge, not the evidence.
 */
import type { Grade } from "#/market/grader/index";
import type { LedgerRow } from "#/market/store";

export const gradeLocal = (row: LedgerRow): Grade => {
	const t = row.telemetry;
	const checks: Array<{ ok: boolean; weight: number; label: string }> = [
		{
			// long enough to have done something, short enough to be one episode
			ok: t.durationS >= 5 && t.durationS <= 300,
			weight: 25,
			label: `duration ${t.durationS.toFixed(1)}s in [5,300]`,
		},
		{
			// null = recorder telemetry unknown — give benefit of the doubt here;
			// the false case is already auto-rejected in the precheck
			ok: t.episodeSaved !== false,
			weight: 35,
			label: `episode saved: ${t.episodeSaved === null ? "unknown" : t.episodeSaved}`,
		},
		{
			ok: t.gripperCycles >= 1,
			weight: 20,
			label: `gripper cycles ${t.gripperCycles} >= 1`,
		},
		{
			// real manipulation shows up as commanded input (the hub relays
			// every packet; rig.joints freeze while recording, so commanded
			// motion is the primary evidence, joint travel the bonus)
			ok: t.commandedMotion >= 10 || t.jointTravelDeg >= 30,
			weight: 20,
			label: `motion (commanded ${t.commandedMotion.toFixed(0)}, joints ${t.jointTravelDeg.toFixed(0)}°) plausible`,
		},
	];
	const score = checks.reduce((sum, c) => sum + (c.ok ? c.weight : 0), 0);
	const failed = checks.filter((c) => !c.ok).map((c) => c.label);
	return {
		score,
		pass: score >= 60,
		provider: "local",
		reason:
			failed.length === 0
				? "all telemetry heuristics passed"
				: `failed: ${failed.join("; ")}`,
		proof: null,
	};
};
