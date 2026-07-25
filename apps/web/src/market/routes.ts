/**
 * /api/market/* — session, verification, ledger, stats, evidence. Public
 * reads (the dashboard is the pitch); the only write is /verify. Mounted in
 * server.ts before the generic /api allowlist, outside /api/hub (no hub
 * token needed — verification is its own auth).
 */
import { createHash } from "node:crypto";
import { json } from "#/hub/routes";
import { listRigs } from "#/hub/store";
import {
	BOND_HBAR,
	BONUS_HBAR,
	DEV_AUTOVERIFY,
	HEDERA,
	HEDERA_EVM,
	marketEnabled,
	WORLD,
} from "#/market/config";
import {
	mintSessionValue,
	readSession,
	sessionSetCookie,
} from "#/market/session";
import { handleSlotRequest } from "#/market/slot-routes";
import {
	earningsFor,
	failedEpisodeIndices,
	getBond,
	getRow,
	type LedgerRow,
	listBonds,
	listRows,
	marketStats,
	passedEpisodeCount,
	putBond,
	stakeAlreadyUsed,
} from "#/market/store";
import { ensureWorker } from "#/market/worker";

const rowSummary = (row: LedgerRow) => ({
	id: row.id,
	rig: row.rig,
	taskId: row.taskId,
	taskTitle: row.taskTitle,
	source: row.source,
	operator: {
		nullifier: row.operator.nullifier
			? `${row.operator.nullifier.slice(0, 12)}…`
			: null,
		evmAddress: row.operator.evmAddress,
	},
	claimed: row.claimed,
	telemetry: {
		...row.telemetry,
		durationS: Math.round(row.telemetry.durationS * 10) / 10,
		jointTravelDeg: Math.round(row.telemetry.jointTravelDeg),
		commandedMotion: Math.round(row.telemetry.commandedMotion),
	},
	episode: row.telemetry.episode,
	hasEvidence: row.evidence.frameJpeg !== null,
	grade: row.grade,
	payment: row.payment,
	provenance: row.provenance,
	status: row.status,
	openedAt: row.openedAt,
	closedAt: row.closedAt,
});

/** The escrow's EVM address is derived from a key we hold, so it needs no
 * network call — but it does need Hedera to be configured at all. */
const escrowAddressOrNull = async (): Promise<string | null> => {
	if (!HEDERA.configured) return null;
	try {
		const { escrowEvmAddress } = await import("#/market/hedera");
		return escrowEvmAddress();
	} catch {
		return null;
	}
};

export const handleMarketRequest = async (
	request: Request,
	url: URL,
): Promise<Response> => {
	const path = url.pathname.slice("/api/market".length) || "/";

	// The one question the UI asks on every page: am I allowed to drive, and
	// what is my money doing? Reachable even when the market is off.
	const worldConfig = WORLD.configured
		? {
				appId: WORLD.appId,
				action: WORLD.action,
				preset: WORLD.preset,
				env: WORLD.env,
				requirePresence: WORLD.requirePresence,
			}
		: null;
	const stakeConfig = {
		bondHbar: BOND_HBAR,
		bonusHbar: BONUS_HBAR,
		chainId: HEDERA_EVM.chainId,
		faucet: HEDERA_EVM.faucet,
	};

	if (path === "/session" && request.method === "GET") {
		if (!marketEnabled()) return json({ marketMode: false, verified: false });
		ensureWorker();

		const describe = async (
			nullifier: string,
			boundAddress: string | null = null,
		) => {
			const bond = getBond(nullifier);
			// what happened to their most recent attempt — without this the
			// operator finishes an attempt and has no idea whether a referee
			// is deliberating, they got paid, or they got slashed
			const mine = listRows().find((r) => r.operator.nullifier === nullifier);
			return {
				marketMode: true,
				verified: true,
				nullifier: `${nullifier.slice(0, 12)}…`,
				boundAddress,
				devAutoverify: DEV_AUTOVERIFY,
				world: worldConfig,
				stake: {
					...stakeConfig,
					escrowEvmAddress: await escrowAddressOrNull(),
					bond: bond
						? {
								evmAddress: bond.evmAddress,
								amountHbar: bond.amountHbar,
								stakeTxHash: bond.stakeTxHash,
								lockedAt: bond.lockedAt,
							}
						: null,
					earnedHbar: earningsFor(nullifier),
				},
				lastAttempt: mine
					? {
							id: mine.id,
							status: mine.status,
							claimed: mine.claimed,
							score: mine.grade?.score ?? null,
							pass: mine.grade?.pass ?? null,
							gradeProvider: mine.grade?.provider ?? null,
							reason: mine.grade?.reason ?? null,
							payoutTx: mine.payment?.txId ?? null,
							teeTxHash: mine.provenance?.teeTxHash ?? null,
						}
					: null,
			};
		};

		const session = readSession(request);
		if (session !== null)
			return json(await describe(session.nullifier, session.address));

		/**
		 * DEV_AUTOVERIFY used to mint a verified session RIGHT HERE, on a bare
		 * GET. That predates the wallet binding and is now actively harmful: a
		 * GET carries no address, so it minted a session that was verified and
		 * UNBOUND — which sails through the drive gate and then fails at the
		 * unlock with "verify again to bind your wallet", the one error the
		 * shortcut exists to avoid.
		 *
		 * The bypass now lives on POST /verify, which does carry an address. All
		 * this reports is that it is available, so the UI can offer the button.
		 */
		return json({
			marketMode: true,
			verified: false,
			devAutoverify: DEV_AUTOVERIFY,
			world: worldConfig,
			stake: { ...stakeConfig, escrowEvmAddress: await escrowAddressOrNull() },
		});
	}

	if (!marketEnabled()) return json({ error: "market disabled" }, 404);
	ensureWorker();

	if (path === "/verify" && request.method === "POST") {
		const body = (await request.json().catch(() => ({}))) as Record<
			string,
			unknown
		>;
		// Work out the address FIRST: it is pinned into the verification
		// request, so World rejects a proof that was not made for it.
		const claimed =
			typeof body.address === "string" &&
			/^0x[0-9a-fA-F]{40}$/.test(body.address)
				? body.address.toLowerCase()
				: null;

		/**
		 * The dev bypass, and the ONLY place it lives.
		 *
		 * Local UI work otherwise needs a phone and a QR scan on every page
		 * load. This skips World entirely — but it still demands a wallet, and
		 * still binds the session to it, so every gate downstream (the unlock's
		 * operator check, the slot ledger, the payout) behaves exactly as it
		 * does in production. A shortcut that produced a session real code
		 * rejects is worse than no shortcut at all, which is what the old one
		 * on GET /session was.
		 *
		 * Env-gated and off by default. NEVER set MARKET_DEV_AUTOVERIFY on a
		 * deployed hub — it makes "prove you're human" a formality.
		 */
		if (DEV_AUTOVERIFY) {
			if (claimed === null)
				return json({ error: "connect a wallet first" }, 400);
			// Deterministic in the address, so reconnecting the same wallet is
			// the same person — a random nullifier per click would let one
			// browser mint unlimited identities and make strike counts nonsense.
			const nullifier = `dev-${createHash("sha256")
				.update(claimed)
				.digest("hex")
				.slice(0, 24)}`;
			console.error(
				`[market] DEV_AUTOVERIFY: minted a session for ${claimed} with NO World proof`,
			);
			const value = mintSessionValue(nullifier, claimed);
			return new Response(
				JSON.stringify({
					verified: true,
					identityAttested: null,
					boundAddress: claimed,
				}),
				{
					headers: {
						"content-type": "application/json",
						"set-cookie": sessionSetCookie(value, url.protocol === "https:"),
					},
				},
			);
		}

		try {
			const { verifyWorldProof } = await import("#/market/world");
			const result = await verifyWorldProof(body, claimed);
			// Identity Check must actually attest the requested attributes.
			// null = the credential didn't carry an attestation (proof-of-human,
			// or a simulator that doesn't evaluate attributes) — allowed, but
			// we must not then claim an age check we never got.
			if (
				WORLD.preset === "identity-check" &&
				result.identityAttested === false
			)
				return json({ error: "identity attributes not attested" }, 403);
			// Bound above, and enforced by World's own verifier rather than by
			// us: identity and money now share one chain of custody instead of
			// a cookie sitting next to an unrelated address.
			const value = mintSessionValue(result.nullifier, claimed);
			return new Response(
				JSON.stringify({
					verified: true,
					identityAttested: result.identityAttested,
					boundAddress: claimed,
				}),
				{
					headers: {
						"content-type": "application/json",
						"set-cookie": sessionSetCookie(value, url.protocol === "https:"),
					},
				},
			);
		} catch (e) {
			console.error("[market] verify failed:", e);
			return json(
				{ error: e instanceof Error ? e.message : "verification failed" },
				400,
			);
		}
	}

	/**
	 * The operator posts the hash of a transaction THEY signed, moving their
	 * own HBAR into escrow. We verify it against the mirror node — we never
	 * hold their key, and a hash can only ever fund one stake.
	 */
	if (path === "/stake" && request.method === "POST") {
		const session = readSession(request);
		if (session === null) return json({ error: "verification required" }, 402);
		if (!HEDERA.configured)
			return json({ error: "payments not configured on this hub" }, 501);
		const body = (await request.json().catch(() => ({}))) as {
			txHash?: string;
		};
		const txHash = body.txHash?.trim();
		if (!txHash) return json({ error: "txHash required" }, 400);
		if (stakeAlreadyUsed(txHash))
			return json({ error: "that stake was already used" }, 409);
		if (getBond(session.nullifier))
			return json({ error: "you already have an active stake" }, 409);

		try {
			const { verifyStakeTx } = await import("#/market/hedera");
			const proof = await verifyStakeTx(txHash, BOND_HBAR);
			putBond({
				nullifier: session.nullifier,
				evmAddress: proof.from,
				stakeTxHash: txHash,
				status: "locked",
				settleTxId: null,
				amountHbar: proof.amountHbar,
				lockedAt: Date.now(),
				lastActiveAt: Date.now(),
			});
			console.error(
				`[market] stake accepted: ${proof.amountHbar} ℏ from ${proof.from}`,
			);
			return json({
				ok: true,
				evmAddress: proof.from,
				amountHbar: proof.amountHbar,
			});
		} catch (e) {
			return json(
				{ error: e instanceof Error ? e.message : "stake not verified" },
				400,
			);
		}
	}

	if (path === "/rp-context" && request.method === "GET") {
		try {
			const { getRpContext } = await import("#/market/world");
			return json(await getRpContext());
		} catch {
			return json({ error: "world verification not configured" }, 501);
		}
	}

	// The booking surface. Its own module — it is a subsystem, not a route.
	const slots = await handleSlotRequest(
		request,
		url,
		path,
		listRigs().map((r) => r.name),
	);
	if (slots !== "pass") return slots;

	if (path === "/ledger" && request.method === "GET")
		return json(listRows().slice(0, 100).map(rowSummary));

	/**
	 * GET /progress?rig=NAME — per task, how many recorded episodes actually
	 * survived the referee.
	 *
	 * The rig counts what it WROTE (`total_episodes` out of the lerobot meta),
	 * which is the right number for the recorder and the wrong one for the
	 * operator: "5/5 complete" made of three failures is a lie about the
	 * dataset. Only the hub holds the verdicts, so only the hub can say this.
	 */
	if (path === "/progress" && request.method === "GET") {
		const rigName = url.searchParams.get("rig") ?? "";
		const rig = listRigs().find((r) => r.name === rigName);
		if (!rig) return json({ tasks: {} });
		return json({
			tasks: Object.fromEntries(
				rig.tasks.map((t) => [
					t.id,
					{
						passed: passedEpisodeCount(rig.name, t.id),
						failed: failedEpisodeIndices(rig.name, new Set([t.id])).length,
					},
				]),
			),
		});
	}

	if (path === "/stats" && request.method === "GET")
		return json({
			...marketStats(),
			bonds: listBonds().map((b) => ({
				evmAddress: b.evmAddress,
				status: b.status,
				amountHbar: b.amountHbar,
				stakeTxHash: b.stakeTxHash,
				settleTxId: b.settleTxId,
			})),
		});

	const evidence = path.match(/^\/evidence\/([^/]+)$/);
	if (evidence && request.method === "GET") {
		const row = getRow(decodeURIComponent(evidence[1]));
		if (!row?.evidence.frameJpeg)
			return json({ error: "no evidence frame" }, 404);
		return new Response(new Uint8Array(row.evidence.frameJpeg), {
			headers: { "content-type": "image/jpeg", "cache-control": "no-store" },
		});
	}

	return json({ error: "unknown market route" }, 404);
};
