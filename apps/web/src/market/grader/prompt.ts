/**
 * Shared between the 0G Direct-SDK and Router graders so swapping the judge
 * never changes the question. Grading is TELEMETRY-based by design: for a
 * robot labor market, "did the trajectory look like real work" is more
 * defensible than captioning a frame — and it is immune to provider-catalog
 * churn (text models always exist).
 */
import type { LedgerRow } from "#/market/store";

export const gradingPrompt = (row: LedgerRow): string =>
	[
		"You are the neutral referee of a robot teleoperation labor market.",
		"An operator drove a robot arm attempting a task, then claimed the result below.",
		"Judge ONLY from the telemetry below. `recordedEpisode` is measured from",
		"the SAVED EPISODE on disk — the arm's real trajectory at 30fps — so when",
		"it is present, TRUST IT OVER EVERYTHING ELSE; the other fields are",
		"network-side proxies that read zero for some legitimate setups.",
		"Fraud looks like: a 'success' claim whose recorded episode is near-",
		"motionless (tiny jointPathDeg, stillFraction near 1) or has no episode.",
		"",
		`Task: ${JSON.stringify(row.taskTitle ?? row.taskId ?? "unknown")}`,
		`Operator claimed: ${row.claimed}`,
		"Telemetry (hub-observed, operator cannot forge it):",
		JSON.stringify(
			{
				recordedEpisode: row.telemetry.episode,
				durationSeconds: Math.round(row.telemetry.durationS * 10) / 10,
				commandedMotion: Math.round(row.telemetry.commandedMotion * 10) / 10,
				inputPackets: row.telemetry.inputPackets,
				gripperCycles: row.telemetry.gripperCycles,
				jointTravelDeg: Math.round(row.telemetry.jointTravelDeg),
				episodeSaved: row.telemetry.episodeSaved,
			},
			null,
			1,
		),
		"",
		"Scoring guide: episodeSaved true + sustained motion + gripper use in a",
		"5-300s window reads as real work (score 70-100). Sparse input, zero",
		"gripper cycles or implausible duration reads as low effort or fraud.",
		'Reply with STRICT JSON only, no prose: {"score": <0-100>, "pass": <bool>, "reason": "<one sentence>"}',
	].join("\n");

export const parseVerdict = (
	text: string,
): { score: number; pass: boolean; reason: string } => {
	const match = text.match(/\{[\s\S]*\}/);
	if (!match) throw new Error(`no JSON in grader reply: ${text.slice(0, 200)}`);
	const parsed = JSON.parse(match[0]) as {
		score?: unknown;
		pass?: unknown;
		reason?: unknown;
	};
	const score = Number(parsed.score);
	if (!Number.isFinite(score)) throw new Error("verdict has no numeric score");
	return {
		score: Math.max(0, Math.min(100, Math.round(score))),
		pass: parsed.pass === true,
		reason:
			typeof parsed.reason === "string" ? parsed.reason : "no reason given",
	};
};
