/**
 * Heuristic grader — the permanent fallback and the M1 bring-up referee.
 * Grades on the same telemetry the 0G grader sees, so swapping graders
 * changes the judge, not the evidence.
 */
import type { Grade } from "#/market/grader/index";
import type { LedgerRow } from "#/market/store";

export const gradeLocal = (row: LedgerRow): Grade => {
	const t = row.telemetry;

	// The recorded episode outranks everything else: it is what the arm
	// actually did, at 30fps, for every drive source.
	if (t.episode !== null) {
		const e = t.episode;
		const checks = [
			{ ok: e.frames >= 15, weight: 20, label: `${e.frames} frames recorded` },
			{
				ok: e.jointPathDeg >= 25,
				weight: 35,
				label: `${e.jointPathDeg}° of joint travel`,
			},
			{
				ok: e.stillFraction <= 0.9,
				weight: 25,
				label: `arm moving ${Math.round((1 - e.stillFraction) * 100)}% of frames`,
			},
			{
				ok: e.maxJointRangeDeg >= 5,
				weight: 20,
				label: `${e.maxJointRangeDeg}° widest joint excursion`,
			},
		];
		const score = checks.reduce((sum, c) => sum + (c.ok ? c.weight : 0), 0);
		const failed = checks.filter((c) => !c.ok).map((c) => c.label);
		return {
			score,
			pass: score >= 60,
			provider: "local(episode)",
			reason:
				failed.length === 0
					? `recorded episode shows real work: ${checks.map((c) => c.label).join(", ")}`
					: `recorded episode looks idle — ${failed.join("; ")}`,
			proof: null,
		};
	}

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
