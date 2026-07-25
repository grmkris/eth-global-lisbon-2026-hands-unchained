import { Context, Effect, FileSystem, Layer } from "effect";
import { CameraMapping, CameraStatus, ProbedCamera } from "#/api/contract";
import { RIG } from "#/api/rig";
import { DriverManager } from "./driver-manager";

const RIG_FILE = `${process.cwd()}/.data/rig.json`;

export interface CamerasShape {
	readonly probe: () => Effect.Effect<ReadonlyArray<ProbedCamera>, Error>;
	readonly previewStart: (
		indexes: ReadonlyArray<number>,
	) => Effect.Effect<{ started: ReadonlyArray<string> }, Error>;
	readonly previewStop: () => Effect.Effect<{ stopped: boolean }, Error>;
	readonly status: () => Effect.Effect<CameraStatus>;
	readonly confirm: (mapping: CameraMapping) => Effect.Effect<CameraMapping>;
}

export class Cameras extends Context.Service<Cameras, CamerasShape>()(
	"app/Cameras",
) {
	static readonly layer = Layer.effect(
		Cameras,
		Effect.gen(function* () {
			const driver = yield* DriverManager;
			const fs = yield* FileSystem.FileSystem;

			const loadMapping = fs.readFileString(RIG_FILE).pipe(
				Effect.map((raw) => {
					const rig = JSON.parse(raw) as {
						cameras?: { workspace?: number; wrist?: number };
					};
					return new CameraMapping({
						workspace: rig.cameras?.workspace ?? null,
						wrist: rig.cameras?.wrist ?? null,
					});
				}),
				Effect.orElseSucceed(
					() => new CameraMapping({ workspace: null, wrist: null }),
				),
			);

			return {
				probe: () =>
					driver
						.rpc<
							ReadonlyArray<{ index: number; width: number; height: number }>
						>("list_cameras")
						.pipe(Effect.map((cams) => cams.map((c) => new ProbedCamera(c)))),
				previewStart: (indexes) =>
					driver.rpc<{ started: ReadonlyArray<string> }>("preview_start", {
						cameras: indexes.map((index) => ({
							name: `cam${index}`,
							index,
							width: 640,
							height: 480,
							fps: 30,
						})),
					}),
				previewStop: () => driver.rpc<{ stopped: boolean }>("preview_stop"),
				status: () =>
					Effect.gen(function* () {
						// live streams come straight from the driver's status event — no TS-side
						// bookkeeping, so a driver crash can never leave stale "previewing" state
						const [brightness, streams, mapping] = yield* Effect.all([
							driver.brightness(),
							driver.streams(),
							loadMapping,
						]);
						return new CameraStatus({
							previewing: streams,
							brightness,
							mapping,
							brightnessBand: RIG.brightnessBand,
						});
					}),
				confirm: (mapping) =>
					Effect.gen(function* () {
						const raw = yield* fs
							.readFileString(RIG_FILE)
							.pipe(Effect.orElseSucceed(() => "{}"));
						const rig = JSON.parse(raw) as Record<string, unknown>;
						rig.cameras = {
							workspace: mapping.workspace,
							wrist: mapping.wrist,
						};
						yield* fs
							.makeDirectory(`${process.cwd()}/.data`, { recursive: true })
							.pipe(
								Effect.andThen(
									fs.writeFileString(RIG_FILE, JSON.stringify(rig, null, 2)),
								),
								Effect.orDie,
							);
						return mapping;
					}),
			};
		}),
	);
}
