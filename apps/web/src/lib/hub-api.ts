import { queryOptions } from "@tanstack/react-query";
import { HUB_TOKEN_COOKIE } from "#/lib/constants";

export interface RigSummary {
	name: string;
	backend: string;
	armState: string;
	source: string | null;
	online: boolean;
	cams: ReadonlyArray<string>;
	joints: Record<string, number>;
	lastError: string | null;
	holder: string | null;
	linkMs: number;
	lastSeen: number;
}

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

export type LabMode = "hub" | "rig";

/**
 * One build, two roles. Resolved at runtime rather than baked in, so the same
 * artifact deploys to Railway as the hub and runs on the Mac as the rig.
 */
export const modeQuery = queryOptions({
	queryKey: ["mode"],
	queryFn: async (): Promise<{ mode: LabMode; rigName: string }> => {
		const res = await fetch("/api/mode");
		if (!res.ok) return { mode: "rig", rigName: "local-rig" };
		return res.json();
	},
	staleTime: Number.POSITIVE_INFINITY,
});

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
export const sendRigCommand = (name: string, verb: string) =>
	post(`/api/hub/rigs/${encodeURIComponent(name)}/command`, { verb });
