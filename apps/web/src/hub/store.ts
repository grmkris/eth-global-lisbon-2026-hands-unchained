/**
 * Hub state. Deliberately in-memory: rigs re-register on reconnect, so a
 * Railway redeploy costs nothing and there is no database to run.
 */

export interface RigFrame {
	data: Uint8Array;
	at: number;
}

export interface RigCommand {
	verb: string;
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
	lastSeen: number;
	frames: Map<string, RigFrame>;
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
		"name" | "frames" | "input" | "pending" | "lease" | "lastSeen"
	>,
): Rig => {
	const existing = rigs.get(name);
	if (existing) {
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
	};
	rigs.set(name, rig);
	return rig;
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
