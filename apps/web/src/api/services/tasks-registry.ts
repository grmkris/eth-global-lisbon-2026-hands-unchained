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
						Effect.flatMap((tasks) => {
							const cleaned = new TaskInfo({
								...task,
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
