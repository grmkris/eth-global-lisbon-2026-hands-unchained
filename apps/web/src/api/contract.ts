import { Schema } from "effect";
import {
	HttpApi,
	HttpApiEndpoint,
	HttpApiGroup,
} from "effect/unstable/httpapi";

export class HealthStatus extends Schema.Class<HealthStatus>("HealthStatus")(
	Schema.Struct({
		ok: Schema.Boolean,
		hfUser: Schema.String,
		version: Schema.String,
	}),
) {}

const HealthGroup = HttpApiGroup.make("Health").add(
	HttpApiEndpoint.get("status", "/health", { success: HealthStatus }),
);

export class DatasetInfo extends Schema.Class<DatasetInfo>("DatasetInfo")(
	Schema.Struct({
		repoId: Schema.String,
		isLocal: Schema.Boolean,
		onHub: Schema.Boolean,
		totalEpisodes: Schema.NullOr(Schema.Number),
		totalFrames: Schema.NullOr(Schema.Number),
		fps: Schema.NullOr(Schema.Number),
		cameras: Schema.Array(Schema.String),
		codebaseVersion: Schema.NullOr(Schema.String),
		hubLastModified: Schema.NullOr(Schema.String),
		sim: Schema.Boolean,
	}),
) {}

export class EpisodeInfo extends Schema.Class<EpisodeInfo>("EpisodeInfo")(
	Schema.Struct({
		index: Schema.Number,
		frames: Schema.Number,
		seconds: Schema.Number,
		task: Schema.String,
		flag: Schema.NullOr(Schema.String), // short | long (length outlier vs median)
	}),
) {}

export class DatasetEpisodes extends Schema.Class<DatasetEpisodes>(
	"DatasetEpisodes",
)(
	Schema.Struct({
		repoId: Schema.String,
		local: Schema.Boolean, // false -> not in the local cache, no episode meta
		fps: Schema.NullOr(Schema.Number),
		medianFrames: Schema.NullOr(Schema.Number),
		episodes: Schema.Array(EpisodeInfo),
	}),
) {}

/** Driver/hardware failure surfaced with its actionable message (port busy hints etc).
 * Declared here, above the first group that references it: the groups are built
 * at module init, so a later class declaration would be a TDZ error. */
export class DriverError extends Schema.TaggedErrorClass<DriverError>()(
	"DriverError",
	{
		message: Schema.String,
	},
) {}

/** Publish-to-Hub progress. The dataset and the HF token live on the RIG, so
 * this is rig state relayed through telemetry — the hub holds no credentials. */
export class PushStatus extends Schema.Class<PushStatus>("PushStatus")(
	Schema.Struct({
		phase: Schema.Literals(["idle", "uploading", "done", "failed"]),
		repoId: Schema.NullOr(Schema.String),
		url: Schema.NullOr(Schema.String),
		error: Schema.NullOr(Schema.String),
	}),
) {}

const DatasetsGroup = HttpApiGroup.make("Datasets").add(
	HttpApiEndpoint.get("list", "/datasets", {
		success: Schema.Array(DatasetInfo),
	}),
	HttpApiEndpoint.get("episodes", "/datasets/episodes", {
		query: Schema.Struct({ repoId: Schema.String }),
		success: DatasetEpisodes,
	}),
	HttpApiEndpoint.get("pushStatus", "/datasets/push-status", {
		success: PushStatus,
	}),
	HttpApiEndpoint.post("push", "/datasets/push", {
		payload: Schema.Struct({
			/** name only — the rig prefixes its own HF user, exactly like tasks */
			repoName: Schema.String,
			private: Schema.optional(Schema.Boolean),
		}),
		success: PushStatus,
		error: DriverError,
	}),
);

export class RunConfig extends Schema.Class<RunConfig>("RunConfig")(
	Schema.Struct({
		datasetRepoId: Schema.String,
		episodes: Schema.NullOr(Schema.String),
		policyType: Schema.String,
		pretrainedPath: Schema.NullOr(Schema.String),
		steps: Schema.Number,
		batchSize: Schema.Number,
		saveFreq: Schema.Number,
	}),
) {}

export class RunInfo extends Schema.Class<RunInfo>("RunInfo")(
	Schema.Struct({
		id: Schema.String,
		name: Schema.String,
		status: Schema.String, // draft | launched | imported (derived states come later)
		hubModelId: Schema.String,
		createdAt: Schema.NullOr(Schema.String),
		hypothesis: Schema.NullOr(Schema.String),
		finding: Schema.NullOr(Schema.String),
		config: Schema.NullOr(RunConfig),
		colabCell: Schema.NullOr(Schema.String),
	}),
) {}

export class RunCreate extends Schema.Class<RunCreate>("RunCreate")(
	Schema.Struct({
		/** Caller-supplied id (hub UI deep-links before the advert lands);
		 * empty/absent -> server generates one. */
		id: Schema.optional(Schema.String),
		name: Schema.String,
		datasetRepoId: Schema.String,
		episodes: Schema.NullOr(Schema.String),
		pretrainedPath: Schema.NullOr(Schema.String),
		steps: Schema.Number,
		batchSize: Schema.Number,
		saveFreq: Schema.Number,
		hypothesis: Schema.NullOr(Schema.String),
	}),
) {}

export class RunPatch extends Schema.Class<RunPatch>("RunPatch")(
	Schema.Struct({
		status: Schema.NullOr(Schema.String),
		hypothesis: Schema.NullOr(Schema.String),
		finding: Schema.NullOr(Schema.String),
	}),
) {}

export class Checkpoints extends Schema.Class<Checkpoints>("Checkpoints")(
	Schema.Struct({
		hubModelId: Schema.String,
		steps: Schema.Array(Schema.String),
	}),
) {}

/** Setup problem the user can fix (not a hardware fault) — lists the failed gates. */
export class PreflightError extends Schema.TaggedErrorClass<PreflightError>()(
	"PreflightError",
	{
		message: Schema.String,
		gates: Schema.Array(Schema.String),
	},
) {}

export class ProbedCamera extends Schema.Class<ProbedCamera>("ProbedCamera")(
	Schema.Struct({
		index: Schema.Number,
		width: Schema.Number,
		height: Schema.Number,
	}),
) {}

export class CameraMapping extends Schema.Class<CameraMapping>("CameraMapping")(
	Schema.Struct({
		workspace: Schema.NullOr(Schema.Number),
		wrist: Schema.NullOr(Schema.Number),
	}),
) {}

export class CameraStatus extends Schema.Class<CameraStatus>("CameraStatus")(
	Schema.Struct({
		previewing: Schema.Array(Schema.String),
		brightness: Schema.Record(Schema.String, Schema.Number),
		mapping: CameraMapping,
		brightnessBand: Schema.Struct({ min: Schema.Number, max: Schema.Number }),
		/** indexes the owner turned off — never opened, never advertised. The
		 * only record they exist: a disabled camera is not in `previewing`. */
		disabled: Schema.Array(Schema.Number),
	}),
) {}

const CamerasGroup = HttpApiGroup.make("Cameras").add(
	HttpApiEndpoint.get("probe", "/cameras/probe", {
		success: Schema.Array(ProbedCamera),
	}),
	HttpApiEndpoint.post("previewStart", "/cameras/preview/start", {
		payload: Schema.Struct({ indexes: Schema.Array(Schema.Number) }),
		success: Schema.Struct({ started: Schema.Array(Schema.String) }),
	}),
	HttpApiEndpoint.post("previewStop", "/cameras/preview/stop", {
		success: Schema.Struct({ stopped: Schema.Boolean }),
	}),
	// One-shot for the hub verb pipe: probe all cameras, preview everything
	// found. Results need no response channel — preview streams appear in the
	// rig's `cams` telemetry (names encode indexes: cam0, cam1, ...).
	HttpApiEndpoint.post("probePreview", "/cameras/probe-preview", {
		success: Schema.Struct({ started: Schema.Array(Schema.String) }),
		error: DriverError,
	}),
	HttpApiEndpoint.get("status", "/cameras/status", { success: CameraStatus }),
	HttpApiEndpoint.post("confirm", "/cameras/confirm", {
		payload: CameraMapping,
		success: CameraMapping,
	}),
	// Turn a camera off for good (the phantom black slot every macOS rig has,
	// a spare angle nobody wants). Closes the device — no capture thread, no
	// uplink, gone from `cams` for every viewer, not just hidden in one browser.
	HttpApiEndpoint.post("disable", "/cameras/disable", {
		payload: Schema.Struct({
			index: Schema.Number,
			disabled: Schema.Boolean,
		}),
		success: Schema.Array(Schema.Number),
		error: DriverError,
	}),
);

export class RobotState extends Schema.Class<RobotState>("RobotState")(
	Schema.Struct({
		state: Schema.String, // disconnected | connected | teleop | recording
		backend: Schema.String, // real | sim
		source: Schema.NullOr(Schema.String), // leader | scripted | keys | phone (while teleop)
		leader: Schema.Boolean,
		/** Last driver-side failure (e.g. the teleop loop dying). Without this a
		 * remote operator just sees the arm stop and has no idea why. */
		lastError: Schema.NullOr(Schema.String),
		joints: Schema.Record(Schema.String, Schema.Number),
		rig: Schema.Struct({
			followerPort: Schema.NullOr(Schema.String),
			leaderPort: Schema.NullOr(Schema.String),
			robotId: Schema.String,
		}),
	}),
) {}

const RobotGroup = HttpApiGroup.make("Robot").add(
	HttpApiEndpoint.get("state", "/robot/state", { success: RobotState }),
	HttpApiEndpoint.post("connect", "/robot/connect", {
		payload: Schema.Struct({
			withLeader: Schema.Boolean,
			backend: Schema.String,
		}),
		success: RobotState,
		error: DriverError,
	}),
	HttpApiEndpoint.post("disconnect", "/robot/disconnect", {
		success: RobotState,
		error: DriverError,
	}),
	HttpApiEndpoint.post("torque", "/robot/torque", {
		payload: Schema.Struct({ on: Schema.Boolean }),
		success: RobotState,
		error: DriverError,
	}),
	HttpApiEndpoint.post("teleopStart", "/robot/teleop/start", {
		payload: Schema.Struct({ source: Schema.NullOr(Schema.String) }),
		success: RobotState,
		error: DriverError,
	}),
	HttpApiEndpoint.post("teleopStop", "/robot/teleop/stop", {
		success: RobotState,
		error: DriverError,
	}),
	HttpApiEndpoint.post("teleopInput", "/robot/teleop/input", {
		// axes = EE jog (keys source); joints = full joint targets from a
		// remote leader arm (remote source). Exactly one is expected.
		payload: Schema.Struct({
			axes: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
			joints: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
		}),
		success: Schema.Struct({ ok: Schema.Boolean }),
		error: DriverError,
	}),
	HttpApiEndpoint.post("estop", "/robot/estop", {
		success: RobotState,
		error: DriverError,
	}),
);

const runId = { id: Schema.String };

const TrainingsGroup = HttpApiGroup.make("Trainings").add(
	HttpApiEndpoint.get("list", "/runs", { success: Schema.Array(RunInfo) }),
	HttpApiEndpoint.get("get", "/runs/:id", { params: runId, success: RunInfo }),
	HttpApiEndpoint.post("create", "/runs", {
		payload: RunCreate,
		success: RunInfo,
	}),
	HttpApiEndpoint.patch("update", "/runs/:id", {
		params: runId,
		payload: RunPatch,
		success: RunInfo,
	}),
	// POST variant for the hub verb pipe (verbs dispatch to static POST paths)
	HttpApiEndpoint.post("updateByPayload", "/runs/update", {
		payload: Schema.Struct({
			id: Schema.String,
			status: Schema.NullOr(Schema.String),
			hypothesis: Schema.NullOr(Schema.String),
			finding: Schema.NullOr(Schema.String),
		}),
		success: RunInfo,
	}),
	HttpApiEndpoint.get("checkpoints", "/runs/:id/checkpoints", {
		params: runId,
		success: Checkpoints,
	}),
);

export class RecordStatus extends Schema.Class<RecordStatus>("RecordStatus")(
	Schema.Struct({
		active: Schema.Boolean,
		phase: Schema.String, // idle | recording | resetting | done | failed
		episode: Schema.Number,
		saved: Schema.Number,
		total: Schema.Number,
		repoId: Schema.NullOr(Schema.String),
		source: Schema.NullOr(Schema.String), // leader | scripted | keys | phone
	}),
) {}

const RecordGroup = HttpApiGroup.make("Record").add(
	HttpApiEndpoint.get("status", "/record/status", { success: RecordStatus }),
	HttpApiEndpoint.post("start", "/record/start", {
		payload: Schema.Struct({
			repoName: Schema.String,
			task: Schema.String,
			numEpisodes: Schema.Number,
			episodeS: Schema.Number,
			resetS: Schema.Number,
			resume: Schema.Boolean,
			source: Schema.NullOr(Schema.String), // null -> backend default (leader/scripted)
		}),
		success: RecordStatus,
		error: Schema.Union([DriverError, PreflightError]),
	}),
	HttpApiEndpoint.post("control", "/record/control", {
		payload: Schema.Struct({ action: Schema.String }), // keep | rerecord | finish
		success: RecordStatus,
		error: DriverError,
	}),
);

/** Owner-key rejected (tasks are owner-managed; the key never leaves the rig). */
export class ForbiddenError extends Schema.TaggedErrorClass<ForbiddenError>()(
	"ForbiddenError",
	{
		message: Schema.String,
	},
) {}

/** A task the rig owner wants crowdsourced — each successful attempt becomes
 * one labeled training episode in `repoName`'s dataset. */
export class TaskInfo extends Schema.Class<TaskInfo>("TaskInfo")(
	Schema.Struct({
		id: Schema.String,
		title: Schema.String, // becomes the lerobot per-frame task label
		instructions: Schema.String,
		repoName: Schema.String, // name only — Recorder prefixes the HF user
		episodeSeconds: Schema.Number,
		resetSeconds: Schema.Number,
		maxEpisodes: Schema.NullOr(Schema.Number),
		active: Schema.Boolean,
		/** DERIVED, not stored: episodes already in the task's dataset
		 * (lerobot meta `total_episodes`; null = dataset not created yet).
		 * Filled by TasksRegistry.list() so the UI can show 13/20. */
		episodesDone: Schema.optional(Schema.NullOr(Schema.Number)),
	}),
) {}

/** Motion measured from the RECORDED EPISODE on disk — the follower's real
 * trajectory at 30fps, i.e. the same rows that train the model. Unlike input
 * counting it exists for every drive source (a leader arm included), and the
 * operator cannot inflate it. Null until an episode has been saved. */
export class EpisodeMotionInfo extends Schema.Class<EpisodeMotionInfo>(
	"EpisodeMotionInfo",
)(
	Schema.Struct({
		episodeIndex: Schema.Number,
		frames: Schema.Number,
		durationS: Schema.Number,
		jointPathDeg: Schema.Number,
		maxJointRangeDeg: Schema.Number,
		gripperCycles: Schema.Number,
		stillFraction: Schema.Number,
	}),
) {}

export class AttemptState extends Schema.Class<AttemptState>("AttemptState")(
	Schema.Struct({
		active: Schema.Boolean,
		attemptId: Schema.NullOr(Schema.String),
		taskId: Schema.NullOr(Schema.String),
		taskTitle: Schema.NullOr(Schema.String),
		operator: Schema.NullOr(Schema.String),
		episodeSeconds: Schema.NullOr(Schema.Number),
		startedAt: Schema.NullOr(Schema.String),
		/** survives the attempt going inactive so the hub can still read it */
		lastEpisode: Schema.optional(Schema.NullOr(EpisodeMotionInfo)),
	}),
) {}

export class AttemptLogRow extends Schema.Class<AttemptLogRow>("AttemptLogRow")(
	Schema.Struct({
		id: Schema.String,
		taskId: Schema.String,
		taskTitle: Schema.String,
		repoId: Schema.String,
		operator: Schema.String,
		outcome: Schema.String, // success | discarded | timeout | failed | abandoned
		startedAt: Schema.String,
		endedAt: Schema.String,
	}),
) {}

const TasksGroup = HttpApiGroup.make("Tasks").add(
	HttpApiEndpoint.get("list", "/tasks", { success: Schema.Array(TaskInfo) }),
	HttpApiEndpoint.post("upsert", "/tasks/upsert", {
		payload: Schema.Struct({ ownerKey: Schema.String, task: TaskInfo }),
		success: TaskInfo,
		error: ForbiddenError,
	}),
	HttpApiEndpoint.post("delete", "/tasks/delete", {
		payload: Schema.Struct({ ownerKey: Schema.String, id: Schema.String }),
		success: Schema.Struct({ ok: Schema.Boolean }),
		error: ForbiddenError,
	}),
);

const AttemptsGroup = HttpApiGroup.make("Attempts").add(
	HttpApiEndpoint.get("state", "/attempts/state", { success: AttemptState }),
	HttpApiEndpoint.get("log", "/attempts/log", {
		success: Schema.Array(AttemptLogRow),
	}),
	HttpApiEndpoint.post("start", "/attempts/start", {
		payload: Schema.Struct({
			taskId: Schema.String,
			operator: Schema.String, // stamped by the hub from the lease holder
		}),
		success: AttemptState,
		error: Schema.Union([DriverError, PreflightError]),
	}),
	HttpApiEndpoint.post("finish", "/attempts/finish", {
		payload: Schema.Struct({ success: Schema.Boolean }),
		success: AttemptState,
		error: DriverError,
	}),
);

export const LabApi = HttpApi.make("LabConsole")
	.add(HealthGroup)
	.add(DatasetsGroup)
	.add(TrainingsGroup)
	.add(CamerasGroup)
	.add(RobotGroup)
	.add(RecordGroup)
	.add(TasksGroup)
	.add(AttemptsGroup)
	.prefix("/api");
