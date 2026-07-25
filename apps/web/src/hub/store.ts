/**
 * Hub state. Deliberately in-memory: rigs re-register on reconnect, so a
 * Railway redeploy costs nothing and there is no database to run. Tasks are
 * NOT hub state — the rig advertises them (rev-echo) and re-advertises after
 * any hub restart.
 */
import type {
	AttemptState,
	RecordStatus,
	RunInfo,
	TaskInfo,
} from "#/api/contract";

export interface RigFrame {
	data: Uint8Array;
	at: number;
}

export interface RigCommand {
	verb: string;
	/** hub-allowlisted caller args, relayed to the rig's typed API */
	args?: Record<string, unknown>;
	/** opaque to the hub — only the rig can validate it */
	ownerKey?: string;
	/** lease holder at queue time — stamped as `operator` for attempt verbs */
	holder: string | null;
	queuedAt: number;
}

export interface RigCommandResult {
	verb: string;
	ok: boolean;
	error: string | null;
	at: number;
}

export interface Rig {
	name: string;
	backend: string;
	armState: string;
	source: string | null;
	joints: Record<string, number>;
	cams: ReadonlyArray<string>;
	/** surfaced to the operator: a dead teleop loop must not be silent */
	lastError: string | null;
	/** confirmed camera mapping + live brightness (owner camera-setup panel) */
	camMapping: { workspace: number | null; wrist: number | null } | null;
	camBrightness: Record<string, number>;
	/** live record-session status, straight from the rig's telemetry */
	record: RecordStatus | null;
	/** live attempt (task try) status */
	attempt: AttemptState | null;
	/** outcome of the last relayed verb — wrong owner key must not be silent */
	lastCommandResult: RigCommandResult | null;
	lastSeen: number;
	frames: Map<string, RigFrame>;
	/** advertised by the rig on rev mismatch; survives every telemetry tick */
	tasks: ReadonlyArray<TaskInfo>;
	tasksRev: string | null;
	/** the rig's training-run sidecar (colabCell stripped), same rev-echo */
	runs: ReadonlyArray<RunInfo>;
	runsRev: string | null;
	/** latest-wins: a dropped input packet is corrected by the next one.
	 * axes = browser EE jog; joints = a remote leader arm's joint targets. */
	input: {
		axes?: Record<string, number>;
		joints?: Record<string, number>;
		at: number;
	} | null;
	pending: RigCommand[];
	lease: { holder: string; expiresAt: number } | null;
	/** round-trip of the rig's own link loop, measured hub-side */
	linkMs: number;
}

const RIG_TTL_MS = 5_000; // no heartbeat for this long -> offline
const LEASE_MS = 20_000; // renewed on every input; released on expiry
/** A command not picked up this fast is stale — executing a minutes-old
 * teleop_start on link resume is exactly the hazard class this codebase
 * documents elsewhere. Also bounds how long an ownerKey sits in hub memory. */
const COMMAND_TTL_MS = 15_000;
export const MAX_PENDING = 32;

/** Injected impairment so loopback dev matches production behaviour. */
export const impairment = {
	latencyMs: Number(process.env.HUB_LATENCY_MS ?? 0),
	dropRate: Number(process.env.HUB_DROP_RATE ?? 0),
};

const store = globalThis as unknown as {
	__labHubRigs?: Map<string, Rig>;
};
store.__labHubRigs ??= new Map<string, Rig>();
const rigs = store.__labHubRigs;

export const sleep = (ms: number): Promise<void> =>
	new Promise((r) => setTimeout(r, ms));

/** Applied to every hub hop so latency is symmetric with production. */
export const impair = async (): Promise<void> => {
	if (impairment.latencyMs > 0) await sleep(impairment.latencyMs);
};

export const shouldDrop = (): boolean =>
	impairment.dropRate > 0 && Math.random() < impairment.dropRate;

export const upsertRig = (
	name: string,
	patch: Omit<
		Rig,
		| "name"
		| "frames"
		| "input"
		| "pending"
		| "lease"
		| "lastSeen"
		| "tasks"
		| "tasksRev"
		| "runs"
		| "runsRev"
	>,
): Rig => {
	const existing = rigs.get(name);
	if (existing) {
		// tasks/tasksRev persist like frames/lease — the telemetry patch must
		// not wipe them every 50ms tick (they only change on rev mismatch).
		Object.assign(existing, patch, { lastSeen: Date.now() });
		return existing;
	}
	const rig: Rig = {
		name,
		...patch,
		lastSeen: Date.now(),
		frames: new Map(),
		input: null,
		pending: [],
		lease: null,
		tasks: [],
		tasksRev: null,
		runs: [],
		runsRev: null,
	};
	rigs.set(name, rig);
	return rig;
};

/** Drain the queue, dropping anything older than the TTL. */
export const drainCommands = (rig: Rig): RigCommand[] => {
	const all = rig.pending.splice(0, rig.pending.length);
	const now = Date.now();
	const fresh = all.filter((c) => now - c.queuedAt < COMMAND_TTL_MS);
	if (fresh.length < all.length)
		console.error(
			`[hub] dropped ${all.length - fresh.length} stale command(s) for ${rig.name}`,
		);
	return fresh;
};

export const getRig = (name: string): Rig | undefined => rigs.get(name);

export const isOnline = (rig: Rig): boolean =>
	Date.now() - rig.lastSeen < RIG_TTL_MS;

export const listRigs = (): ReadonlyArray<Rig> => [...rigs.values()];

export const leaseHolder = (rig: Rig): string | null => {
	if (rig.lease && rig.lease.expiresAt > Date.now()) return rig.lease.holder;
	rig.lease = null;
	return null;
};

/** First-come-first-served; the holder keeps it by continuing to send input.
 * `force` steals the seat — friends-only hub, a stuck holder must not brick
 * the rig. The kicked client finds out on its next input (403). */
export const claimLease = (
	rig: Rig,
	holder: string,
	force = false,
): boolean => {
	const current = leaseHolder(rig);
	if (!force && current !== null && current !== holder) return false;
	rig.lease = { holder, expiresAt: Date.now() + LEASE_MS };
	return true;
};

export const releaseLease = (rig: Rig, holder: string): void => {
	if (leaseHolder(rig) === holder) rig.lease = null;
};

export const setFrame = (rig: Rig, cam: string, data: Uint8Array): void => {
	rig.frames.set(cam, { data, at: Date.now() });
};

// --- leaders ---------------------------------------------------------------
// Operator-side leader arms, registered by controller.py exactly like rigs
// register themselves: dial-out heartbeat, in-memory, re-registers after a
// redeploy. The browser commands a leader ("drive rig X") through the same
// consume-once pending-slot pattern as rig commands.

export interface LeaderCommand {
	action: "drive" | "stop";
	rig?: string;
	queuedAt: number;
}

export interface Leader {
	name: string;
	/** rig name while streaming, null while idle — reported by the agent */
	driving: string | null;
	/** A leader is NOT a lease holder: it is a bound INPUT DEVICE of one
	 * browser session. `boundTo` is that browser's clientId, `rig` the rig it
	 * drives for. Set/cleared by the command endpoints only — a heartbeat must
	 * never wipe them. The browser keeps the lease throughout, so attempts and
	 * take-over semantics are unchanged by a leader joining. */
	boundTo: string | null;
	rig: string | null;
	pending: LeaderCommand | null;
	lastSeen: number;
}

const leaderStore = globalThis as unknown as {
	__labHubLeaders?: Map<string, Leader>;
};
leaderStore.__labHubLeaders ??= new Map<string, Leader>();
const leaders = leaderStore.__labHubLeaders;

export const upsertLeader = (name: string, driving: string | null): Leader => {
	const existing = leaders.get(name);
	if (existing) {
		existing.driving = driving;
		existing.lastSeen = Date.now();
		return existing;
	}
	const leader: Leader = {
		name,
		driving,
		boundTo: null,
		rig: null,
		pending: null,
		lastSeen: Date.now(),
	};
	leaders.set(name, leader);
	return leader;
};

export const getLeader = (name: string): Leader | undefined =>
	leaders.get(name);

export const listLeaders = (): ReadonlyArray<Leader> => [...leaders.values()];

export const leaderOnline = (leader: Leader): boolean =>
	Date.now() - leader.lastSeen < RIG_TTL_MS;

/**
 * THE leader input rule, in one place: a leader may write input to a rig iff
 * it is bound to whoever currently holds that rig's lease. The HTTP input
 * path, the WS input plane and the heartbeat's `bound` flag all use this.
 *
 * Note what is NOT here: no lease renewal. The browser's own claim interval
 * keeps the lease alive; if the browser dies the lease expires in <=20s and
 * the leader's input starts failing — that is the intended kill switch.
 */
export const leaderMayDrive = (leader: Leader, rig: Rig): boolean =>
	leader.rig === rig.name &&
	leader.boundTo !== null &&
	leader.boundTo === leaseHolder(rig);

/**
 * The heartbeat's answer to "may I keep streaming?". It must be asked about
 * the rig the AGENT says it is driving, not the one the hub has bound: if a
 * second browser rebinds this leader elsewhere, the agent's packets to the old
 * rig are rejected — silently, on the socket plane, which has no per-packet
 * status — while `leader.rig` happily reports the new binding. Answering for
 * the wrong rig left the agent streaming into a black hole forever.
 * Idle (`driving === null`) falls back to the binding itself.
 */
export const leaderBound = (
	leader: Leader,
	driving?: string | null,
): boolean => {
	const name = driving ?? leader.rig;
	if (name === null || leader.boundTo === null) return false;
	const rig = rigs.get(name);
	return rig !== undefined && leaderMayDrive(leader, rig);
};

/** Drop a binding that can no longer authorize input (the lease moved on).
 * Without this the stale `boundTo` outlives a take-over and can be revived by
 * the same browser tab simply re-claiming — clientId lives in sessionStorage. */
export const pruneLeaderBinding = (leader: Leader): void => {
	if (leader.boundTo === null || leaderBound(leader)) return;
	leader.boundTo = null;
	leader.rig = null;
};

/** Consume-once with the same staleness rule as rig commands. */
export const takeLeaderCommand = (leader: Leader): LeaderCommand | null => {
	const cmd = leader.pending;
	leader.pending = null;
	if (cmd === null) return null;
	if (Date.now() - cmd.queuedAt >= COMMAND_TTL_MS) {
		console.error(`[hub] dropped stale leader command for ${leader.name}`);
		return null;
	}
	return cmd;
};
