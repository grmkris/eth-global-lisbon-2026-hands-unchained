/**
 * Hub endpoints — raw routes beside the typed HttpApi (same precedent as
 * /api/cams/*). Deliberately a narrow verb set rather than a general tunnel:
 * a guest must not be able to reach /api/record/start on someone's machine.
 */
import type {
	AttemptState,
	RecordStatus,
	RunInfo,
	TaskInfo,
} from "#/api/contract";
import {
	claimLease,
	drainCommands,
	getLeader,
	getRig,
	impair,
	impairment,
	isOnline,
	type Leader,
	leaderBound,
	leaderMayDrive,
	leaderOnline,
	leaseHolder,
	listLeaders,
	listRigs,
	MAX_PENDING,
	pruneLeaderBinding,
	type Rig,
	releaseLease,
	setFrame,
	shouldDrop,
	takeLeaderCommand,
	upsertLeader,
	upsertRig,
	waitForFrame,
} from "./store";
import { isVerb, VERBS } from "./verbs";

/** Hub NEVER logs request bodies — ownerKeys transit through them. */
const MAX_ARGS_BYTES = 4096;

export const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json",
			"cache-control": "no-store",
		},
	});

const enc = new TextEncoder();
const CRLF = enc.encode("\r\n");

const rigSummary = (rig: Rig) => ({
	name: rig.name,
	backend: rig.backend,
	armState: rig.armState,
	source: rig.source,
	online: isOnline(rig),
	cams: rig.cams,
	joints: rig.joints,
	lastError: rig.lastError,
	record: rig.record,
	attempt: rig.attempt,
	tasks: rig.tasks,
	runs: rig.runs,
	camMapping: rig.camMapping,
	camBrightness: rig.camBrightness,
	/** age of each cam's newest frame, hub-side. The one number that says
	 * whether video is keeping up — a value that climbs means the rig's uplink
	 * cannot carry the push cadence. */
	camAgeMs: Object.fromEntries(
		[...rig.frames].map(([cam, frame]) => [cam, Date.now() - frame.at]),
	),
	lastCommandResult: rig.lastCommandResult,
	holder: leaseHolder(rig),
	linkMs: rig.linkMs,
	lastSeen: rig.lastSeen,
});

const leaderSummary = (leader: Leader) => ({
	name: leader.name,
	online: leaderOnline(leader),
	/** rig it is streaming to, null = idle and available to lend */
	driving: leader.driving,
});

/** Multipart stream assembled from whatever frames the rig last pushed. */
const mjpegResponse = (rig: Rig, cam: string): Response => {
	let closed = false;
	let lastAt = 0;
	const stream = new ReadableStream<Uint8Array>({
		async pull(controller) {
			while (!closed) {
				const frame = rig.frames.get(cam);
				if (frame && frame.at !== lastAt) {
					lastAt = frame.at;
					controller.enqueue(
						enc.encode(
							`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.data.length}\r\n\r\n`,
						),
					);
					controller.enqueue(frame.data);
					controller.enqueue(CRLF);
					return;
				}
				// woken by setFrame; the timeout is only a keepalive so a stream
				// whose rig went dark still re-checks `closed` instead of parking
				await waitForFrame(rig, cam, 1_000);
			}
		},
		cancel() {
			closed = true;
		},
	});
	return new Response(stream, {
		headers: {
			"content-type": "multipart/x-mixed-replace; boundary=frame",
			"cache-control": "no-store",
		},
	});
};

export const handleHubRequest = async (
	request: Request,
	url: URL,
): Promise<Response> => {
	const path = url.pathname.replace(/^\/api\/hub/, "");

	// --- rig side -----------------------------------------------------------

	// One request carries telemetry up and control down.
	if (path === "/link" && request.method === "POST") {
		const body = (await request.json()) as {
			name: string;
			backend: string;
			armState: string;
			source: string | null;
			joints: Record<string, number>;
			cams: ReadonlyArray<string>;
			lastError?: string | null;
			linkMs?: number;
			record?: RecordStatus | null;
			attempt?: AttemptState | null;
			lastCommandResult?: Rig["lastCommandResult"];
			camMapping?: Rig["camMapping"];
			camBrightness?: Record<string, number>;
			/** rev-echo: full arrays ride along only when our echo mismatched */
			tasksRev?: string | null;
			tasks?: ReadonlyArray<TaskInfo>;
			runsRev?: string | null;
			runs?: ReadonlyArray<RunInfo>;
		};
		if (!body.name) return json({ error: "name required" }, 400);
		const rig = upsertRig(body.name, {
			backend: body.backend,
			armState: body.armState,
			source: body.source,
			joints: body.joints ?? {},
			cams: body.cams ?? [],
			lastError: body.lastError ?? null,
			camMapping: body.camMapping ?? null,
			camBrightness: body.camBrightness ?? {},
			record: body.record ?? null,
			attempt: body.attempt ?? null,
			lastCommandResult: body.lastCommandResult ?? null,
			linkMs: body.linkMs ?? 0,
		});
		if (body.tasks !== undefined) {
			rig.tasks = body.tasks;
			rig.tasksRev = body.tasksRev ?? null;
		}
		if (body.runs !== undefined) {
			rig.runs = body.runs;
			rig.runsRev = body.runsRev ?? null;
		}
		await impair();
		const commands = drainCommands(rig);
		// Consume-once. The hub is a pipe, not a repeater: replaying the last
		// axes would keep refreshing the driver's 0.5s deadman and the arm would
		// run on after the operator stopped sending. Verified — it drifted 9°.
		const pending = rig.input;
		rig.input = null;
		const fresh = pending !== null && Date.now() - pending.at < 500;
		return json({
			input: fresh ? { axes: pending.axes, joints: pending.joints } : null,
			commands,
			holder: leaseHolder(rig),
			// what the hub currently has — the rig re-advertises on mismatch
			tasksRev: rig.tasksRev,
			runsRev: rig.runsRev,
		});
	}

	if (path === "/frame" && request.method === "POST") {
		const name = url.searchParams.get("rig");
		const cam = url.searchParams.get("cam");
		if (!name || !cam) return json({ error: "rig and cam required" }, 400);
		const rig = getRig(name);
		if (!rig) return json({ error: "unknown rig" }, 404);
		const buf = new Uint8Array(await request.arrayBuffer());
		await impair();
		setFrame(rig, cam, buf);
		return json({ ok: true, bytes: buf.length });
	}

	// --- leader agents (operator-side leader arms) --------------------------

	// Heartbeat up, command down — the leader-agent mirror of /link.
	if (path === "/leaders/link" && request.method === "POST") {
		const body = (await request.json().catch(() => ({}))) as {
			name?: string;
			driving?: string | null;
		};
		if (!body.name) return json({ error: "name required" }, 400);
		const driving = body.driving ?? null;
		const leader = upsertLeader(body.name, driving);
		await impair();
		// `bound` is the leader's revocation signal: the WS input plane gets no
		// per-packet status, so this is how a browser take-over (or Stop) reaches
		// a streaming agent — within one heartbeat (~0.5s). Asked about the rig
		// the AGENT is driving, so a rebind elsewhere revokes rather than wedges.
		const bound = leaderBound(leader, driving);
		if (!bound) pruneLeaderBinding(leader);
		return json({ command: takeLeaderCommand(leader), bound });
	}

	if (path === "/leaders" && request.method === "GET") {
		return json(listLeaders().map(leaderSummary));
	}

	const leaderMatch = path.match(/^\/leaders\/([^/]+)\/command$/);
	if (leaderMatch && request.method === "POST") {
		const leader = getLeader(decodeURIComponent(leaderMatch[1]));
		if (!leader) return json({ error: "unknown leader" }, 404);
		if (!leaderOnline(leader)) return json({ error: "leader offline" }, 409);
		const body = (await request.json().catch(() => ({}))) as {
			action?: string;
			rig?: string;
			clientId?: string;
		};
		if (body.action === "drive") {
			const rig = body.rig ? getRig(body.rig) : undefined;
			if (!rig) return json({ error: "unknown rig" }, 404);
			if (!isOnline(rig)) return json({ error: "rig offline" }, 409);
			if (!body.clientId) return json({ error: "clientId required" }, 400);
			// The COMMANDING BROWSER keeps the lease; the leader only becomes its
			// input device. So you must already hold the rig to lend it your arm —
			// and the attempt you started stays yours while the leader drives.
			if (leaseHolder(rig) !== body.clientId)
				return json({ error: "take control first" }, 403);
			// Rebinding a leader mid-session used to strand the agent: its packets
			// to the old rig start failing while it is told it is still bound.
			// Stop it first (the UI only offers idle leaders anyway).
			if (leader.driving !== null && leader.driving !== rig.name)
				return json(
					{ error: `leader is driving ${leader.driving} — stop it first` },
					409,
				);
			if (rig.pending.length >= MAX_PENDING)
				return json({ error: "command queue full" }, 429);
			leader.boundTo = body.clientId;
			leader.rig = rig.name;
			leader.pending = { action: "drive", rig: rig.name, queuedAt: Date.now() };
			// the hub starts the remote source itself — the agent no longer sends
			// verbs, and the holder stamp stays the browser
			rig.pending.push({
				verb: "teleop_start_remote",
				holder: body.clientId,
				queuedAt: Date.now(),
			});
			return json({ ok: true, queued: "drive" });
		}
		if (body.action === "stop") {
			const rig = leader.rig ? getRig(leader.rig) : undefined;
			leader.boundTo = null;
			leader.rig = null;
			leader.pending = { action: "stop", queuedAt: Date.now() };
			// teleop_stop is a safety verb — anyone may end a remote session
			if (rig && rig.pending.length < MAX_PENDING)
				rig.pending.push({
					verb: "teleop_stop",
					holder: leaseHolder(rig),
					queuedAt: Date.now(),
				});
			return json({ ok: true, queued: "stop" });
		}
		return json({ error: "action must be drive|stop" }, 400);
	}

	// --- operator side ------------------------------------------------------

	if (path === "/rigs" && request.method === "GET") {
		return json(listRigs().map(rigSummary));
	}

	if (path === "/impairment" && request.method === "GET") {
		return json(impairment);
	}

	const rigMatch = path.match(/^\/rigs\/([^/]+)(\/[^/]*)?$/);
	if (rigMatch) {
		const rig = getRig(decodeURIComponent(rigMatch[1]));
		if (!rig) return json({ error: "unknown rig" }, 404);
		const action = rigMatch[2] ?? "";

		if (action === "" && request.method === "GET") return json(rigSummary(rig));

		if (request.method === "POST") {
			const body = (await request.json().catch(() => ({}))) as {
				clientId?: string;
				axes?: Record<string, number>;
				joints?: Record<string, number>;
				verb?: string;
				force?: boolean;
				args?: Record<string, unknown>;
				ownerKey?: string;
			};
			const clientId = body.clientId;
			if (!clientId) return json({ error: "clientId required" }, 400);

			if (action === "/claim") {
				const ok = claimLease(rig, clientId, body.force === true);
				return json({ ok, holder: leaseHolder(rig) }, ok ? 200 : 409);
			}
			if (action === "/release") {
				releaseLease(rig, clientId);
				return json({ ok: true, holder: leaseHolder(rig) });
			}
			if (action === "/input") {
				// `leader-<name>` is a bound input device, not a lease holder: it
				// writes iff its browser still holds the rig. No lease renewal on
				// that path — the browser's claim interval is the heartbeat, so a
				// dead browser expires the lease and this starts 403ing.
				const leader = clientId.startsWith("leader-")
					? getLeader(clientId.slice("leader-".length))
					: undefined;
				if (leader) {
					if (!leaderMayDrive(leader, rig))
						return json({ error: "not bound to the controller" }, 403);
				} else if (leaseHolder(rig) !== clientId) {
					return json({ error: "not the controller" }, 403);
				} else {
					claimLease(rig, clientId); // renew
				}
				await impair();
				// dropped input is never resent — same as a lost UDP packet
				if (!shouldDrop())
					rig.input = body.joints
						? { joints: body.joints, at: Date.now() }
						: { axes: body.axes ?? {}, at: Date.now() };
				return json({ ok: true });
			}
			if (action === "/command") {
				const verb = body.verb ?? "";
				if (!isVerb(verb))
					return json({ error: `verb not allowed: ${verb}` }, 403);
				const spec = VERBS[verb];
				// Gating tiers: safety = anyone; owner = ownerKey (validated by
				// the RIG, not us — the key is opaque here and never logged);
				// everything else = the lease holder.
				if (spec.owner === true) {
					if (!body.ownerKey) return json({ error: "ownerKey required" }, 403);
				} else if (spec.safety !== true && leaseHolder(rig) !== clientId) {
					return json({ error: "not the controller" }, 403);
				}
				// args: allowlisted keys only, bounded size — a shallow pipe,
				// real validation is the rig's typed API.
				const args = body.args ?? {};
				const allowed = new Set(spec.args ?? []);
				for (const key of Object.keys(args))
					if (!allowed.has(key))
						return json({ error: `arg not allowed: ${key}` }, 403);
				if (JSON.stringify(args).length > MAX_ARGS_BYTES)
					return json({ error: "args too large" }, 413);
				if (!isOnline(rig)) return json({ error: "rig offline" }, 409);
				if (rig.pending.length >= MAX_PENDING)
					return json({ error: "command queue full" }, 429);
				rig.pending.push({
					verb,
					...(spec.args ? { args } : {}),
					...(spec.owner ? { ownerKey: body.ownerKey } : {}),
					holder: leaseHolder(rig),
					queuedAt: Date.now(),
				});
				return json({ ok: true, queued: verb });
			}
		}
	}

	const camMatch = path.match(/^\/cams\/([^/]+)\/([^/]+?)(\/snap)?$/);
	if (camMatch && request.method === "GET") {
		const rig = getRig(decodeURIComponent(camMatch[1]));
		if (!rig) return json({ error: "unknown rig" }, 404);
		const cam = decodeURIComponent(camMatch[2]);
		if (camMatch[3]) {
			const frame = rig.frames.get(cam);
			if (!frame) return json({ error: "no frame yet" }, 404);
			return new Response(frame.data as BodyInit, {
				headers: { "content-type": "image/jpeg", "cache-control": "no-store" },
			});
		}
		return mjpegResponse(rig, cam);
	}

	return json({ error: "not found" }, 404);
};
