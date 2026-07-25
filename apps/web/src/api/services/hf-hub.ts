import * as os from "node:os";
import { Context, Effect, FileSystem, Layer } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { RIG } from "#/api/rig";

const HF_API = "https://huggingface.co/api";

export interface HubRepo {
	readonly id: string;
	readonly lastModified: string | null;
}

export interface HfHubShape {
	readonly listDatasets: () => Effect.Effect<ReadonlyArray<HubRepo>>;
	readonly listModels: () => Effect.Effect<ReadonlyArray<HubRepo>>;
	/** Directory names under `checkpoints/` of a model repo ([] if none/unreachable). */
	readonly checkpointSteps: (
		repoId: string,
	) => Effect.Effect<ReadonlyArray<string>>;
}

export class HfHub extends Context.Service<HfHub, HfHubShape>()("app/HfHub") {
	static readonly layer = Layer.effect(
		HfHub,
		Effect.gen(function* () {
			const client = yield* HttpClient.HttpClient;
			const fs = yield* FileSystem.FileSystem;

			const token = yield* fs
				.readFileString(`${os.homedir()}/.cache/huggingface/token`)
				.pipe(
					Effect.map((s) => s.trim()),
					Effect.orElseSucceed(() => null),
				);

			const getJson = (url: string) =>
				Effect.gen(function* () {
					let req = HttpClientRequest.get(url);
					if (token)
						req = HttpClientRequest.setHeader(
							req,
							"authorization",
							`Bearer ${token}`,
						);
					const res = yield* client.execute(req);
					if (res.status >= 400)
						return yield* Effect.fail(new Error(`HF ${res.status} for ${url}`));
					return yield* res.json;
				});

			const listRepos = (kind: "datasets" | "models") =>
				getJson(`${HF_API}/${kind}?author=${RIG.hfUser}&limit=100`).pipe(
					Effect.map((body) =>
						(body as Array<{ id: string; lastModified?: string }>).map((r) => ({
							id: r.id,
							lastModified: r.lastModified ?? null,
						})),
					),
					Effect.orElseSucceed(() => []),
				);

			return {
				listDatasets: () => listRepos("datasets"),
				listModels: () => listRepos("models"),
				checkpointSteps: (repoId: string) =>
					getJson(`${HF_API}/models/${repoId}/tree/main/checkpoints`).pipe(
						Effect.map((body) =>
							(body as Array<{ type: string; path: string }>)
								.filter((e) => e.type === "directory")
								.map((e) => e.path.split("/").at(-1) ?? e.path)
								.sort(),
						),
						Effect.orElseSucceed(() => []),
					),
			};
		}),
	);
}
