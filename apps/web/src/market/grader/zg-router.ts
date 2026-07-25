/**
 * 0G Router grader (OpenAI-compatible) — M3 fills this. Reaching it before
 * M3 throws, which grader/index.ts converts into a local fallback grade.
 */
import type { Grade } from "#/market/grader/index";
import type { LedgerRow } from "#/market/store";

export const gradeZgRouter = async (_row: LedgerRow): Promise<Grade> => {
	throw new Error("0G Router grader not wired yet (M3)");
};
