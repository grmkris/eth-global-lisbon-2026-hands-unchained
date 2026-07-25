import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { LabApi } from "#/api/contract";

const baseUrl =
	typeof window === "undefined"
		? "http://localhost:3000"
		: window.location.origin;

// One client for the module lifetime (skill rule: never construct per query).
// The HttpClient is captured at construction, so per-call effects need no layer.
const clientPromise = Effect.runPromise(
	HttpApiClient.make(LabApi, { baseUrl }).pipe(
		Effect.provide(FetchHttpClient.layer),
	),
);

type LabClient = Awaited<typeof clientPromise>;

/** Narrow promise bridge for TanStack Query — components never touch Effect. */
export const runApi = <A, E>(
	use: (client: LabClient) => Effect.Effect<A, E>,
): Promise<A> => clientPromise.then((client) => Effect.runPromise(use(client)));
