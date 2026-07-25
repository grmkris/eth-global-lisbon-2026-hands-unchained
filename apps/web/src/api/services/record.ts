import { Context, Effect, Layer } from "effect";
import { DriverError, PreflightError, RecordStatus } from "#/api/contract";
import { RIG } from "#/api/rig";
import { Cameras } from "./cameras";
import { DatasetCatalog } from "./dataset-catalog";
import { DriverManager } from "./driver-manager";

export interface RecordStartInput {
	readonly repoName: string;
	readonly task: string;
	readonly numEpisodes: number;
	readonly episodeS: number;
	readonly resetS: number;
	readonly resume: boolean;
	readonly source: string | null;
}

export interface RecordShape {
	readonly status: () => Effect.Effect<RecordStatus>;
	readonly start: (
		input: RecordStartInput,
	) => Effect.Effect<RecordStatus, DriverError | PreflightError>;
	readonly control: (
		action: string,
	) => Effect.Effect<RecordStatus, DriverError>;
}

export class Recorder extends Context.Service<Recorder, RecordShape>()(
	"app/Record",
) {
	static readonly layer = Layer.effect(
		Recorder,
		Effect.gen(function* () {
			const driver = yield* DriverManager;
			const cameras = yield* Cameras;
			const catalog = yield* DatasetCatalog;

			const status = () =>
				Effect.map(driver.record(), (r) => new RecordStatus(r));
			const toDriverError = (e: Error) =>
				new DriverError({ message: e.message });

			return {
				status,
				start: (input) =>
					Effect.gen(function* () {
						const [robot, camStatus] = yield* Effect.all([
							driver.robot(),
							cameras.status(),
						]).pipe(Effect.mapError(toDriverError));
						const mapping = camStatus.mapping;
						const repoId = `${RIG.hfUser}/${input.repoName}`;

						if (robot.state === "disconnected") {
							return yield* new PreflightError({
								message:
									"arm not connected — connect on the Robot page first (real or SIM)",
								gates: ["robot"],
							});
						}
						if (
							robot.backend === "real" &&
							(mapping.workspace === null || mapping.wrist === null)
						) {
							return yield* new PreflightError({
								message:
									"cameras not confirmed — identify workspace/wrist on the Robot page first",
								gates: ["cameras"],
							});
						}

						yield* driver
							.rpc("record_start", {
								repo_id: repoId,
								task: input.task,
								num_episodes: input.numEpisodes,
								episode_time_s: input.episodeS,
								reset_time_s: input.resetS,
								fps: 30,
								resume: input.resume,
								source: input.source,
								cameras:
									robot.backend === "real"
										? {
												workspace_cam: {
													index: mapping.workspace,
													width: 640,
													height: 480,
													fps: 30,
												},
												wrist_cam: {
													index: mapping.wrist,
													width: 640,
													height: 480,
													fps: 30,
												},
											}
										: {},
							})
							.pipe(Effect.mapError(toDriverError));

						if (robot.backend === "sim") {
							yield* catalog.tagSim(repoId);
						}
						return yield* status();
					}),
				control: (action) =>
					driver
						.rpc("record_control", { action })
						.pipe(Effect.mapError(toDriverError), Effect.andThen(status())),
			};
		}),
	);
}
