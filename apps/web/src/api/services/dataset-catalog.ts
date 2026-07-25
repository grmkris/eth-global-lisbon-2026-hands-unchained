import * as os from "node:os";
import { Context, Effect, FileSystem, Layer } from "effect";
import {
	type AsyncBuffer,
	asyncBufferFromFile,
	asyncBufferFromUrl,
	parquetReadObjects,
} from "hyparquet";
import {
	DatasetEpisodes,
	DatasetInfo,
	EpisodeInfo,
	PushStatus,
} from "#/api/contract";
import { RIG } from "#/api/rig";
import { DriverManager } from "./driver-manager";
import { HfHub } from "./hf-hub";

const LEROBOT_CACHE = `${os.homedir()}/.cache/huggingface/lerobot`;

interface LocalMeta {
	readonly repoId: string;
	readonly totalEpisodes: number | null;
	readonly totalFrames: number | null;
	readonly fps: number | null;
	readonly cameras: ReadonlyArray<string>;
	readonly codebaseVersion: string | null;
}

export interface DatasetCatalogShape {
	readonly list: () => Effect.Effect<ReadonlyArray<DatasetInfo>>;
	/** Episode report card from local meta parquet (empty when not cached locally). */
	readonly episodes: (repoId: string) => Effect.Effect<DatasetEpisodes>;
	/** Mark a repo as sim-recorded (sidecar; this module is the only owner of that file). */
	readonly tagSim: (repoId: string) => Effect.Effect<void>;
	/** Publish a locally-recorded dataset to the HF Hub. Returns as soon as the
	 * upload STARTS — poll `pushStatus` for the outcome and the URL. */
	readonly push: (
		repoName: string,
		isPrivate: boolean,
	) => Effect.Effect<PushStatus, Error>;
	readonly pushStatus: () => Effect.Effect<PushStatus>;
}

export class DatasetCatalog extends Context.Service<
	DatasetCatalog,
	DatasetCatalogShape
>()("app/DatasetCatalog") {
	static readonly layer = Layer.effect(
		DatasetCatalog,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const hub = yield* HfHub;
			const driver = yield* DriverManager;

			const readMeta = (owner: string, name: string) =>
				fs
					.readFileString(`${LEROBOT_CACHE}/${owner}/${name}/meta/info.json`)
					.pipe(
						Effect.map((raw): LocalMeta => {
							const info = JSON.parse(raw) as Record<string, unknown>;
							const features = (info.features ?? {}) as Record<string, unknown>;
							return {
								repoId: `${owner}/${name}`,
								totalEpisodes: (info.total_episodes as number) ?? null,
								totalFrames: (info.total_frames as number) ?? null,
								fps: (info.fps as number) ?? null,
								cameras: Object.keys(features)
									.filter((k) => k.startsWith("observation.images."))
									.map((k) => k.replace("observation.images.", "")),
								codebaseVersion: (info.codebase_version as string) ?? null,
							};
						}),
						Effect.orElseSucceed(() => null),
					);

			const scanLocal = Effect.gen(function* () {
				const owners = yield* fs
					.readDirectory(LEROBOT_CACHE)
					.pipe(Effect.orElseSucceed(() => [] as Array<string>));
				const metas: Array<LocalMeta> = [];
				for (const owner of owners) {
					if (owner === "calibration" || owner.startsWith(".")) continue;
					const names = yield* fs
						.readDirectory(`${LEROBOT_CACHE}/${owner}`)
						.pipe(Effect.orElseSucceed(() => [] as Array<string>));
					for (const name of names) {
						const meta = yield* readMeta(owner, name);
						if (meta) metas.push(meta);
					}
				}
				return metas;
			});

			const SIM_FILE = `${process.cwd()}/.data/sim-datasets.json`;

			const loadSimSet = fs.readFileString(SIM_FILE).pipe(
				Effect.map((raw) => new Set(JSON.parse(raw) as Array<string>)),
				Effect.orElseSucceed(() => new Set<string>()),
			);

			const tagSim = (repoId: string) =>
				Effect.gen(function* () {
					const existing = yield* loadSimSet;
					if (existing.has(repoId)) return;
					existing.add(repoId);
					yield* fs
						.makeDirectory(`${process.cwd()}/.data`, { recursive: true })
						.pipe(
							Effect.andThen(
								fs.writeFileString(
									SIM_FILE,
									JSON.stringify([...existing], null, 2),
								),
							),
							Effect.orDie,
						);
				});

			// v3 layout: meta/episodes/chunk-*/file-*.parquet with episode_index/length/tasks
			type EpisodeRow = { index: number; frames: number; task: string };

			const rowsFrom = (open: () => Promise<AsyncBuffer>) =>
				Effect.tryPromise(async () => {
					const parsed = await parquetReadObjects({
						file: await open(),
						columns: ["episode_index", "length", "tasks"],
					});
					return (parsed as Array<Record<string, unknown>>).map(
						(row): EpisodeRow => ({
							index: Number(row.episode_index),
							frames: Number(row.length),
							task: Array.isArray(row.tasks)
								? String(row.tasks[0] ?? "")
								: String(row.tasks ?? ""),
						}),
					);
				}).pipe(Effect.orElseSucceed(() => [] as Array<EpisodeRow>));

			const buildReport = (
				repoId: string,
				local: boolean,
				fps: number | null,
				rows: Array<EpisodeRow>,
			) => {
				rows.sort((a, b) => a.index - b.index);
				const sorted = rows.map((r) => r.frames).sort((a, b) => a - b);
				const median =
					sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : null;
				const flag = (frames: number): string | null => {
					if (median === null || rows.length < 5) return null;
					if (frames < 0.6 * median) return "short";
					if (frames > 1.8 * median) return "long";
					return null;
				};
				return new DatasetEpisodes({
					repoId,
					local,
					fps,
					medianFrames: median,
					episodes: rows.map(
						(r) =>
							new EpisodeInfo({
								index: r.index,
								frames: r.frames,
								seconds: fps ? Math.round((r.frames / fps) * 10) / 10 : 0,
								task: r.task,
								flag: flag(r.frames),
							}),
					),
				});
			};

			// Same report straight off the HF Hub — the deployed hub has no lerobot
			// cache, and a dataset recorded on any rig lands on the Hub anyway.
			const remoteEpisodes = (repoId: string) =>
				Effect.gen(function* () {
					const resolve = (p: string) =>
						`https://huggingface.co/datasets/${repoId}/resolve/main/${p}`;
					const info = yield* Effect.tryPromise(async () => {
						const res = await fetch(resolve("meta/info.json"), {
							headers: hub.authHeaders,
						});
						if (!res.ok) throw new Error(`HF ${res.status}`);
						return (await res.json()) as Record<string, unknown>;
					}).pipe(Effect.orElseSucceed(() => null));
					if (info === null)
						return new DatasetEpisodes({
							repoId,
							local: false,
							fps: null,
							medianFrames: null,
							episodes: [],
						});
					const fps = (info.fps as number) ?? null;

					const tree = yield* hub.datasetTree(repoId, "meta/episodes");
					const rows: Array<EpisodeRow> = [];
					for (const entry of tree
						.filter((e) => e.type === "file" && e.path.endsWith(".parquet"))
						.sort((a, b) => a.path.localeCompare(b.path))) {
						rows.push(
							...(yield* rowsFrom(() =>
								asyncBufferFromUrl({
									url: resolve(entry.path),
									requestInit: { headers: hub.authHeaders },
								}),
							)),
						);
					}
					return buildReport(repoId, false, fps, rows);
				});

			const episodes = (repoId: string) =>
				Effect.gen(function* () {
					const root = `${LEROBOT_CACHE}/${repoId}`;
					const meta = yield* fs.readFileString(`${root}/meta/info.json`).pipe(
						Effect.map((raw) => JSON.parse(raw) as Record<string, unknown>),
						Effect.orElseSucceed(() => null),
					);
					if (meta === null) return yield* remoteEpisodes(repoId);
					const fps = (meta.fps as number) ?? null;

					const chunks = yield* fs
						.readDirectory(`${root}/meta/episodes`)
						.pipe(Effect.orElseSucceed(() => [] as Array<string>));
					const files: Array<string> = [];
					for (const chunk of chunks.sort()) {
						const names = yield* fs
							.readDirectory(`${root}/meta/episodes/${chunk}`)
							.pipe(Effect.orElseSucceed(() => [] as Array<string>));
						for (const name of names.sort()) {
							if (name.endsWith(".parquet"))
								files.push(`${root}/meta/episodes/${chunk}/${name}`);
						}
					}

					const rows: Array<EpisodeRow> = [];
					for (const file of files) {
						rows.push(...(yield* rowsFrom(() => asyncBufferFromFile(file))));
					}
					return buildReport(repoId, true, fps, rows);
				});

			return {
				tagSim,
				episodes,
				list: () =>
					Effect.gen(function* () {
						const [local, hubRepos, simSet] = yield* Effect.all(
							[scanLocal, hub.listDatasets(), loadSimSet],
							{ concurrency: 3 },
						);
						const hubById = new Map(hubRepos.map((r) => [r.id, r]));
						const localIds = new Set(local.map((m) => m.repoId));

						const merged = local.map(
							(m) =>
								new DatasetInfo({
									...m,
									isLocal: true,
									onHub: hubById.has(m.repoId),
									hubLastModified: hubById.get(m.repoId)?.lastModified ?? null,
									sim: simSet.has(m.repoId),
								}),
						);
						for (const r of hubRepos) {
							if (localIds.has(r.id)) continue;
							merged.push(
								new DatasetInfo({
									repoId: r.id,
									isLocal: false,
									onHub: true,
									totalEpisodes: null,
									totalFrames: null,
									fps: null,
									cameras: [],
									codebaseVersion: null,
									hubLastModified: r.lastModified,
									sim: simSet.has(r.id),
								}),
							);
						}
						return merged.sort((a, b) =>
							(b.hubLastModified ?? "").localeCompare(a.hubLastModified ?? ""),
						);
					}),

				pushStatus: () =>
					driver.push().pipe(Effect.map((s) => new PushStatus(s))),

				// repoName, never a full repoId: the rig owns its own HF namespace,
				// exactly like tasks. An operator cannot aim a push at someone else's.
				push: (repoName, isPrivate) =>
					driver
						.rpc<{ started: boolean; repoId: string }>("dataset_push", {
							repo_id: `${RIG.hfUser}/${repoName}`,
							private: isPrivate,
						})
						.pipe(
							Effect.map(
								(r) =>
									new PushStatus({
										phase: "uploading",
										repoId: r.repoId,
										url: null,
										error: null,
									}),
							),
						),
			};
		}),
	);
}
