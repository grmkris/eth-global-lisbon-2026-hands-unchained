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
import { isOwnerKey } from "#/api/owner-key";
import { mjpegBase } from "#/api/services/driver-manager";
import { isVerb, VERBS, type Verb } from "#/hub/verbs";
import { setHolder } from "#/rig/holder";

const LINK_MS = 50; // 20 Hz control
/** Preview cadence — the recording stays full-rate locally. 80 ms = 12.5 fps;
 * two 640×480 JPEG streams ≈ 1 MB/s up, which a home line carries fine.
 * LAB_FRAME_MS trades upload for smoothness (125 = the old 8 fps). */
/** Camera push cadence. Guarded because `setTimeout(fn, NaN)` means 0 — a
 * typo'd LAB_FRAME_MS would turn the frame loop into a hot loop hammering the
 * cameras and the hub as fast as the network allows. */
const frameMsRaw = Number(process.env.LAB_FRAME_MS);
const FRAME_MS =
	Number.isFinite(frameMsRaw) && frameMsRaw >= 20 ? frameMsRaw : 80;

type InputPacket = {
	joints?: Record<string, number>;
	axes?: Record<string, number>;
};

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

/** Like localApi but keeps the failure text — relayed verbs must not fail
 * silently (a wrong owner key or a rejected attempt needs to reach the UI). */
const localApiVerbose = async (
	path: string,
	body: unknown,
): Promise<{ ok: boolean; error: string | null }> => {
	try {
		const res = await apiHandler(
			new Request(`http://rig.local${path}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
		);
		if (res.ok) return { ok: true, error: null };
		const text = await res.text();
		let message = text.slice(0, 200);
		try {
			const parsed = JSON.parse(text) as { message?: string; error?: string };
			message = parsed.message ?? parsed.error ?? message;
		} catch {}
		return { ok: false, error: message };
	} catch (err) {
		return { ok: false, error: String(err).slice(0, 200) };
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

	/**
	 * Hand one input packet to the local driver. Latest-wins with a SINGLE
	 * request in flight: at 30 Hz, firing each POST and forgetting it let
	 * completions land out of order, so the arm could snap back to a target it
	 * had already passed. Newer input simply replaces whatever is queued.
	 *
	 * It also makes the failure audible. `localApi` swallows non-2xx, so
	 * "no remote-joints teleop source active" — the exact failure the remote
	 * record source was added for — reached nobody: not the log, not lastError,
	 * not the UI. Rate-limited so a stuck session cannot spam 30 lines/s.
	 */
	let inputQueued: InputPacket | null = null;
	let inputDraining = false;
	let inputFailedAt = 0;
	const applyInput = (packet: InputPacket): void => {
		inputQueued = packet;
		if (inputDraining) return;
		inputDraining = true;
		void (async () => {
			while (inputQueued !== null) {
				const next = inputQueued;
				inputQueued = null;
				const res = await localApiVerbose("/api/robot/teleop/input", next);
				if (!res.ok && Date.now() - inputFailedAt > 5_000) {
					inputFailedAt = Date.now();
					console.error(`[rig-link] input rejected: ${res.error}`);
				}
			}
			inputDraining = false;
		})();
	};
	let lastCommandResult: {
		verb: string;
		ok: boolean;
		error: string | null;
		at: number;
	} | null = null;
	// tiny stable content hash (djb2) — only used for change detection
	const rev = (value: unknown): string => {
		const s = JSON.stringify(value);
		let h = 5381;
		for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
		return (h >>> 0).toString(16);
	};

	// rev-echo pairs: hub tells us what rev it has; on mismatch we send all.
	// Sidecar files are read on a slow cadence and cached for the tick.
	let hubTasksRev: string | null | undefined;
	const tasksCache: { tasks: unknown[]; rev: string | null } = {
		tasks: [],
		rev: null,
	};
	const refreshTasks = async () => {
		const tasks = (await localApi("/api/tasks")) as unknown[] | null;
		if (tasks === null) return;
		tasksCache.tasks = tasks;
		tasksCache.rev = rev(tasks);
	};

	let hubRunsRev: string | null | undefined;
	const runsCache: { runs: unknown[]; rev: string | null } = {
		runs: [],
		rev: null,
	};
	const refreshRuns = async () => {
		const runs = (await localApi("/api/runs")) as Array<{
			id: string;
			colabCell?: unknown;
		}> | null;
		if (runs === null) return;
		// advertise sidecar rows only (imported hub- rows the hub already has),
		// and strip colabCell — it's a pure function the hub regenerates.
		const advertised = runs
			.filter((r) => !r.id.startsWith("hub-"))
			.map((r) => ({ ...r, colabCell: null }));
		runsCache.runs = advertised;
		runsCache.rev = rev(advertised);
	};

	// camera mapping + brightness for the hub's camera-setup panel — captured
	// from the same cameras/status call the frame loop already makes.
	let camMapping: { workspace: number | null; wrist: number | null } | null =
		null;
	let camBrightness: Record<string, number> = {};

	const runCommand = async (cmd: {
		verb: string;
		args?: Record<string, unknown>;
		ownerKey?: string;
		holder?: string | null;
	}) => {
		const { verb } = cmd;
		if (!isVerb(verb)) {
			console.error(`[rig-link] unknown command ${verb}`);
			return;
		}
		const spec = VERBS[verb as Verb];
		// The link layer IS the portless rig's network boundary: EVERY owner
		// verb is key-checked here, before any endpoint runs. (The tasks
		// endpoints double-check in-payload; the rest rely on this gate.)
		if (spec.owner === true && !isOwnerKey(cmd.ownerKey ?? "")) {
			lastCommandResult = {
				verb,
				ok: false,
				error: "wrong owner key",
				at: Date.now(),
			};
			console.error(`[rig-link] ${verb} rejected: wrong owner key`);
			return;
		}
		const body = {
			...spec.body,
			...(spec.args
				? Object.fromEntries(
						spec.args
							.filter((k) => cmd.args && k in cmd.args)
							.map((k) => [k, (cmd.args as Record<string, unknown>)[k]]),
					)
				: {}),
			// only the tasks endpoints take the key in-payload
			...(spec.owner && spec.path.startsWith("/api/tasks/")
				? { ownerKey: cmd.ownerKey }
				: {}),
			// the hub stamps the lease holder — operator identity is not spoofable
			...(spec.stampsHolder ? { operator: cmd.holder ?? "unknown" } : {}),
		};
		const result = await localApiVerbose(spec.path, body);
		lastCommandResult = { verb, ...result, at: Date.now() };
		if (!result.ok) console.error(`[rig-link] ${verb} failed: ${result.error}`);
	};

	let autoConnectTried = false;
	const link = async () => {
		const started = Date.now();
		const robot = (await localApi("/api/robot/state")) as RobotState | null;

		if (autoConnect && !autoConnectTried && robot?.state === "disconnected") {
			autoConnectTried = true; // one attempt — never fight a human disconnect
			console.error(`[rig-link] auto-connecting backend=${autoConnect}`);
			await runCommand({
				verb: autoConnect === "sim" ? "connect_sim" : "connect_real",
			});
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

		// cached driver-event state — both are cheap in-memory reads
		const record = await localApi("/api/record/status");
		const attempt = await localApi("/api/attempts/state");

		try {
			// rev-echo: send the full array only when the hub's echo differs
			// (fresh hub, edit, redeploy) — steady state costs one string each
			const advertiseTasks = hubTasksRev !== tasksCache.rev;
			const advertiseRuns = hubRunsRev !== runsCache.rev;
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
					camMapping,
					camBrightness,
					lastError: robot?.lastError ?? null,
					record,
					attempt,
					lastCommandResult,
					linkMs,
					tasksRev: tasksCache.rev,
					...(advertiseTasks ? { tasks: tasksCache.tasks } : {}),
					runsRev: runsCache.rev,
					...(advertiseRuns ? { runs: runsCache.runs } : {}),
				}),
			});
			linkMs = Date.now() - started;
			if (!res.ok) return;
			const body = (await res.json()) as {
				input: {
					axes?: Record<string, number>;
					joints?: Record<string, number>;
				} | null;
				commands: Array<{
					verb: string;
					args?: Record<string, unknown>;
					ownerKey?: string;
					holder?: string | null;
				}>;
				holder: string | null;
				tasksRev?: string | null;
				runsRev?: string | null;
			};
			linkWarned = false;
			setHolder(body.holder ?? null);
			hubTasksRev = body.tasksRev ?? null;
			hubRunsRev = body.runsRev ?? null;

			if (body.input) applyInput(body.input);
			for (const cmd of body.commands ?? []) {
				await runCommand(cmd);
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

	/**
	 * One upload in flight PER CAMERA, and a tick that finds one busy simply
	 * skips that camera — it does not wait and does not queue.
	 *
	 * Two things fall out of that. Cameras stop blocking each other: awaiting
	 * `Promise.all` made every tick cost `max(cam RTTs)`, so one slow camera
	 * throttled the other. And on a saturated uplink — the hackathon-wifi case —
	 * the rig DROPS frames instead of piling them up, so the operator sees a
	 * lower frame rate at roughly constant latency rather than a smooth feed
	 * sliding further and further into the past. Latest-wins, same principle as
	 * the input mailbox: a skipped frame is corrected by the next one.
	 */
	const framesInFlight = new Set<string>();
	const pushFrames = async () => {
		const cameras = (await localApi("/api/cameras/status")) as {
			previewing?: string[];
			mapping?: { workspace: number | null; wrist: number | null };
			brightness?: Record<string, number>;
		} | null;
		previewing = cameras?.previewing ?? [];
		camMapping = cameras?.mapping ?? null;
		camBrightness = cameras?.brightness ?? {};
		const mjpeg = mjpegBase(); // null until the driver reports its port
		if (!mjpeg || previewing.length === 0) return;
		for (const cam of previewing) {
			if (framesInFlight.has(cam)) continue; // still uploading — skip, don't queue
			framesInFlight.add(cam);
			void pushOne(mjpeg, cam).finally(() => framesInFlight.delete(cam));
		}
	};

	// --- input plane socket (hub/ws.ts) ------------------------------------
	// Input is the one hop where the 50ms link tick is felt, so the hub pushes
	// it here the moment it arrives instead of parking it in the mailbox. The
	// /link tick keeps running unchanged: a socket-pushed packet never enters
	// the mailbox, so nothing is delivered twice, and if the socket is down
	// (vite dev has no Bun.serve, a proxy eats the upgrade, an old hub) input
	// simply rides the mailbox again — slower, identical semantics.
	let inputSocketWarned = false;
	let inputSocketBackoff = 2_000; // 2s -> 30s: a hub that can't upgrade at all
	const openInputSocket = (): void => {
		// token in a HEADER, not the query: hub/auth.ts calls the query form a
		// curl-debug fallback, and proxies log query strings.
		const wsUrl = `${base.replace(/^http/, "ws")}/api/hub/ws?role=rig&name=${encodeURIComponent(rigName)}`;
		let ws: WebSocket;
		try {
			ws = new WebSocket(wsUrl, {
				headers: token ? { authorization: `Bearer ${token}` } : {},
			} as unknown as string[]);
		} catch {
			setTimeout(openInputSocket, 2_000);
			return;
		}
		let reconnected = false;
		const retry = () => {
			if (reconnected) return; // error + close both fire; reconnect once
			reconnected = true;
			setTimeout(openInputSocket, inputSocketBackoff);
			inputSocketBackoff = Math.min(inputSocketBackoff * 2, 30_000);
		};
		ws.onopen = () => {
			inputSocketWarned = false;
			inputSocketBackoff = 2_000;
			console.error("[rig-link] input socket up (event-driven input)");
		};
		ws.onmessage = (ev) => {
			try {
				const msg = JSON.parse(String(ev.data)) as {
					t?: string;
					joints?: Record<string, number>;
					axes?: Record<string, number>;
					at?: number;
				};
				if (msg.t !== "input") return;
				// same 500ms gate the mailbox path applies hub-side: after a stall,
				// buffered packets are stale targets and must not be replayed
				if (msg.at !== undefined && Date.now() - msg.at > 500) return;
				applyInput({ joints: msg.joints, axes: msg.axes });
			} catch {}
		};
		ws.onerror = () => {
			if (!inputSocketWarned) {
				inputSocketWarned = true;
				console.error(
					"[rig-link] input socket unavailable — input rides the HTTP link",
				);
			}
			retry();
		};
		ws.onclose = retry;
	};

	// Self-scheduling (not setInterval): a tick that outlives its budget —
	// routine once WAN RTT > 50ms — must not stack concurrent duplicates.
	//
	// The delay is a DEADLINE, not a gap: sleeping the full `ms` *after* the
	// work made every cadence in this file silently half-rate over WAN, because
	// the period was `ms + work`. Measured against the deployed hub: frames ran
	// at 151ms (80 + 58ms upload + ~13) = 6.6fps instead of 12.5, and the link
	// at 98ms (50 + 48) = 10Hz instead of the documented 20. Loopback hid it —
	// there `work` is ~0, which is why the original Checkpoint A passed.
	// MIN_GAP_MS keeps an overrunning tick from degenerating into a hot loop.
	const MIN_GAP_MS = 15;
	const loop = (fn: () => Promise<void>, ms: number) => {
		const tick = () => {
			const started = Date.now();
			void fn().finally(() =>
				setTimeout(tick, Math.max(MIN_GAP_MS, ms - (Date.now() - started))),
			);
		};
		tick();
	};

	console.error(
		`[rig-link] ${rigName} -> ${base} (link ${LINK_MS}ms, frames ${FRAME_MS}ms)`,
	);
	openInputSocket();
	loop(link, LINK_MS);
	loop(pushFrames, FRAME_MS);
	loop(refreshTasks, 2_000); // sidecar reads — slow cadence is plenty
	loop(refreshRuns, 2_000);
};
