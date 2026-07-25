/**
 * Rig → hub link. Dials OUT, so the rig needs no inbound port, no port
 * forwarding and no public IP — the same reason lerobot's async-inference
 * client dials out to its policy server.
 *
 * Plain HTTP polling rather than a socket: it behaves identically in vite dev
 * and in production, survives a Railway redeploy with no reconnect logic, and
 * is debuggable with curl. One request carries telemetry up and control down.
 */
import { apiHandler } from "#/api/live";
import { mjpegBase } from "#/api/services/driver-manager";
import { isVerb, VERBS } from "#/hub/verbs";

const LINK_MS = 50; // 20 Hz control
const FRAME_MS = 125; // 8 fps preview — the recording stays full-rate locally

/** Call the rig's own API in-process — reuses all existing validation. */
const localApi = async (
	path: string,
	init?: RequestInit,
): Promise<unknown | null> => {
	try {
		const res = await apiHandler(
			new Request(`http://rig.local${path}`, {
				...init,
				headers: { "content-type": "application/json", ...init?.headers },
			}),
		);
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
};

interface RobotState {
	state: string;
	backend: string;
	source: string | null;
	joints: Record<string, number>;
	lastError: string | null;
}

export const startRigLink = (opts: {
	hubUrl: string;
	rigName: string;
	/** "sim" | "real" — bring the backend up on boot so the rig appears in the
	 * lobby already streaming, instead of waiting for someone to click Connect. */
	autoConnect?: string;
	/** Hub shared secret (HUB_TOKEN) — sent as a bearer header on every call. */
	token?: string;
}): void => {
	const { hubUrl, rigName, autoConnect, token } = opts;
	const base = hubUrl.replace(/\/$/, "");
	const auth: Record<string, string> = token
		? { authorization: `Bearer ${token}` }
		: {};
	// live streams as the driver reports them (cameras/status.previewing) —
	// refreshed on the frame cadence, advertised to the hub on the link cadence
	let previewing: ReadonlyArray<string> = [];
	let linkMs = 0;
	let linkWarned = false;
	let frameWarned = false;

	const runCommand = async (verb: string) => {
		if (!isVerb(verb)) {
			console.error(`[rig-link] unknown command ${verb}`);
			return;
		}
		const spec = VERBS[verb];
		await localApi(spec.path, {
			method: "POST",
			...("body" in spec ? { body: JSON.stringify(spec.body) } : {}),
		});
	};

	let autoConnectTried = false;
	const link = async () => {
		const started = Date.now();
		const robot = (await localApi("/api/robot/state")) as RobotState | null;

		if (autoConnect && !autoConnectTried && robot?.state === "disconnected") {
			autoConnectTried = true; // one attempt — never fight a human disconnect
			console.error(`[rig-link] auto-connecting backend=${autoConnect}`);
			await runCommand(autoConnect === "sim" ? "connect_sim" : "connect_real");
			if (autoConnect === "real") {
				const probed = (await localApi("/api/cameras/probe")) as Array<{
					index: number;
				}> | null;
				if (probed?.length)
					await localApi("/api/cameras/preview/start", {
						method: "POST",
						body: JSON.stringify({ indexes: probed.map((c) => c.index) }),
					});
			}
		}

		try {
			const res = await fetch(`${base}/api/hub/link`, {
				method: "POST",
				headers: { "content-type": "application/json", ...auth },
				body: JSON.stringify({
					name: rigName,
					backend: robot?.backend ?? "real",
					armState: robot?.state ?? "disconnected",
					source: robot?.source ?? null,
					joints: robot?.joints ?? {},
					cams: previewing,
					lastError: robot?.lastError ?? null,
					linkMs,
				}),
			});
			linkMs = Date.now() - started;
			if (!res.ok) return;
			const body = (await res.json()) as {
				input: {
					axes?: Record<string, number>;
					joints?: Record<string, number>;
				} | null;
				commands: Array<{ verb: string }>;
			};
			linkWarned = false;

			if (body.input) {
				await localApi("/api/robot/teleop/input", {
					method: "POST",
					body: JSON.stringify(body.input),
				});
			}
			for (const cmd of body.commands ?? []) {
				await runCommand(cmd.verb);
			}
		} catch (err) {
			if (!linkWarned) {
				linkWarned = true;
				console.error(
					`[rig-link] hub unreachable at ${base} (${String(err)}) — retrying`,
				);
			}
		}
	};

	const pushOne = async (mjpeg: string, cam: string) => {
		try {
			const snap = await fetch(`${mjpeg}/snap/${cam}`);
			if (!snap.ok) return;
			const buf = await snap.arrayBuffer();
			const res = await fetch(
				`${base}/api/hub/frame?rig=${encodeURIComponent(rigName)}&cam=${encodeURIComponent(cam)}`,
				{
					method: "POST",
					headers: { "content-type": "image/jpeg", ...auth },
					body: buf,
				},
			);
			if (!res.ok) throw new Error(`hub rejected frame: ${res.status}`);
			frameWarned = false;
		} catch (err) {
			if (!frameWarned) {
				frameWarned = true;
				console.error(
					`[rig-link] frame push failed for ${cam} (${String(err)}) — retrying`,
				);
			}
		}
	};

	const pushFrames = async () => {
		const cameras = (await localApi("/api/cameras/status")) as {
			previewing?: string[];
		} | null;
		previewing = cameras?.previewing ?? [];
		const mjpeg = mjpegBase(); // null until the driver reports its port
		if (!mjpeg || previewing.length === 0) return;
		await Promise.all(previewing.map((cam) => pushOne(mjpeg, cam)));
	};

	// Self-scheduling (not setInterval): a tick that outlives its budget —
	// routine once WAN RTT > 50ms — must not stack concurrent duplicates.
	const loop = (fn: () => Promise<void>, ms: number) => {
		const tick = () => {
			void fn().finally(() => setTimeout(tick, ms));
		};
		tick();
	};

	console.error(`[rig-link] ${rigName} -> ${base} (link ${LINK_MS}ms)`);
	loop(link, LINK_MS);
	loop(pushFrames, FRAME_MS);
};
