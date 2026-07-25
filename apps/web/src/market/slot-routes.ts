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
import { json } from "#/hub/routes";
import { rigIdOf, ZG_FAUCET } from "#/market/chain";
import { SLOTS, slotChain, slotChains } from "#/market/config";
import { readSession } from "#/market/session";
import {
	mintSlotValue,
	readSlotToken,
	slotClearCookie,
	slotSetCookie,
} from "#/market/slot-session";
import {
	allHeads,
	cachedRig,
	liveSlot,
	noteSlotClient,
	pendingSlot,
	refreshRig,
	remainingMs,
} from "#/market/slots";
import { listRows } from "#/market/store";
import type { SlotView } from "#/market/zg-slots";

/** ethers behind a dynamic import — see the note in market/slots.ts. */
const chain = () => import("#/market/zg-slots");

const publicSlot = (slot: SlotView) => ({
	chain: slot.chainKey,
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
	const voided = allHeads(rig).some((h) => h.status === "voided");
	return {
		rig,
		rigId: rigIdOf(rig, SLOTS.namespace),
		state: live
			? "live"
			: pending
				? "awaiting-start"
				: voided
					? "voided"
					: "free",
		live: live ? publicSlot(live) : null,
		pending: pending ? publicSlot(pending) : null,
		queue: (cached?.chains ?? []).flatMap((c) =>
			c.queue.map((s, i) => ({
				chain: c.chainKey,
				slotId: s.slotId,
				operator: s.operator,
				position: i,
				bookedAt: s.bookedAt,
				status: s.status,
			})),
		),
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
		const c = await chain();
		// Every chain the operator may put money on, each with its own params
		// read from ITS OWN contract — the stake is 0.05 OG on 0G and 0.5 HBAR
		// on Hedera, and nothing here should assume they match.
		const chains = await Promise.all(
			slotChains().map(async (sc) => ({
				key: sc.key,
				chainId: sc.chainId,
				label: sc.label,
				token: sc.token,
				contract: sc.address,
				faucet: sc.faucet,
				/** the contract reads 0G's registry itself, vs a pinned constant */
				liveSigner: sc.liveSigner,
				params: await c.slotParams(sc).catch(() => null),
			})),
		);
		return json({
			configured: true,
			namespace: SLOTS.namespace,
			required: SLOTS.required,
			faucet: ZG_FAUCET,
			chains,
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
		const hasToken = token !== null && token.slotId === live?.slotId;
		return json({
			...rigDto(rig),
			you: { hasToken, slotId: token?.slotId ?? null },
			// Only the holder sees their own episode ledger. Served to everyone it
			// reads as "this is my slot" in a browser that holds nothing — which
			// is exactly how it was reported: a second browser showing a
			// countdown, a stake and graded rows belonging to someone else.
			episodes: live && hasToken ? episodesOf(live.slotId) : [],
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
	const session = readSession(request);
	if (session === null) return json({ error: "verification required" }, 402);

	await refreshRig(rig);
	const slot = liveSlot(rig) ?? pendingSlot(rig);
	if (slot === null) return json({ error: "no slot booked on this rig" }, 404);

	/**
	 * THE WALLET IS THE KEY — there is no PIN.
	 *
	 * The old flow made you invent a string, commit its hash on chain and type
	 * it back to start the clock. That was a secret that could be forgotten,
	 * shoulder-surfed, or shared to hand your stake to a stranger, and it
	 * bought nothing the wallet doesn't already prove.
	 *
	 * The World proof is signed against the operator's address (World's own
	 * verifier rejects a mismatch), so a session bound to address X is proof
	 * that this browser belongs to the human who controls X. The chain says
	 * which address booked. Comparing the two is strictly stronger than any
	 * PIN, and it is invisible: nothing to type, nothing to lose.
	 */
	if (session.address === null)
		return json(
			{
				error:
					"verify again to bind your wallet — this slot opens for the wallet that booked it",
			},
			409,
		);
	if (session.address.toLowerCase() !== slot.operator.toLowerCase())
		return json({ error: "this slot belongs to a different wallet" }, 403);

	// Not started yet? Relay it. THIS is where the 30 minutes begins — and the
	// operator never sees a second wallet popup, because the hub pays for it.
	// SINGLE OCCUPANCY ACROSS CHAINS. Two people can book the same rig on two
	// different chains — neither contract can see the other — so the hub is the
	// only thing that can stop both clocks running. It refuses to relay the
	// second start; that operator can cancel for a full refund.
	const otherLive = liveSlot(rig);
	if (otherLive !== null && otherLive.slotId !== slot.slotId)
		return json(
			{
				error: `this rig is already held on ${otherLive.chainKey} until ${new Date(
					otherLive.endAt * 1000,
				).toLocaleTimeString()} — cancel your booking for a refund`,
			},
			409,
		);

	const sc = slotChain(slot.chainKey);
	if (sc === null) return json({ error: "unknown chain for this slot" }, 500);

	let started = slot;
	if (slot.status === "booked") {
		const tx = await (await chain()).startSlot(sc, slot.slotId);
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
