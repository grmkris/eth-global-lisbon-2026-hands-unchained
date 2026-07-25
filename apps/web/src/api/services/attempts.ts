/**
 * Attempts — one operator try at a rig task = one recorded episode.
 *
 * The attempt itself is a thin shell over the Recorder: attempt_start starts
 * a 1-episode record session with the task's parameters (the lerobot task
 * string = task title, so the label rides natively in the dataset); Success
 * keeps the episode, Discard clears the buffer (never destructive to saved
 * data). Live phase/saved counts stay derived from the driver's record_state
 * — only the outcome row is persisted (.data/attempts.json, append-only).
 *
 * The current attempt is deliberately in-memory: if the rig restarts, the
 * record session died with the driver, so boot = no attempt, which is true.
 */
import * as crypto from "node:crypto";
import { Context, Effect, FileSystem, Layer } from "effect";
import {
	AttemptLogRow,
	AttemptState,
	DriverError,
	type PreflightError,
	type TaskInfo,
} from "#/api/contract";
import { RIG } from "#/api/rig";
import { getHolder } from "#/rig/holder";
import { DatasetCatalog } from "./dataset-catalog";
import { Recorder } from "./record";
import { RobotSvc } from "./robot";
import { TasksRegistry } from "./tasks-registry";

const DATA_DIR = `${process.cwd()}/.data`;
const LOG_FILE = `${DATA_DIR}/attempts.json`;
/** Operator gone (no lease holder) this long while recording -> abandon. */
const ABANDON_MS = 30_000;

interface Current {
	attemptId: string;
	task: TaskInfo; // snapshot — edits/deletes mid-attempt can't touch us
	operator: string;
	priorSource: string; // teleop source to restore after the attempt
	startedAt: string;
	startedAtMs: number;
	holderGoneSince: number | null;
}

/** The driver takes 1-2s (dataset create) before its first record_state
 * event — the cached status stays inactive that long. The watcher must not
 * mistake spin-up for session-end. */
const SPINUP_GRACE_MS = 8_000;

export interface AttemptsShape {
	readonly state: () => Effect.Effect<AttemptState>;
	readonly log: () => Effect.Effect<ReadonlyArray<AttemptLogRow>>;
	readonly start: (
		taskId: string,
		operator: string,
	) => Effect.Effect<AttemptState, DriverError | PreflightError>;
	readonly finish: (
		success: boolean,
	) => Effect.Effect<AttemptState, DriverError>;
}

export class Attempts extends Context.Service<Attempts, AttemptsShape>()(
	"app/Attempts",
) {
	static readonly layer = Layer.effect(
		Attempts,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const recorder = yield* Recorder;
			const robot = yield* RobotSvc;
			const tasks = yield* TasksRegistry;
			const catalog = yield* DatasetCatalog;

			let current: Current | null = null;

			const toState = (): AttemptState =>
				new AttemptState(
					current
						? {
								active: true,
								attemptId: current.attemptId,
								taskId: current.task.id,
								taskTitle: current.task.title,
								operator: current.operator,
								episodeSeconds: current.task.episodeSeconds,
								startedAt: current.startedAt,
							}
						: {
								active: false,
								attemptId: null,
								taskId: null,
								taskTitle: null,
								operator: null,
								episodeSeconds: null,
								startedAt: null,
							},
				);

			const loadLog = fs.readFileString(LOG_FILE).pipe(
				Effect.map((raw) =>
					(JSON.parse(raw) as Array<AttemptLogRow>).map(
						(r) => new AttemptLogRow(r),
					),
				),
				Effect.orElseSucceed(() => [] as Array<AttemptLogRow>),
			);

			const appendLog = (row: AttemptLogRow) =>
				loadLog.pipe(
					Effect.flatMap((rows) =>
						fs
							.makeDirectory(DATA_DIR, { recursive: true })
							.pipe(
								Effect.andThen(
									fs.writeFileString(
										LOG_FILE,
										JSON.stringify([...rows, row], null, 2),
									),
								),
								Effect.orDie,
							),
					),
				);

			const closeAttempt = (outcome: string) =>
				Effect.gen(function* () {
					const cur = current;
					if (!cur) return;
					current = null;
					yield* appendLog(
						new AttemptLogRow({
							id: cur.attemptId,
							taskId: cur.task.id,
							taskTitle: cur.task.title,
							repoId: `${RIG.hfUser}/${cur.task.repoName}`,
							operator: cur.operator,
							outcome,
							startedAt: cur.startedAt,
							endedAt: new Date().toISOString(),
						}),
					);
					console.error(
						`[attempts] ${cur.attemptId} ${outcome} (${cur.task.title} by ${cur.operator})`,
					);
					// Hand the arm back to the operator with their previous source —
					// except after a driver failure: a failing rig must not resume
					// motion unattended.
					if (outcome !== "failed") {
						yield* robot
							.command("teleop_start", { source: cur.priorSource })
							.pipe(Effect.ignore);
					}
				});

			// Watcher: while an attempt is live, poll the (cached, free) record
			// status once a second; react to terminal phases + operator loss.
			const tick = Effect.gen(function* () {
				const cur = current;
				if (!cur) return;
				const status = yield* recorder.status();
				if (!status.active) {
					if (status.phase === "failed") {
						yield* closeAttempt("failed");
						return;
					}
					// inactive during spin-up is not session-end
					if (Date.now() - cur.startedAtMs < SPINUP_GRACE_MS) return;
					// still idle after grace = the session never started at all
					yield* closeAttempt(status.phase === "idle" ? "failed" : "timeout");
					return;
				}
				const { holder } = getHolder();
				if (holder === null) {
					cur.holderGoneSince ??= Date.now();
					if (Date.now() - cur.holderGoneSince > ABANDON_MS) {
						console.error(
							"[attempts] operator gone 30s mid-recording — discarding partial episode",
						);
						yield* recorder.control("discard").pipe(Effect.ignore);
						yield* closeAttempt("abandoned");
					}
				} else {
					cur.holderGoneSince = null;
				}
			});
			// v4 beta: forkDetach = detached fiber outliving the layer scope
			yield* Effect.forkDetach(
				Effect.forever(tick.pipe(Effect.andThen(Effect.sleep("1 second")))),
			);

			return {
				state: () => Effect.sync(toState),
				log: () => loadLog,
				start: (taskId, operator) =>
					Effect.gen(function* () {
						if (current)
							return yield* Effect.fail(
								new DriverError({ message: "an attempt is already running" }),
							);
						const status = yield* recorder.status();
						if (status.active)
							return yield* Effect.fail(
								new DriverError({ message: "recording already active" }),
							);
						const all = yield* tasks.list();
						const task = all.find((t) => t.id === taskId && t.active);
						if (!task)
							return yield* Effect.fail(
								new DriverError({ message: `no active task ${taskId}` }),
							);

						const repoId = `${RIG.hfUser}/${task.repoName}`;
						const datasets = yield* catalog.list();
						const existing = datasets.find((d) => d.repoId === repoId);
						if (
							task.maxEpisodes !== null &&
							(existing?.totalEpisodes ?? 0) >= task.maxEpisodes
						)
							return yield* Effect.fail(
								new DriverError({
									message: `task complete — ${task.maxEpisodes} episodes collected`,
								}),
							);

						// Record with whatever source the operator is driving with now;
						// the driver swaps teleop -> record-source itself, seeded from
						// current joints, so their input stream never really pauses.
						const robotState = yield* robot.state();
						const priorSource = robotState.source ?? "keys";

						yield* recorder.start({
							repoName: task.repoName,
							task: task.title,
							numEpisodes: 1,
							episodeS: task.episodeSeconds,
							resetS: task.resetSeconds,
							resume: existing?.isLocal ?? false,
							source: priorSource,
						});
						current = {
							attemptId: crypto.randomUUID().slice(0, 8),
							task,
							operator,
							priorSource,
							startedAt: new Date().toISOString(),
							startedAtMs: Date.now(),
							holderGoneSince: null,
						};
						return toState();
					}),
				finish: (success) =>
					Effect.gen(function* () {
						const cur = current;
						if (!cur)
							return yield* Effect.fail(
								new DriverError({ message: "no attempt running" }),
							);
						const status = yield* recorder.status();
						if (status.active) {
							// keep saves + session (1 episode) ends; discard clears the
							// unsaved buffer and stops — nothing saved is ever touched.
							yield* recorder.control(success ? "keep" : "discard");
							yield* closeAttempt(success ? "success" : "discarded");
						} else {
							// timeout race: session already ended (auto-saved) — just
							// annotate the outcome.
							yield* closeAttempt(success ? "success" : "timeout");
						}
						return toState();
					}),
			};
		}),
	);
}
