import { queryOptions } from "@tanstack/react-query";
import type {
	AttemptState,
	PushStatus,
	RecordStatus,
	RunInfo,
	TaskInfo,
} from "#/api/contract";
import { HUB_TOKEN_COOKIE } from "#/lib/constants";

export interface LeaderInputDebug {
	leader: string;
	transport: "http" | "websocket";
	joints: Record<string, number>;
	at: number;
	/** Packet age computed by the hub, avoiding browser/hub wall-clock skew. */
	ageMs: number;
	packets: number;
	dropped: boolean;
}

export interface RigSummary {
	name: string;
	backend: string;
	armState: string;
	source: string | null;
	/** a leader arm is physically attached to the rig (rig-local teleop possible) */
	leader: boolean;
	online: boolean;
	cams: ReadonlyArray<string>;
	joints: Record<string, number>;
	lastError: string | null;
	camMapping: { workspace: number | null; wrist: number | null } | null;
	camBrightness: Record<string, number>;
	/** camera indexes the owner switched off — not in `cams` by construction */
	camDisabled: ReadonlyArray<number>;
	/** per-cam age of the newest frame the hub holds, ms */
	camAgeMs: Record<string, number>;
	record: RecordStatus | null;
	attempt: AttemptState | null;
	/** live dataset publish status (owner panel shows progress + the link) */
	push: PushStatus | null;
	tasks: ReadonlyArray<TaskInfo>;
	runs: ReadonlyArray<RunInfo>;
	lastCommandResult: {
		verb: string;
		ok: boolean;
		error: string | null;
		at: number;
	} | null;
	/** Last authorized packet from the rig's bound remote leader. */
	leaderInputDebug: LeaderInputDebug | null;
	holder: string | null;
	linkMs: number;
	/** how input reaches the rig's driver: its hub socket, or the polled mailbox */
	inputTransport: "websocket" | "http";
	lastSeen: number;
}

/** Owner key for a rig, remembered per browser (printed by the rig at boot). */
export const ownerKeyStore = {
	get: (rig: string): string =>
		typeof window === "undefined"
			? ""
			: (localStorage.getItem(`lab-owner-key:${rig}`) ?? ""),
	set: (rig: string, v: string): void => {
		localStorage.setItem(`lab-owner-key:${rig}`, v);
	},
};

/** One id per browser tab — the lease is held by this, not by a user account. */
export const clientId = ((): string => {
	if (typeof window === "undefined") return "ssr";
	const key = "lab-client-id";
	let id = sessionStorage.getItem(key);
	if (!id) {
		id = `op-${Math.random().toString(36).slice(2, 10)}`;
		sessionStorage.setItem(key, id);
	}
	return id;
})();

/**
 * Hub shared secret, entered once in the lobby. localStorage feeds the
 * fetch header; the cookie exists for what cannot set headers — <img>
 * MJPEG streams and the lease-release sendBeacon.
 */
export const hubToken = {
	get: (): string =>
		typeof window === "undefined"
			? ""
			: (localStorage.getItem("lab-hub-token") ?? ""),
	set: (token: string): void => {
		localStorage.setItem("lab-hub-token", token);
		const secure = location.protocol === "https:" ? "; Secure" : "";
		// The suggested Cookie Store API is async and unsupported in Safari. This
		// write must be visible to the very next request the page makes — an <img>
		// MJPEG stream that cannot send an auth header — so a promise-based set
		// would race it.
		// biome-ignore lint/suspicious/noDocumentCookie: Cookie Store is async + no Safari support; this must land before the next <img> request
		document.cookie = `${HUB_TOKEN_COOKIE}=${encodeURIComponent(token)}; path=/; max-age=31536000; SameSite=Lax${secure}`;
	},
};

const authHeaders = (): Record<string, string> => {
	const token = hubToken.get();
	return token ? { authorization: `Bearer ${token}` } : {};
};

const post = async (path: string, body: Record<string, unknown> = {}) => {
	const res = await fetch(path, {
		method: "POST",
		headers: { "content-type": "application/json", ...authHeaders() },
		body: JSON.stringify({ clientId, ...body }),
	});
	const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
	if (res.status === 401) throw new Error("unauthorized");
	if (!res.ok) throw new Error(String(json.error ?? res.statusText));
	return json;
};

/** GET with the same auth + error contract as `post`. */
const get = async <T>(path: string, unreachable: string): Promise<T> => {
	const res = await fetch(path, { headers: authHeaders() });
	if (res.status === 401) throw new Error("unauthorized");
	if (!res.ok) throw new Error(unreachable);
	return res.json() as Promise<T>;
};

export const rigsQuery = queryOptions({
	queryKey: ["hub", "rigs"],
	queryFn: () =>
		get<ReadonlyArray<RigSummary>>("/api/hub/rigs", "hub unreachable"),
	refetchInterval: 2_000,
});

export const rigQuery = (name: string) =>
	queryOptions({
		queryKey: ["hub", "rigs", name],
		queryFn: () =>
			get<RigSummary>(
				`/api/hub/rigs/${encodeURIComponent(name)}`,
				"rig not registered on this hub",
			),
		refetchInterval: 500,
	});

/** Operator-side leader arms registered on the hub (controller.py). */
export interface LeaderSummary {
	name: string;
	online: boolean;
	/** rig it is streaming to, null = idle and available to lend */
	driving: string | null;
}

export const leadersQuery = queryOptions({
	queryKey: ["hub", "leaders"],
	queryFn: () =>
		get<ReadonlyArray<LeaderSummary>>("/api/hub/leaders", "hub unreachable"),
	refetchInterval: 2_000,
});

export const sendLeaderCommand = (
	name: string,
	action: "drive" | "stop",
	rig?: string,
) =>
	post(`/api/hub/leaders/${encodeURIComponent(name)}/command`, {
		action,
		...(rig ? { rig } : {}),
	});

export const impairmentQuery = queryOptions({
	queryKey: ["hub", "impairment"],
	queryFn: () =>
		get<{ latencyMs: number; dropRate: number }>(
			"/api/hub/impairment",
			"hub unreachable",
		),
	staleTime: 60_000,
});

export const claimRig = (name: string, force = false) =>
	post(
		`/api/hub/rigs/${encodeURIComponent(name)}/claim`,
		force ? { force } : {},
	);
export const releaseRig = (name: string) =>
	post(`/api/hub/rigs/${encodeURIComponent(name)}/release`);
export const sendRigInput = (name: string, axes: Record<string, number>) =>
	post(`/api/hub/rigs/${encodeURIComponent(name)}/input`, { axes });
export const sendRigCommand = (
	name: string,
	verb: string,
	options: {
		args?: Record<string, unknown>;
		ownerKey?: string;
	} = {},
) =>
	post(`/api/hub/rigs/${encodeURIComponent(name)}/command`, {
		verb,
		...(options.args ? { args: options.args } : {}),
		...(options.ownerKey ? { ownerKey: options.ownerKey } : {}),
	});
