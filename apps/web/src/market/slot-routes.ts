/**
 * /api/market/slots/* — the booking surface.
 *
 * Split out of market/routes.ts because it is a whole subsystem, not another
 * endpoint. Mounted from there so the "market disabled -> 404" and
 * `ensureWorker()` behaviour stay in one place.
 *
 * The one write that matters is /unlock: it proves the operator knows the key
 * they committed to on chain, and then RELAYS `startSlot` with the hub's own
 * settler key. That relay is why the operator signs exactly one transaction in
 * the whole product — the booking — and why the 30 minutes starts when they
 * walk up rather than when they paid.
 */
import { timingSafeEqual } from "node:crypto";
import type { Address } from "viem";
import { json } from "#/hub/routes";
import { MIN_PIN_LENGTH, pinHashOf, rigIdOf, ZG_FAUCET } from "#/market/chain";
import { SLOTS } from "#/market/config";
import { readSession } from "#/market/session";
import {
	mintSlotValue,
	readSlotToken,
	slotClearCookie,
	slotSetCookie,
} from "#/market/slot-session";
import {
	cachedRig,
	clearPinAttempts,
	liveSlot,
	notePinAttempt,
	noteSlotClient,
	pendingSlot,
	pinAttemptAllowed,
	refreshRig,
	remainingMs,
} from "#/market/slots";
import { listRows } from "#/market/store";
import type { SlotView } from "#/market/zg-slots";

/** ethers behind a dynamic import — see the note in market/slots.ts. */
const chain = () => import("#/market/zg-slots");

const publicSlot = (slot: SlotView) => ({
	slotId: slot.slotId,
	operator: slot.operator,
	stakeOg: slot.stakeOg,
	startedAt: slot.startedAt,
	endAt: slot.endAt,
	remainingMs: remainingMs(slot),
	episodes: slot.episodes,
	passes: slot.passes,
	strikes: slot.strikes,
	creditsOg: slot.accruedOg,
	status: slot.status,
});

/** Episodes of THIS slot, as the operator's own ledger. */
const episodesOf = (slotId: number) =>
	listRows()
		.filter((r) => r.slotId === slotId)
		.map((r) => ({
			attemptId: r.id,
			episodeIndex: r.telemetry.episode?.episodeIndex ?? null,
			taskTitle: r.taskTitle,
			claimed: r.claimed,
			status: r.status,
			grade:
				r.grade === null
					? null
					: {
							score: r.grade.score,
							pass: r.grade.pass,
							provider: r.grade.provider,
							reason: r.grade.reason,
						},
			/** false = graded without 0G's signature, so it CANNOT have struck */
			attested: r.provenance?.slotAttested ?? null,
			slotTx: r.provenance?.slotTx ?? null,
			openedAt: r.openedAt,
			closedAt: r.closedAt,
		}))
		.sort((a, b) => a.openedAt - b.openedAt);

const rigDto = (rig: string) => {
	const cached = cachedRig(rig);
	const live = liveSlot(rig);
	const pending = pendingSlot(rig);
	return {
		rig,
		rigId: rigIdOf(rig, SLOTS.namespace),
		state: live
			? "live"
			: pending
				? "awaiting-start"
				: cached?.head?.status === "voided"
					? "voided"
					: "free",
		live: live ? publicSlot(live) : null,
		pending: pending ? publicSlot(pending) : null,
		queue: (cached?.queue ?? []).map((s, i) => ({
			slotId: s.slotId,
			operator: s.operator,
			position: i,
			bookedAt: s.bookedAt,
			status: s.status,
		})),
		/** the read is older than a poll interval — the UI says so rather than
		 * pretending a cached number is fresh */
		stale: cached ? Date.now() - cached.polledAt > 30_000 : true,
		error: cached?.error ?? null,
	};
};

export const handleSlotRequest = async (
	request: Request,
	url: URL,
	path: string,
	rigNames: ReadonlyArray<string>,
): Promise<Response | "pass"> => {
	if (!path.startsWith("/slots")) return "pass";
	const secure = url.protocol === "https:";

	if (!SLOTS.configured)
		return json({ configured: false, reason: "slots not configured" }, 501);

	// GET /slots — everything the lobby needs in one call
	if (path === "/slots" && request.method === "GET") {
		return json({
			configured: true,
			chainId: 16602,
			contract: SLOTS.address,
			namespace: SLOTS.namespace,
			required: SLOTS.required,
			faucet: ZG_FAUCET,
			minPinLength: MIN_PIN_LENGTH,
			params: await (await chain()).slotParams(),
			rigs: rigNames.map(rigDto),
		});
	}

	const match = path.match(/^\/slots\/([^/]+)(\/[a-z]+)?$/);
	if (!match) return "pass";
	const rig = decodeURIComponent(match[1]);
	const action = match[2] ?? "";

	// GET /slots/:rig — the drive page's single poll
	if (action === "" && request.method === "GET") {
		const cached = cachedRig(rig);
		if (cached === null || Date.now() - cached.polledAt > 5_000)
			await refreshRig(rig);
		const token = readSlotToken(request, rig);
		const live = liveSlot(rig);
		return json({
			...rigDto(rig),
			you: {
				hasToken: token !== null && token.slotId === live?.slotId,
				slotId: token?.slotId ?? null,
			},
			episodes: live ? episodesOf(live.slotId) : [],
		});
	}

	if (request.method !== "POST") return "pass";
	const body = (await request.json().catch(() => ({}))) as {
		pin?: string;
		txHash?: string;
		clientId?: string;
	};

	// POST /slots/:rig/booked — a cache hint after a wallet booking, so the UI
	// does not wait out a poll interval. Authoritative for nothing.
	if (action === "/booked") {
		await refreshRig(rig);
		return json(rigDto(rig));
	}

	if (action === "/lock") {
		return new Response(JSON.stringify({ ok: true }), {
			headers: {
				"content-type": "application/json",
				"set-cookie": slotClearCookie(rig, secure),
			},
		});
	}

	if (action !== "/unlock") return "pass";

	// --- the unlock ---------------------------------------------------------

	// World stays the first gate: no verified human, no slot control.
	if (readSession(request) === null)
		return json({ error: "verification required" }, 402);

	const pin = body.pin?.trim();
	if (!pin) return json({ error: "key required" }, 400);

	const throttleKey = `${rig}:${request.headers.get("x-forwarded-for") ?? "local"}`;
	if (!pinAttemptAllowed(throttleKey))
		return json({ error: "too many attempts — wait a minute" }, 429);

	await refreshRig(rig);
	const slot = liveSlot(rig) ?? pendingSlot(rig);
	if (slot === null) return json({ error: "no slot booked on this rig" }, 404);

	notePinAttempt(throttleKey);

	const expected = slot.pinHash.toLowerCase();
	const got = pinHashOf(slot.operator as Address, pin).toLowerCase();
	const ok =
		expected.length === got.length &&
		timingSafeEqual(Buffer.from(expected), Buffer.from(got));
	if (!ok) {
		// constant-ish delay so a wrong key cannot be told from a slow chain read
		await new Promise((r) => setTimeout(r, 300));
		return json({ error: "that key doesn't match this slot" }, 401);
	}
	clearPinAttempts(throttleKey);

	// Not started yet? Relay it. THIS is where the 30 minutes begins — and the
	// operator never sees a second wallet popup, because the hub pays for it.
	let started = slot;
	if (slot.status === "booked") {
		const tx = await (await chain()).startSlot(slot.slotId);
		if (tx === null)
			return json(
				{ error: "could not start your slot on-chain — try again" },
				502,
			);
		await refreshRig(rig);
		started = liveSlot(rig) ?? slot;
	}

	if (body.clientId) noteSlotClient(body.clientId, started.slotId);

	const value = mintSlotValue({
		slotId: started.slotId,
		rig,
		operator: started.operator,
		endAt: started.endAt,
	});
	return new Response(
		JSON.stringify({
			ok: true,
			slotId: started.slotId,
			startedAt: started.startedAt,
			endAt: started.endAt,
			remainingMs: remainingMs(started),
		}),
		{
			headers: {
				"content-type": "application/json",
				"set-cookie": slotSetCookie(
					value,
					rig,
					secure,
					remainingMs(started) + 60_000,
				),
			},
		},
	);
};
