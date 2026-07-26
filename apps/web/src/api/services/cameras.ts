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
	/** One-shot for the hub verb pipe: probe, then preview everything found. */
	readonly probeAndPreview: () => Effect.Effect<
		{ started: ReadonlyArray<string> },
		Error
	>;
	readonly status: () => Effect.Effect<CameraStatus>;
	readonly confirm: (mapping: CameraMapping) => Effect.Effect<CameraMapping>;
	/** Owner switch: close a camera for good, or bring a closed one back. */
	readonly setDisabled: (
		index: number,
		disabled: boolean,
	) => Effect.Effect<ReadonlyArray<number>, Error>;
}

export class Cameras extends Context.Service<Cameras, CamerasShape>()(
	"app/Cameras",
) {
	static readonly layer = Layer.effect(
		Cameras,
		Effect.gen(function* () {
			const driver = yield* DriverManager;
			const fs = yield* FileSystem.FileSystem;

			/** The one place `.data/rig.json` is read — mapping and the disabled
			 * set live side by side, and both survive an agent restart. */
			const loadRigFile = fs.readFileString(RIG_FILE).pipe(
				Effect.map(
					(raw) =>
						JSON.parse(raw) as {
							cameras?: { workspace?: number; wrist?: number };
							disabledCameras?: ReadonlyArray<number>;
						},
				),
				Effect.orElseSucceed(() => ({}) as Record<string, never>),
			);
			const loadMapping = loadRigFile.pipe(
				Effect.map(
					(rig) =>
						new CameraMapping({
							workspace: rig.cameras?.workspace ?? null,
							wrist: rig.cameras?.wrist ?? null,
						}),
				),
			);
			const loadDisabled = loadRigFile.pipe(
				Effect.map((rig) => rig.disabledCameras ?? []),
			);
			/** Read-modify-write, so mapping and disabled never clobber each other. */
			const patchRigFile = (patch: Record<string, unknown>) =>
				fs.readFileString(RIG_FILE).pipe(
					Effect.orElseSucceed(() => "{}"),
					Effect.map((raw) => JSON.parse(raw) as Record<string, unknown>),
					Effect.flatMap((rig) =>
						fs
							.makeDirectory(`${process.cwd()}/.data`, { recursive: true })
							.pipe(
								Effect.andThen(
									fs.writeFileString(
										RIG_FILE,
										JSON.stringify({ ...rig, ...patch }, null, 2),
									),
								),
							),
					),
					Effect.orDie,
				);

			const probe = () =>
				driver
					.rpc<ReadonlyArray<{ index: number; width: number; height: number }>>(
						"list_cameras",
					)
					.pipe(Effect.map((cams) => cams.map((c) => new ProbedCamera(c))));
			/** The allowlist is enforced HERE and nowhere else: this is the only
			 * function that opens a device, and three paths reach it — the owner's
			 * probe button, setDisabled's restart, and the raw
			 * POST /cameras/preview/start endpoint with caller-supplied indexes.
			 * Filtering the callers would leave that third door open. */
			const allowed = (indexes: ReadonlyArray<number>) =>
				indexes.filter((i) => RIG.cams.includes(i));
			const previewStart = (indexes: ReadonlyArray<number>) =>
				Effect.gen(function* () {
					const wanted = allowed(indexes);
					// The one line the owner needs when asking "where did cam2 go".
					// previewStart runs on probe and on a hide toggle, never in a loop.
					if (wanted.length !== indexes.length)
						console.error(
							`[cameras] LAB_CAMS=${RIG.cams.join(",")} dropped ${indexes
								.filter((i) => !RIG.cams.includes(i))
								.map((i) => `cam${i}`)
								.join(", ")}`,
						);
					// Filtering can empty a non-empty request; preview_start with no
					// cameras is not the same thing as stopping, so say what we mean.
					if (wanted.length === 0) {
						yield* driver.rpc<{ stopped: boolean }>("preview_stop");
						return { started: [] as ReadonlyArray<string> };
					}
					return yield* driver.rpc<{ started: ReadonlyArray<string> }>(
						"preview_start",
						{
							cameras: wanted.map((index) => ({
								name: `cam${index}`,
								index,
								width: 640,
								height: 480,
								fps: 30,
							})),
						},
					);
				});

			return {
				probe,
				previewStart,
				previewStop: () => driver.rpc<{ stopped: boolean }>("preview_stop"),
				probeAndPreview: () =>
					Effect.gen(function* () {
						// probing tears down device handles — refuse mid-recording
						const rec = yield* driver.record();
						if (rec.active)
							return yield* Effect.fail(
								new Error("recording active — probe would steal the cameras"),
							);
						const cams = yield* probe();
						if (cams.length === 0)
							return yield* Effect.fail(new Error("no cameras found"));
						// a re-probe must not undo the owner's off switch
						const disabled = yield* loadDisabled;
						const wanted = cams
							.map((c) => c.index)
							.filter((i) => !disabled.includes(i));
						if (wanted.length === 0) {
							yield* driver.rpc<{ stopped: boolean }>("preview_stop");
							return { started: [] as ReadonlyArray<string> };
						}
						return yield* previewStart(wanted);
					}),
				status: () =>
					Effect.gen(function* () {
						// live streams come straight from the driver's status event — no TS-side
						// bookkeeping, so a driver crash can never leave stale "previewing" state
						const [brightness, streams, mapping, disabled] = yield* Effect.all([
							driver.brightness(),
							driver.streams(),
							loadMapping,
							loadDisabled,
						]);
						return new CameraStatus({
							previewing: streams,
							brightness,
							mapping,
							brightnessBand: RIG.brightnessBand,
							// Only advertise cameras the owner could actually bring back.
							// An out-of-allowlist index is not "hidden", it is ineligible —
							// listing it would render a `show` button that does nothing.
							// The PERSISTED disabled set is untouched, so widening LAB_CAMS
							// later still finds a camera the owner hid on purpose hidden.
							disabled: allowed(disabled),
						});
					}),
				confirm: (mapping) =>
					patchRigFile({
						cameras: { workspace: mapping.workspace, wrist: mapping.wrist },
					}).pipe(Effect.as(mapping)),
				setDisabled: (index, disabled) =>
					Effect.gen(function* () {
						// same reason probe refuses: this reopens device handles
						const rec = yield* driver.record();
						if (rec.active)
							return yield* Effect.fail(
								new Error("recording active — cannot change the cameras now"),
							);
						// A sim's cams are rendered, not opened — there is nothing to
						// switch off, and re-enabling an index here would open the HOST's
						// webcam (the same trap camera_probe carries on a sim rig).
						const robot = yield* driver.robot();
						if (robot.backend === "sim")
							return yield* Effect.fail(
								new Error("sim cameras are rendered — nothing to disable"),
							);
						// Un-hiding a camera outside the allowlist would clear the flag in
						// rig.json and still open nothing — say so instead of no-oping.
						if (!disabled && !RIG.cams.includes(index))
							return yield* Effect.fail(
								new Error(
									`cam${index} is outside LAB_CAMS=${RIG.cams.join(",")} — restart the agent with that index included to use it`,
								),
							);
						const mapping = yield* loadMapping;
						// A hidden camera the recorder still opens writes a dataset from a
						// feed nobody can see, and record.ts's preflight would happily pass.
						if (
							disabled &&
							(mapping.workspace === index || mapping.wrist === index)
						)
							return yield* Effect.fail(
								new Error(
									`cam${index} is assigned as ${mapping.workspace === index ? "workspace" : "wrist"} — reassign it first`,
								),
							);
						const before = yield* loadDisabled;
						const next = disabled
							? [...new Set([...before, index])].sort((a, b) => a - b)
							: before.filter((i) => i !== index);
						yield* patchRigFile({ disabledCameras: next });

						// Restart from what is live right now plus the index we just
						// un-hid — a full re-probe stops every stream for seconds, and
						// this is a toggle the owner watches happen.
						const streams = yield* driver.streams();
						const live = streams
							.map((name) => /^cam(\d+)$/.exec(name)?.[1])
							.filter((n): n is string => n !== undefined)
							.map((n) => Number.parseInt(n, 10));
						const wanted = [...new Set(disabled ? live : [...live, index])]
							.filter((i) => !next.includes(i))
							.sort((a, b) => a - b);
						if (wanted.length === 0)
							yield* driver.rpc<{ stopped: boolean }>("preview_stop");
						else yield* previewStart(wanted);
						return next;
					}),
			};
		}),
	);
}
