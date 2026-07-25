import * as os from "node:os";
import { Context, Effect, FileSystem, Layer } from "effect";
import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";
import { DatasetEpisodes, DatasetInfo, EpisodeInfo } from "#/api/contract";
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
			const episodes = (repoId: string) =>
				Effect.gen(function* () {
					const root = `${LEROBOT_CACHE}/${repoId}`;
					const meta = yield* fs.readFileString(`${root}/meta/info.json`).pipe(
						Effect.map((raw) => JSON.parse(raw) as Record<string, unknown>),
						Effect.orElseSucceed(() => null),
					);
					if (meta === null) {
						return new DatasetEpisodes({
							repoId,
							local: false,
							fps: null,
							medianFrames: null,
							episodes: [],
						});
					}
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

					const rows: Array<{ index: number; frames: number; task: string }> =
						[];
					for (const file of files) {
						const parsed = yield* Effect.tryPromise(async () => {
							const buf = await asyncBufferFromFile(file);
							return parquetReadObjects({
								file: buf,
								columns: ["episode_index", "length", "tasks"],
							});
						}).pipe(Effect.orElseSucceed(() => []));
						for (const row of parsed as Array<Record<string, unknown>>) {
							rows.push({
								index: Number(row.episode_index),
								frames: Number(row.length),
								task: Array.isArray(row.tasks)
									? String(row.tasks[0] ?? "")
									: String(row.tasks ?? ""),
							});
						}
					}
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
						local: true,
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
			};
		}),
	);
}
