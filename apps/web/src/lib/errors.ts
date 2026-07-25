/*
 * runApi rejects with Cause.squash(cause), so typed API failures arrive as the
 * tagged error instance itself — duck-type on _tag (not instanceof) to stay
 * robust across the effect beta.
 */
const tagOf = (e: unknown): string | null =>
	typeof e === "object" && e !== null && "_tag" in e
		? String((e as { _tag: unknown })._tag)
		: null;

/** Short, human message — never a stack wall. */
export const apiErrorMessage = (e: unknown): string => {
	const tag = tagOf(e);
	const tagged = e as { message?: string };
	if (
		(tag === "DriverError" || tag === "PreflightError") &&
		typeof tagged.message === "string"
	)
		return tagged.message;
	if (tag === "RequestError") return "API unreachable — hub down?";
	if (e instanceof Error) return e.message.split("\n")[0];
	return String(e).split("\n")[0];
};
