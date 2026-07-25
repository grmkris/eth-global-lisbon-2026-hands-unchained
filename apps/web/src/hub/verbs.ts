/**
 * The complete verb surface a remote operator can trigger on a rig — ONE
 * table, everything derives from it: the hub's allowlist and safety carve-out
 * (routes.ts) and the rig's verb → local-API dispatch (rig/link.ts). Adding a
 * verb is adding a row.
 *
 * `safety: true` verbs bypass the lease — anyone watching a rig misbehave
 * must be able to stop it, holder or not.
 */
export const VERBS = {
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
} as const satisfies Record<
	string,
	{ path: string; body?: unknown; safety?: boolean }
>;

export type Verb = keyof typeof VERBS;

export const isVerb = (v: string): v is Verb => v in VERBS;
