/**
 * 0G Compute grader (Direct SDK) — M3 fills this. Reaching it before M3
 * throws, which grader/index.ts converts into a local fallback grade.
 */
import type { Grade } from "#/market/grader/index";
import type { LedgerRow } from "#/market/store";

export const gradeZg = async (_row: LedgerRow): Promise<Grade> => {
	throw new Error("0G Direct SDK grader not wired yet (M3)");
};
