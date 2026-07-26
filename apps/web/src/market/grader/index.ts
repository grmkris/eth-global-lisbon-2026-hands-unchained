/**
 * The referee seam. Every sponsor track plugs into this one function:
 * `GRADER=zg` grades on 0G Compute (TEE-attested), `zg-router` on the 0G
 * Router, `local` on heuristics. Whatever is configured, any error or
 * timeout degrades to `local` — grading can get less fancy but the loop
 * never breaks. The grade is what the REFEREE said; `row.claimed` is what
 * the operator said. Keeping them separate is the product.
 */
import { GRADER } from "#/market/config";
import { gradeLocal } from "#/market/grader/local";
import type { LedgerRow } from "#/market/store";

export interface Grade {
	score: number; // 0-100
	pass: boolean;
	provider: string;
	reason: string;
	proof: Record<string, unknown> | null;
}

/** Real 0G verdicts have taken ~60s on testnet — budget generously; the
 * worker is async and the demo narrates "the referee is deliberating". */
const GRADE_TIMEOUT_MS = 90_000;

/** Sources whose motion is invisible to the hub BY DESIGN: a leader arm
 * plugged into the rig's own machine talks to the follower over USB, and a
 * scripted run needs no operator at all. Zero input from these is expected. */
const hubBlindSource = (source: string | null): boolean =>
	source === "leader" || source === "scripted";

/**
 * Total joint travel below which a recorded episode is not work.
 *
 * A real 20 s attempt runs to hundreds of degrees (the smoke test reports ~290°
 * for an ordinary one); servo jitter on a parked arm accrues single digits. 15°
 * sits far below any deliberate motion and far above noise, so it separates
 * "did nothing" from "did something small" without needing a model.
 */
const STILL_PATH_DEG = 15;

export const grade = async (row: LedgerRow): Promise<Grade> => {
	// A "success" claim with no saved episode is fraud-shaped regardless of
	// grader: the work product does not exist. episodeSaved === null means the
	// recorder telemetry never surfaced — unknown, so don't auto-reject.
	//
	// But `episodeSaved` is a DERIVED flag (a delta on the recorder's counter,
	// sampled over the network) while `episode` is the parquet itself, read off
	// disk and proven to belong to this attempt. When they disagree, the file
	// wins: a real operator drove 972° of arc across 580 recorded frames and
	// this precheck failed them for "no saved episode", never even reaching the
	// referee. Direct evidence outranks a counter every time.
	if (
		row.claimed === "success" &&
		row.telemetry.episodeSaved === false &&
		row.telemetry.episode === null
	)
		return {
			score: 0,
			pass: false,
			provider: "precheck",
			reason: "claimed success but the rig saved no episode",
			proof: null,
		};
	if (row.claimed !== "success")
		return {
			score: 0,
			pass: false,
			provider: "precheck",
			reason:
				row.claimed === "abandoned"
					? "operator abandoned the attempt"
					: "operator discarded the attempt",
			proof: null,
		};

	// ABSENCE OF EVIDENCE IS NOT EVIDENCE OF FRAUD. Some ways of driving
	// never traverse the hub at all — a leader arm wired straight into the
	// rig, for one — so we can see an episode was saved without seeing a
	// single input packet. Sending that to the referee gets an honest
	// operator failed for "zero commanded motion" and their stake slashed,
	// which happened for real. If the rig saved the episode and we simply
	// could not watch, credit the work and say the telemetry was blind.
	// Only "blind" when the RECORDING could not be read back either. With the
	// episode in hand there is nothing to be blind about — it is the arm's
	// real trajectory, whatever the drive source was.
	//
	// GATED ON THE SOURCE, and that is the whole point. The condition below is
	// also the exact fingerprint of an operator who started an attempt, touched
	// nothing and claimed success — so without asking WHICH source we are blind
	// to, this branch credited every empty episode at 70 and the referee was
	// never called. `keys`, `phone` and `remote` all reach the rig THROUGH the
	// hub: zero packets from them is not blindness, it is stillness.
	if (
		hubBlindSource(row.source) &&
		row.telemetry.episode === null &&
		row.telemetry.inputPackets === 0 &&
		row.telemetry.jointTravelDeg === 0 &&
		row.telemetry.episodeSaved === true
	)
		return {
			score: 70,
			pass: true,
			provider: "precheck(blind)",
			reason: `episode saved and driven by "${row.source}", which never sends input through the hub — there is nothing for us to measure, so the claim is credited`,
			proof: null,
		};

	// Measured stillness, from the episode itself. The parquet is the arm's own
	// trajectory: if it is in hand and shows the arm barely moved, no model
	// verdict should be able to call that success. Deterministic and BEFORE the
	// referee, because this is not a judgement call.
	const ep = row.telemetry.episode;
	if (ep !== null && ep.frames > 0 && ep.jointPathDeg < STILL_PATH_DEG)
		return {
			score: 0,
			pass: false,
			provider: "precheck(still)",
			reason: `claimed success but the recorded episode barely moved — ${ep.jointPathDeg}° of joint travel across ${ep.frames} frames`,
			proof: null,
		};

	if (GRADER === "zg" || GRADER === "zg-router") {
		try {
			const remote = await withTimeout(gradeRemote(row), GRADE_TIMEOUT_MS);
			if (remote) return remote;
		} catch (e) {
			console.error(`[market] ${GRADER} grader failed, falling back:`, e);
			const fallback = gradeLocal(row);
			return {
				...fallback,
				provider: `local(fallback:${GRADER}-error)`,
			};
		}
	}
	return gradeLocal(row);
};

/** Dynamic import keeps chain SDKs out of the boot path — the hub must start
 * (and MARKET_MODE=0 must stay dep-free at runtime) without them. */
const gradeRemote = async (row: LedgerRow): Promise<Grade | null> => {
	if (GRADER === "zg") {
		const { gradeZg } = await import("#/market/grader/zg");
		return gradeZg(row);
	}
	if (GRADER === "zg-router") {
		const { gradeZgRouter } = await import("#/market/grader/zg-router");
		return gradeZgRouter(row);
	}
	return null;
};

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
	new Promise<T>((resolve, reject) => {
		const t = setTimeout(
			() => reject(new Error(`grader timed out after ${ms}ms`)),
			ms,
		);
		p.then(
			(v) => {
				clearTimeout(t);
				resolve(v);
			},
			(e) => {
				clearTimeout(t);
				reject(e);
			},
		);
	});
