import type { DriverError, PreflightError } from "#/api/contract";

/*
 * runApi rejects with Cause.squash(cause), so typed API failures arrive as the
 * tagged error instance itself — duck-type on _tag (not instanceof) to stay
 * robust across the effect beta.
 */
const tagOf = (e: unknown): string | null =>
	typeof e === "object" && e !== null && "_tag" in e
		? String((e as { _tag: unknown })._tag)
		: null;

export const isPreflightError = (e: unknown): e is PreflightError =>
	tagOf(e) === "PreflightError";

const isDriverError = (e: unknown): e is DriverError =>
	tagOf(e) === "DriverError";

/** Short, human message — never a stack wall. */
export const apiErrorMessage = (e: unknown): string => {
	if (isDriverError(e) || isPreflightError(e)) return e.message;
	if (tagOf(e) === "RequestError")
		return "API unreachable — is the console server running?";
	if (e instanceof Error) return e.message.split("\n")[0];
	return String(e).split("\n")[0];
};
