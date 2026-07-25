/**
 * The market gate + observer, sitting in server.ts between hub auth and hub
 * routing. Four rules:
 *
 * 1. GATE `/claim`: taking a rig requires a verified human (402 "verification
 *    required") AND — when slots are configured — a live slot on THIS rig that
 *    this browser holds the token for. Honest deny paths, one per missing thing.
 * 2. NO STEALING. `force: true` is refused while someone else's slot is live.
 *    Without this any verified operator could yank the arm mid-episode and the
 *    slot would mean nothing.
 * 3. OBSERVE `/command`: attempt_start opens a ledger row against the slot,
 *    attempt_finish closes it with their claim. This is the only place the hub
 *    sees verb + identity together.
 * 4. Never consume the request — hub/routes.ts reads the body after us, so
 *    everything here works on request.clone().
 *
 * Deliberately NOT gated: estop, teleop_stop, release and input. Bystander
 * safety and hand-back must never require a login, let alone a wallet.
 *
 * `/input` gets no check of its own and that is not an oversight: it is already
 * lease-gated, the lease is now slot-gated here, and the WebSocket input plane
 * (hub/ws.ts) never passes through this file at all — a rule enforced on one of
 * two transports would be theatre. The lease's hard-expiry clamp in
 * hub/store.ts is what actually holds the line, because `/input` renews the
 * lease on every packet without ever coming through here.
 */
import { json } from "#/hub/routes";
import { getRig, leaseHolder } from "#/hub/store";
import { marketEnabled, SLOTS } from "#/market/config";
import { startSampler } from "#/market/sampler";
import { readSession } from "#/market/session";
import { readSlotToken } from "#/market/slot-session";
import { liveSlot, noteSlotClient, pendingSlot } from "#/market/slots";
import { closeRow, getBond, noteClient, openRow } from "#/market/store";
import { ensureWorker } from "#/market/worker";

type Body = {
	clientId?: string;
	verb?: string;
	force?: boolean;
	args?: Record<string, unknown>;
};

/**
 * "May this request drive this rig?" — the whole slot policy, in one place so
 * /claim and attempt_start cannot drift apart.
 *
 * Returns the slot id to stamp on a row, or a Response to refuse with.
 */
const slotGate = (
	request: Request,
	rigName: string,
	body: Body,
): { slotId: number | null; slotChain: string | null } | Response => {
	if (!SLOTS.configured) return { slotId: null, slotChain: null };

	const live = liveSlot(rigName);
	if (live === null) {
		// Booked but never started: the slot exists, the clock has not started,
		// and telling them to book again would send them to buy a second one.
		// Staking normally starts it in the same breath, so reaching here means
		// the relay did not land — say what to press, not what to re-buy.
		const pending = pendingSlot(rigName);
		if (pending !== null)
			return json(
				{
					error: "press Take control to start your slot",
					slotId: pending.slotId,
				},
				402,
			);
		// Nobody has booked this rig. SLOT_REQUIRED decides whether that means
		// "free to drive" (the platform as it always was) or "book first".
		if (SLOTS.required)
			return json({ error: "book a slot to drive this rig" }, 402);
		return { slotId: null, slotChain: null };
	}

	const token = readSlotToken(request, rigName);
	// The cookie proves this browser unlocked the slot; the session proves
	// which wallet the human verified on. Both must agree with the chain, or a
	// verified human could drive on someone else's stake.
	const gateSession = readSession(request);
	if (
		gateSession !== null &&
		gateSession.address !== null &&
		gateSession.address.toLowerCase() !== live.operator.toLowerCase()
	)
		return json({ error: "this slot belongs to a different wallet" }, 403);
	if (token === null || token.slotId !== live.slotId)
		return json(
			{
				// A running slot this browser holds no token for: either it is
				// someone else's, or it is yours on another device.
				error: "this slot is open on another browser — press This is mine",
				slotId: live.slotId,
				endAt: live.endAt,
			},
			402,
		);

	// A valid token for the LIVE slot may take the lease from anyone, with or
	// without `force` — that is how control moves between the operator's own
	// devices. Everyone else is refused, force or not.
	if (body.clientId) noteSlotClient(body.clientId, live.slotId);
	// The chain has to ride along. Without it the row's slotChain stays null,
	// slotChain("") resolves to null in the worker, and recordEpisodeOnSlot is
	// never called — so no episode reaches the contract, no credits accrue and
	// a passing operator is never paid. The whole economic loop hung on this.
	return { slotId: live.slotId, slotChain: live.chainKey };
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
		// Legacy Hedera path: with no slot contract configured the bond is still
		// what buys the right to drive, so production is unchanged until the
		// day ZG_SLOT_MARKET_ADDRESS is set.
		if (!SLOTS.configured && getBond(session.nullifier) === null)
			return json({ error: "bond required" }, 402);
		const gate = slotGate(request, rigName, body);
		if (gate instanceof Response) return gate;
		if (body.clientId) noteClient(body.clientId, session.nullifier);
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
		// defense in depth: an attempt needs the session AND the slot, not just
		// the (gated) claim that preceded it
		if (session === null) return json({ error: "verification required" }, 402);
		const bond = SLOTS.configured ? null : getBond(session.nullifier);
		if (!SLOTS.configured && bond === null)
			return json({ error: "bond required" }, 402);
		const gate = slotGate(request, rigName, body);
		if (gate instanceof Response) return gate;
		noteClient(body.clientId, session.nullifier);
		const taskId =
			typeof body.args?.taskId === "string" ? body.args.taskId : null;
		const row = openRow({
			rig: rigName,
			taskId,
			clientId: body.clientId,
			evmAddress: bond?.evmAddress ?? liveSlot(rigName)?.operator ?? null,
			slotId: gate.slotId,
			slotChain: gate.slotChain,
		});
		startSampler(row);
	} else {
		// never deny a finish: refusing it would strand a live recording with no
		// way to close it
		const claimed = body.args?.success === true ? "success" : "discarded";
		closeRow(rigName, claimed);
	}
	return "pass";
};
