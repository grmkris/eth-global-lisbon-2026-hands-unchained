/**
 * Hub state. Deliberately in-memory: rigs re-register on reconnect, so a
 * Railway redeploy costs nothing and there is no database to run. Tasks are
 * NOT hub state — the rig advertises them (rev-echo) and re-advertises after
 * any hub restart.
 */
import type {
	AttemptState,
	PushStatus,
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

/** Last authorized remote-leader packet accepted by the hub for a rig. */
export interface LeaderInputDebug {
	leader: string;
	transport: "http" | "websocket";
	joints: Record<string, number>;
	at: number;
	packets: number;
	dropped: boolean;
}

export interface Rig {
	name: string;
	backend: string;
	armState: string;
	source: string | null;
	/** a leader arm is physically attached to the rig — the driver's answer, not
	 * a guess, so the UI can hide a leader button that would fail */
	leader: boolean;
	joints: Record<string, number>;
	cams: ReadonlyArray<string>;
	/** surfaced to the operator: a dead teleop loop must not be silent */
	lastError: string | null;
	/** confirmed camera mapping + live brightness (owner camera-setup panel) */
	camMapping: { workspace: number | null; wrist: number | null } | null;
	camBrightness: Record<string, number>;
	/** indexes the owner switched off — absent from `cams`, so the setup panel
	 * needs them spelled out to offer them back */
	camDisabled: ReadonlyArray<number>;
	/** live record-session status, straight from the rig's telemetry */
	record: RecordStatus | null;
	/** live attempt (task try) status */
	attempt: AttemptState | null;
	/** live dataset publish status — the owner watches an upload from the UI */
	push: PushStatus | null;
	/** outcome of the last relayed verb — wrong owner key must not be silent */
	lastCommandResult: RigCommandResult | null;
	lastSeen: number;
	frames: Map<string, RigFrame>;
	/** cam -> everyone currently blocked in `waitForFrame` for it. Lets an
	 * open MJPEG stream be woken by `setFrame` instead of polling for it. */
	frameWaiters: Map<string, Set<() => void>>;
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
		/** leader-side send stamp (its clock) — telemetry only, never gating */
		sentAt?: number;
	} | null;
	/** Browser-visible diagnostics for the currently bound remote leader. */
	leaderInputDebug: LeaderInputDebug | null;
	/** MONOTONIC input odometer. `input` above is a consume-once mailbox —
	 * the /link tick nulls it every ~50ms — so anything sampling it races the
	 * rig and mostly sees null. This only ever counts up, so an observer can
	 * read deltas and actually measure what the operator commanded. */
	inputOdo: {
		packets: number;
		/** sum of |commanded motion|: axis magnitudes, or leader joint travel */
		motion: number;
		/** gripper direction reversals (open->close->open = 2) */
		gripperFlips: number;
		gripperSign: -1 | 0 | 1;
		lastJoints: Record<string, number> | null;
	};
	pending: RigCommand[];
	lease: { holder: string; expiresAt: number } | null;
	/** Absolute wall-clock ceiling on the lease, written by the market layer
	 * when a booked slot is running. Load-bearing: `/input` calls claimLease on
	 * EVERY packet and never passes through the market interceptor, so a lease
	 * revoked at slot end is re-taken within ~50ms by a browser that is still
	 * driving. Clamping here makes expiry a property of the data structure
	 * rather than something a timer has to keep winning — the same move as the
	 * 500ms input freshness gate and the 15s command TTL. */
	leaseHardExpiry: number | null;
	/** round-trip of the rig's own link loop, measured hub-side */
	linkMs: number;
	/** how input reaches this rig's driver: its hub socket, or the mailbox */
	inputTransport: "websocket" | "http";
}

const RIG_TTL_MS = 5_000; // no heartbeat for this long -> offline
const LEASE_MS = 20_000; // renewed on every input; released on expiry
/** A command not picked up this fast is stale — executing a minutes-old
 * teleop_start on link resume is exactly the hazard class this codebase
 * documents elsewhere. Also bounds how long an ownerKey sits in hub memory. */
const COMMAND_TTL_MS = 15_000;
/** How long a frame outlives its camera leaving the rig's advertised list.
 * Long enough to ride out a blinked `cams` (see upsertRig), short enough that a
 * camera switched off stops being served and stops being picked as evidence. */
const FRAME_ORPHAN_MS = 3_000;
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
		| "frameWaiters"
		| "input"
		| "inputOdo"
		| "leaderInputDebug"
		| "pending"
		| "lease"
		| "leaseHardExpiry"
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
		// …but a frame for a camera the rig no longer advertises is garbage that
		// used to live for the life of the process: still answering /snap, still
		// ageing camAgeMs, still selectable as market evidence.
		//
		// Absent from `cams` is NOT enough on its own to delete: the rig zeroes
		// `previewing` whenever one local /api/cameras/status read fails and
		// before the first one resolves (rig/link.ts:439), so `cams` blinks
		// empty on any hiccup and on every agent start. Dropping the cache on a
		// blink would empty the market evidence frame if the blink landed at
		// attempt close. Require the camera to have actually stopped arriving.
		const orphanCutoff = Date.now() - FRAME_ORPHAN_MS;
		for (const [cam, frame] of existing.frames)
			if (!patch.cams.includes(cam) && frame.at < orphanCutoff)
				existing.frames.delete(cam);
		return existing;
	}
	const rig: Rig = {
		name,
		...patch,
		lastSeen: Date.now(),
		frames: new Map(),
		frameWaiters: new Map(),
		input: null,
		leaderInputDebug: null,
		inputOdo: {
			packets: 0,
			motion: 0,
			gripperFlips: 0,
			gripperSign: 0,
			lastJoints: null,
		},
		pending: [],
		lease: null,
		leaseHardExpiry: null,
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
	const cap = rig.leaseHardExpiry ?? Number.POSITIVE_INFINITY;
	const expiresAt = Math.min(Date.now() + LEASE_MS, cap);
	if (expiresAt <= Date.now()) return false; // the ceiling has passed
	rig.lease = { holder, expiresAt };
	return true;
};

/**
 * Drop the lease without knowing who holds it — what the market layer needs at
 * slot end, where the holder is whoever happens to be driving. `releaseLease`
 * cannot serve: it takes the holder string and is a no-op on a mismatch.
 */
export const revokeLease = (rig: Rig): void => {
	rig.lease = null;
};

export const releaseLease = (rig: Rig, holder: string): void => {
	if (leaseHolder(rig) === holder) rig.lease = null;
};

/** Record one authorized remote-leader packet without logging request bodies. */
export const noteLeaderInput = (
	rig: Rig,
	leader: string,
	transport: LeaderInputDebug["transport"],
	joints: Record<string, number>,
	dropped: boolean,
): void => {
	const previous = rig.leaderInputDebug;
	rig.leaderInputDebug = {
		leader,
		transport,
		joints: { ...joints },
		at: Date.now(),
		packets: previous?.leader === leader ? previous.packets + 1 : 1,
		dropped,
	};
};

export const clearLeaderInputDebug = (rig: Rig): void => {
	rig.leaderInputDebug = null;
};

/**
 * Hysteresis band, in degrees, for deciding a leader joint actually went
 * somewhere.
 *
 * A leader arm resting on the desk still reports a jittering position, and
 * `controller.py` streams it at 30 Hz regardless — so summing |pos - previous
 * packet| accumulated pure noise: twenty still seconds out-ran the referee's
 * "commandedMotion above ~10 is real work" bar and scored as an honest episode.
 *
 * A per-packet floor cannot fix that, because at 30 Hz slow DELIBERATE motion
 * is also sub-degree per packet — the two are indistinguishable one packet at a
 * time. What separates them is NET DISPLACEMENT: noise oscillates around a
 * point and returns, real motion goes somewhere and stays. So travel is
 * measured against a per-joint reference that only advances once the joint has
 * moved a full band away from it. Jitter bounded by the band never advances the
 * reference and contributes nothing, however long it goes on; a slow drift
 * crosses the band eventually and is counted in full.
 *
 * Any band is defeated by noise wider than itself, so this is set well above
 * the ~0.1° encoder resolution of the STS3215s these arms use. Widening it is
 * nearly free: batching loses almost nothing, because the full displacement is
 * credited whenever the reference finally moves — a 0.2°/packet drift measures
 * 99% of its true travel at 2°, it is just counted in fewer, larger steps.
 */
const LEADER_BAND_DEG = 2;

/**
 * Count one operator input packet on the rig's odometer. Called from BOTH
 * input write paths (the HTTP mailbox and the WS input plane) so evidence of
 * work does not depend on which transport the operator happened to get.
 *
 * A PACKET IS NOT WORK. `packets` used to increment unconditionally, which made
 * it a measure of how long a client had been connected rather than of anything
 * the operator did — and the referee reads it as evidence. Both transports
 * stream at a fixed rate whether or not the human moves, so only packets that
 * actually carry motion are counted now. The rate is still observable in the
 * live telemetry; this counter is the *evidence* channel and has to mean work.
 */
export const noteInputOdometer = (
	rig: Rig,
	input: { axes?: Record<string, number>; joints?: Record<string, number> },
): void => {
	const odo = rig.inputOdo;
	let moved = 0;
	if (input.axes) {
		const { gripper = 0, ...axes } = input.axes;
		for (const v of Object.values(axes)) moved += Math.abs(v);
		const sign = gripper > 0.2 ? 1 : gripper < -0.2 ? -1 : 0;
		if (sign !== 0) {
			moved += Math.abs(gripper);
			if (odo.gripperSign !== 0 && sign !== odo.gripperSign)
				odo.gripperFlips += 1;
			odo.gripperSign = sign;
		}
	} else if (input.joints) {
		// A leader arm streams absolute joint targets. `lastJoints` is the
		// REFERENCE the joint was last known to have really reached — not simply
		// the previous packet — so bounded jitter never advances it.
		if (odo.lastJoints === null) odo.lastJoints = { ...input.joints };
		else
			for (const [name, pos] of Object.entries(input.joints)) {
				const ref = odo.lastJoints[name];
				if (ref === undefined) {
					odo.lastJoints[name] = pos;
					continue;
				}
				const delta = Math.abs(pos - ref);
				if (delta < LEADER_BAND_DEG) continue; // still inside the noise band
				moved += delta / 10; // rough parity with axis units
				if (name.toLowerCase().includes("gripper") && delta >= 8) {
					const sign = pos > ref ? 1 : -1;
					if (odo.gripperSign !== 0 && sign !== odo.gripperSign)
						odo.gripperFlips += 1;
					odo.gripperSign = sign;
				}
				odo.lastJoints[name] = pos; // it went somewhere — move the reference
			}
	}
	if (moved > 0) {
		odo.motion += moved;
		odo.packets += 1;
	}
};

export const setFrame = (rig: Rig, cam: string, data: Uint8Array): void => {
	rig.frames.set(cam, { data, at: Date.now() });
	const waiters = rig.frameWaiters.get(cam);
	if (waiters === undefined) return;
	rig.frameWaiters.delete(cam); // wake once; each waiter re-registers if it loops
	for (const wake of waiters) wake();
};

/**
 * Block until this rig pushes a new frame for `cam`, or `timeoutMs` passes.
 *
 * Replaces a 50ms poll in the MJPEG responder, which cost every viewer ~25ms of
 * latency on average and woke the hub 20x/s per open stream. The timeout is a
 * keepalive, not a deadline: it exists so a caller whose client vanished mid-
 * wait (or whose rig went dark) gets control back to re-check its own state
 * rather than parking forever.
 */
export const waitForFrame = (
	rig: Rig,
	cam: string,
	timeoutMs: number,
): Promise<void> =>
	new Promise<void>((resolve) => {
		let settled = false;
		const done = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			// setFrame drops the whole set, so this is a no-op on the woken path —
			// it matters when we leave via the timeout instead.
			rig.frameWaiters.get(cam)?.delete(wake);
			resolve();
		};
		const wake = () => done();
		const timer = setTimeout(done, timeoutMs);
		let waiters = rig.frameWaiters.get(cam);
		if (waiters === undefined) {
			waiters = new Set();
			rig.frameWaiters.set(cam, waiters);
		}
		waiters.add(wake);
	});

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
	const rig = leader.rig === null ? undefined : rigs.get(leader.rig);
	if (rig?.leaderInputDebug?.leader === leader.name) clearLeaderInputDebug(rig);
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
