/**
 * The market gate + observer, sitting in server.ts between hub auth and hub
 * routing. Three rules:
 *
 * 1. GATE `/claim`: taking a rig requires a verified-human session (402
 *    otherwise — the deny path IS a feature). Nothing else is gated: estop,
 *    teleop_stop, release and input stay open — bystander safety and
 *    hand-back must never require a login.
 * 2. OBSERVE `/command`: attempt_start opens a ledger row (+ locks the
 *    bond), attempt_finish closes it with the operator's claim. This is the
 *    only place the hub sees verb + identity together.
 * 3. Never consume the request — hub/routes.ts reads the body after us, so
 *    everything here works on request.clone().
 */

import { json } from "#/hub/routes";
import { getRig, leaseHolder } from "#/hub/store";
import { marketEnabled } from "#/market/config";
import { startSampler } from "#/market/sampler";
import { readSession } from "#/market/session";
import { closeRow, noteClient, openRow, touchBond } from "#/market/store";
import { ensureBondLocked, ensureWorker } from "#/market/worker";

type Body = {
	clientId?: string;
	verb?: string;
	args?: Record<string, unknown>;
};

export const marketIntercept = async (
	request: Request,
	url: URL,
): Promise<Response | "pass"> => {
	if (!marketEnabled() || request.method !== "POST") return "pass";
	const match = url.pathname.match(
		/^\/api\/hub\/rigs\/([^/]+)\/(claim|command)$/,
	);
	if (!match) return "pass";
	ensureWorker();

	const rigName = decodeURIComponent(match[1]);
	const action = match[2];
	const body = (await request
		.clone()
		.json()
		.catch(() => ({}))) as Body;
	const session = readSession(request);

	if (action === "claim") {
		if (session === null) return json({ error: "verification required" }, 402);
		if (body.clientId) {
			noteClient(body.clientId, session.nullifier);
			touchBond(session.nullifier, rigName);
		}
		return "pass";
	}

	// command: observe attempt verbs — but only ones the hub will accept,
	// or ghost rows appear for requests that 403 (not the controller).
	const verb = body.verb ?? "";
	if (verb !== "attempt_start" && verb !== "attempt_finish") return "pass";
	const rig = getRig(rigName);
	if (!rig || !body.clientId || leaseHolder(rig) !== body.clientId)
		return "pass"; // the hub is about to reject it; nothing to record

	if (verb === "attempt_start") {
		// defense in depth: attempts also require the verified session, not
		// just the (gated) claim that preceded it
		if (session === null) return json({ error: "verification required" }, 402);
		noteClient(body.clientId, session.nullifier);
		ensureBondLocked(body.clientId, rigName);
		const taskId =
			typeof body.args?.taskId === "string" ? body.args.taskId : null;
		const row = openRow({ rig: rigName, taskId, clientId: body.clientId });
		startSampler(row);
	} else {
		const claimed = body.args?.success === true ? "success" : "discarded";
		closeRow(rigName, claimed);
	}
	return "pass";
};
