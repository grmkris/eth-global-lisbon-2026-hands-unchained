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

export const grade = async (row: LedgerRow): Promise<Grade> => {
	// A "success" claim with no saved episode is fraud-shaped regardless of
	// grader: the work product does not exist. episodeSaved === null means the
	// recorder telemetry never surfaced — unknown, so don't auto-reject.
	if (row.claimed === "success" && row.telemetry.episodeSaved === false)
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
	if (
		row.telemetry.episode === null &&
		row.telemetry.inputPackets === 0 &&
		row.telemetry.jointTravelDeg === 0 &&
		row.telemetry.episodeSaved === true
	)
		return {
			score: 70,
			pass: true,
			provider: "precheck(blind)",
			reason: hubBlindSource(row.source)
				? `episode saved and driven by "${row.source}", which never sends input through the hub — there is nothing for us to measure, so the claim is credited`
				: "episode saved but no hub-observable input reached us — we were blind, which is not evidence of fraud, so the claim is credited",
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
