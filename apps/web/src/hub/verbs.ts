/**
 * The complete verb surface a remote operator can trigger on a rig — ONE
 * table, everything derives from it: the hub's allowlist, lease/safety/owner
 * gating (routes.ts) and the rig's verb → local-API dispatch (rig/link.ts).
 * Adding a verb is adding a row.
 *
 * Row semantics:
 * - `body`   static payload merged into the local API call
 * - `args`   ALLOWLIST of keys the hub relays to the rig (anything else is
 *            rejected hub-side; real validation is the rig's typed API)
 * - `hubOnly` subset of `args` the CALLER may not supply — the hub fills them
 *            in itself from what only it knows. Sending one is a 403, so a
 *            client can never forge the value it carries.
 * - `safety` bypasses the lease — anyone watching a misbehaving rig can stop it
 * - `owner`  requires an ownerKey, relayed OPAQUELY (only the rig validates
 *            it) and bypasses the lease (the owner is not the driver)
 * - `stampsHolder` the hub injects the lease holder as `operator` — identity
 *            in attempt logs cannot be spoofed via args
 */
export interface VerbSpec {
	readonly path: string;
	readonly body?: Record<string, unknown>;
	readonly safety?: boolean;
	readonly owner?: boolean;
	readonly stampsHolder?: boolean;
	readonly args?: readonly string[];
	readonly hubOnly?: readonly string[];
}

const table = {
	// withLeader so a physical leader arm can drive either backend
	connect_sim: {
		path: "/api/robot/connect",
		body: { withLeader: true, backend: "sim" },
	},
	connect_real: {
		path: "/api/robot/connect",
		body: { withLeader: true, backend: "real" },
	},
	teleop_start: { path: "/api/robot/teleop/start", body: { source: "keys" } },
	teleop_start_leader: {
		path: "/api/robot/teleop/start",
		body: { source: "leader" },
	},
	// joint targets stream in from the operator's own leader arm (controller.py)
	teleop_start_remote: {
		path: "/api/robot/teleop/start",
		body: { source: "remote" },
	},
	teleop_stop: { path: "/api/robot/teleop/stop", safety: true },
	estop: { path: "/api/robot/estop", safety: true },
	// tasks (owner-managed, key validated rig-side)
	task_upsert: { path: "/api/tasks/upsert", owner: true, args: ["task"] },
	task_delete: { path: "/api/tasks/delete", owner: true, args: ["id"] },
	// publish a recorded dataset to the HF Hub. Owner-only, and the RIG supplies
	// its own HF namespace + token — the hub relays intent, never credentials.
	dataset_push: {
		path: "/api/datasets/push",
		owner: true,
		// `excludeEpisodes` is relayed but never accepted from a caller: the hub
		// derives it from the referee's verdicts, so the owner cannot publish
		// failed work by hand-editing a request.
		args: ["repoName", "private", "excludeEpisodes"],
		hubOnly: ["excludeEpisodes"],
	},
	// attempts (lease-holder; operator identity stamped by the hub)
	attempt_start: {
		path: "/api/attempts/start",
		// same rule as dataset_push: the hub owns `rejectedEpisodes`, because it
		// owns the verdicts. A caller supplying it could mint unlimited attempts.
		args: ["taskId", "rejectedEpisodes"],
		hubOnly: ["rejectedEpisodes"],
		stampsHolder: true,
	},
	attempt_finish: { path: "/api/attempts/finish", args: ["success"] },
	// camera setup (owner — opens/closes device handles)
	camera_probe: { path: "/api/cameras/probe-preview", owner: true },
	camera_confirm: {
		path: "/api/cameras/confirm",
		owner: true,
		args: ["workspace", "wrist"],
	},
	// switch a camera off for good (phantom black slot, spare angle) — the rig
	// closes the device, so it leaves `cams` for everyone, not just one browser
	camera_disable: {
		path: "/api/cameras/disable",
		owner: true,
		args: ["index", "disabled"],
	},
	// training-run registry (rig-side sidecar, same pattern as tasks)
	run_create: {
		path: "/api/runs",
		owner: true,
		args: [
			"id",
			"name",
			"datasetRepoId",
			"episodes",
			"pretrainedPath",
			"steps",
			"batchSize",
			"saveFreq",
			"hypothesis",
		],
	},
	run_update: {
		path: "/api/runs/update",
		owner: true,
		args: ["id", "status", "hypothesis", "finding"],
	},
} as const satisfies Record<string, VerbSpec>;

export type Verb = keyof typeof table;

/** Widened view so `VERBS[verb].safety` etc typecheck on the union. */
export const VERBS: Record<Verb, VerbSpec> = table;

export const isVerb = (v: string): v is Verb => v in table;
