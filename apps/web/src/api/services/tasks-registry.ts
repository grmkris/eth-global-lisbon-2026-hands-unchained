/**
 * Rig-side task store — the hub stays a stateless pipe. Tasks live in the
 * sidecar (.data/tasks.json) and are ADVERTISED to the hub over the link
 * (rev-echo: full array only when the hub's echoed rev differs).
 *
 * Owner model: a secret is auto-generated at first boot (.data/owner.json)
 * and PRINTED to the rig's console — whoever runs the rig owns it. Owner
 * verbs relay the key opaquely through the hub; only the rig validates it.
 * Lost key = delete .data/owner.json and restart (tasks survive).
 */
import * as crypto from "node:crypto";
import * as os from "node:os";
import { Context, Effect, FileSystem, Layer } from "effect";
import { ForbiddenError, TaskInfo } from "#/api/contract";
import { isOwnerKey } from "#/api/owner-key";
import { RIG } from "#/api/rig";

const DATA_DIR = `${process.cwd()}/.data`;
const TASKS_FILE = `${DATA_DIR}/tasks.json`;
const LEROBOT_CACHE = `${os.homedir()}/.cache/huggingface/lerobot`;

// Advertised over a 20Hz link — keep the payload bounded.
const MAX_TASKS = 16;
const MAX_TITLE = 80;
const MAX_INSTRUCTIONS = 400;

export interface TasksRegistryShape {
	readonly list: () => Effect.Effect<ReadonlyArray<TaskInfo>>;
	readonly upsert: (
		ownerKey: string,
		task: TaskInfo,
	) => Effect.Effect<TaskInfo, ForbiddenError>;
	readonly remove: (
		ownerKey: string,
		id: string,
	) => Effect.Effect<{ ok: boolean }, ForbiddenError>;
}

const clamp = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

/** total_episodes out of a lerobot meta file, or null for anything unexpected
 * (missing file, half-written JSON) — progress must never fail a task list. */
const totalEpisodes = (raw: string): number | null => {
	try {
		const info = JSON.parse(raw) as { total_episodes?: unknown };
		return typeof info.total_episodes === "number" ? info.total_episodes : null;
	} catch {
		return null;
	}
};

export class TasksRegistry extends Context.Service<
	TasksRegistry,
	TasksRegistryShape
>()("app/TasksRegistry") {
	static readonly layer = Layer.effect(
		TasksRegistry,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;

			// Key generation/printing lives in api/owner-key.ts (shared with the
			// rig link, which gates ALL owner verbs before dispatch).
			const checkKey = (candidate: string) =>
				isOwnerKey(candidate)
					? Effect.void
					: Effect.fail(new ForbiddenError({ message: "wrong owner key" }));

			const load = fs.readFileString(TASKS_FILE).pipe(
				Effect.map((raw) =>
					(JSON.parse(raw) as Array<TaskInfo>).map(
						// episodesDone is derived — never trust/keep what's on disk
						(t) => new TaskInfo({ ...t, episodesDone: null }),
					),
				),
				Effect.orElseSucceed(() => [] as Array<TaskInfo>),
			);

			/** Progress = episodes already in the task's dataset. Same source the
			 * attempt quota check uses (`attempts.ts`), surfaced so operators see
			 * 13/20 and the UI can auto-continue. One small JSON read per task —
			 * cheap enough for the rig's 2 s task refresh. */
			const withProgress = (tasks: ReadonlyArray<TaskInfo>) =>
				Effect.all(
					tasks.map((task) =>
						fs
							.readFileString(
								`${LEROBOT_CACHE}/${RIG.hfUser}/${task.repoName}/meta/info.json`,
							)
							.pipe(
								Effect.map(totalEpisodes),
								Effect.orElseSucceed(() => null), // no dataset yet
								Effect.map(
									(done) => new TaskInfo({ ...task, episodesDone: done }),
								),
							),
					),
					{ concurrency: 4 },
				);

			/** The dataset name a task collects into. Derived from the title when the
			 * owner left it blank — the browser derives the same thing for its
			 * preview, but the RIG must not trust it: a blank name reaching disk
			 * would point the recorder at `<hfUser>/`, not at a dataset. */
			const slugRepoName = (task: TaskInfo) =>
				task.repoName.trim() ||
				`poh_${task.title
					.toLowerCase()
					.replace(/[^a-z0-9]+/g, "_")
					.replace(/^_+|_+$/g, "")
					.slice(0, 30)}` ||
				"poh_task";

			/** Episodes already in a dataset, 0 when it does not exist yet. */
			const episodesIn = (repoName: string) =>
				fs
					.readFileString(
						`${LEROBOT_CACHE}/${RIG.hfUser}/${repoName}/meta/info.json`,
					)
					.pipe(
						Effect.map((raw) => totalEpisodes(raw) ?? 0),
						Effect.orElseSucceed(() => 0),
					);

			/**
			 * A NEW task must never adopt a dataset that already has episodes.
			 *
			 * Progress is the dataset's `total_episodes`, so a task pointed at an
			 * existing dataset inherits its history: a fresh task read 11/5, showed
			 * "complete", and `attempts.ts` refused to record into it. That is easy
			 * to do by accident, because clicking a task in the owner panel loads
			 * its dataset name into the form.
			 *
			 * So: walk to the first free generation (`name`, `name_v2`, `name_v3`…).
			 * "Free" means empty-or-absent, not absent — an existing dataset with no
			 * episodes yet is perfectly good to collect into. The RIG has to be the
			 * one enforcing this: it is the only party that can see datasets on disk
			 * that belong to no task. An UPDATE is left alone on purpose — changing
			 * the name is how an owner deliberately repoints a task.
			 */
			const freeRepoName = (wanted: string) =>
				Effect.gen(function* () {
					for (let gen = 1; gen <= 50; gen++) {
						const candidate = gen === 1 ? wanted : `${wanted}_v${gen}`;
						if ((yield* episodesIn(candidate)) === 0) return candidate;
					}
					return `${wanted}_v51`; // absurd, but never silently reuse
				});

			const save = (tasks: ReadonlyArray<TaskInfo>) =>
				fs
					.makeDirectory(DATA_DIR, { recursive: true })
					.pipe(
						Effect.andThen(
							fs.writeFileString(TASKS_FILE, JSON.stringify(tasks, null, 2)),
						),
						Effect.orDie,
					);

			return {
				list: () => load.pipe(Effect.flatMap(withProgress)),
				upsert: (key, task) =>
					checkKey(key).pipe(
						Effect.andThen(load),
						Effect.flatMap((tasks) =>
							Effect.gen(function* () {
								// creates get a guaranteed-empty dataset; updates keep whatever
								// the owner typed (that is the repoint path)
								const isCreate = !task.id;
								const wanted = slugRepoName(task);
								const repoName = isCreate
									? yield* freeRepoName(wanted)
									: wanted;
								return { tasks, repoName };
							}),
						),
						Effect.flatMap(({ tasks, repoName }) => {
							const cleaned = new TaskInfo({
								...task,
								repoName,
								episodesDone: null, // derived on read, never persisted
								id: task.id || crypto.randomUUID().slice(0, 8),
								title: clamp(task.title, MAX_TITLE),
								instructions: clamp(task.instructions, MAX_INSTRUCTIONS),
							});
							const idx = tasks.findIndex((t) => t.id === cleaned.id);
							const next =
								idx >= 0
									? tasks.map((t, i) => (i === idx ? cleaned : t))
									: [...tasks, cleaned];
							if (next.length > MAX_TASKS)
								return Effect.fail(
									new ForbiddenError({
										message: `at most ${MAX_TASKS} tasks per rig`,
									}),
								);
							return save(next).pipe(Effect.as(cleaned));
						}),
					),
				remove: (key, id) =>
					checkKey(key).pipe(
						Effect.andThen(load),
						Effect.flatMap((tasks) => save(tasks.filter((t) => t.id !== id))),
						Effect.as({ ok: true }),
					),
			};
		}),
	);
}
