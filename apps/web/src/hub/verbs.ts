/**
 * The complete verb surface a remote operator can trigger on a rig — ONE
 * table, everything derives from it: the hub's allowlist, lease/safety/owner
 * gating (routes.ts) and the rig's verb → local-API dispatch (rig/link.ts).
 * Adding a verb is adding a row.
 *
 * Row semantics:
 * - `body`   static payload merged into the local API call
 * - `args`   ALLOWLIST of caller-supplied keys the hub relays (anything else
 *            is rejected hub-side; real validation is the rig's typed API)
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
	disconnect: { path: "/api/robot/disconnect" },
	// tasks (owner-managed, key validated rig-side)
	task_upsert: { path: "/api/tasks/upsert", owner: true, args: ["task"] },
	task_delete: { path: "/api/tasks/delete", owner: true, args: ["id"] },
	// attempts (lease-holder; operator identity stamped by the hub)
	attempt_start: {
		path: "/api/attempts/start",
		args: ["taskId"],
		stampsHolder: true,
	},
	attempt_finish: { path: "/api/attempts/finish", args: ["success"] },
} as const satisfies Record<string, VerbSpec>;

export type Verb = keyof typeof table;

/** Widened view so `VERBS[verb].safety` etc typecheck on the union. */
export const VERBS: Record<Verb, VerbSpec> = table;

export const isVerb = (v: string): v is Verb => v in table;
