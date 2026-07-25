/**
 * /api/market/* — session, verification, ledger, stats, evidence. Public
 * reads (the dashboard is the pitch); the only write is /verify. Mounted in
 * server.ts before the generic /api allowlist, outside /api/hub (no hub
 * token needed — verification is its own auth).
 */
import { randomBytes } from "node:crypto";
import { json } from "#/hub/routes";
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
import {
	earningsFor,
	getBond,
	getRow,
	type LedgerRow,
	listBonds,
	listRows,
	marketStats,
	putBond,
	stakeAlreadyUsed,
} from "#/market/store";
import { ensureWorker } from "#/market/worker";

const rowSummary = (row: LedgerRow) => ({
	id: row.id,
	rig: row.rig,
	taskId: row.taskId,
	taskTitle: row.taskTitle,
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

		const describe = async (nullifier: string) => {
			const bond = getBond(nullifier);
			return {
				marketMode: true,
				verified: true,
				nullifier: `${nullifier.slice(0, 12)}…`,
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
			};
		};

		const session = readSession(request);
		if (session !== null) return json(await describe(session.nullifier));

		if (DEV_AUTOVERIFY) {
			// local bring-up: mint a verified session on sight — the deny path
			// is rehearsed by simply not setting MARKET_DEV_AUTOVERIFY
			const nullifier = `dev-${randomBytes(8).toString("hex")}`;
			const value = mintSessionValue(nullifier);
			return new Response(JSON.stringify(await describe(nullifier)), {
				headers: {
					"content-type": "application/json",
					"set-cookie": sessionSetCookie(value, url.protocol === "https:"),
				},
			});
		}
		return json({
			marketMode: true,
			verified: false,
			devAutoverify: false,
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
		try {
			const { verifyWorldProof } = await import("#/market/world");
			const result = await verifyWorldProof(body);
			// Identity Check must actually attest the requested attributes.
			// null = the credential didn't carry an attestation (proof-of-human,
			// or a simulator that doesn't evaluate attributes) — allowed, but
			// we must not then claim an age check we never got.
			if (
				WORLD.preset === "identity-check" &&
				result.identityAttested === false
			)
				return json({ error: "identity attributes not attested" }, 403);
			const value = mintSessionValue(result.nullifier);
			return new Response(
				JSON.stringify({
					verified: true,
					identityAttested: result.identityAttested,
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

	if (path === "/ledger" && request.method === "GET")
		return json(listRows().slice(0, 100).map(rowSummary));

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
