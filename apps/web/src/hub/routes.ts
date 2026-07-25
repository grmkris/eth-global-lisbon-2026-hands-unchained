/**
 * Hub endpoints — raw routes beside the typed HttpApi (same precedent as
 * /api/cams/*). Deliberately a narrow verb set rather than a general tunnel:
 * a guest must not be able to reach /api/record/start on someone's machine.
 */
import {
	claimLease,
	getRig,
	impair,
	impairment,
	isOnline,
	leaseHolder,
	listRigs,
	type Rig,
	releaseLease,
	setFrame,
	shouldDrop,
	sleep,
	upsertRig,
} from "./store";
import { isVerb, VERBS } from "./verbs";

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
	holder: leaseHolder(rig),
	linkMs: rig.linkMs,
	lastSeen: rig.lastSeen,
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
				await sleep(50);
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
		};
		if (!body.name) return json({ error: "name required" }, 400);
		const rig = upsertRig(body.name, {
			backend: body.backend,
			armState: body.armState,
			source: body.source,
			joints: body.joints ?? {},
			cams: body.cams ?? [],
			lastError: body.lastError ?? null,
			linkMs: body.linkMs ?? 0,
		});
		await impair();
		const commands = rig.pending.splice(0, rig.pending.length);
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
				if (leaseHolder(rig) !== clientId)
					return json({ error: "not the controller" }, 403);
				claimLease(rig, clientId); // renew
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
				// Safety verbs bypass the lease: anyone watching a rig misbehave
				// must be able to stop it, holder or not.
				if (VERBS[verb].safety !== true && leaseHolder(rig) !== clientId)
					return json({ error: "not the controller" }, 403);
				rig.pending.push({ verb });
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
