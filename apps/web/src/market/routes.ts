/**
 * /api/market/* — session, verification, ledger, stats, evidence. Public
 * reads (the dashboard is the pitch); the only write is /verify. Mounted in
 * server.ts before the generic /api allowlist, outside /api/hub (no hub
 * token needed — verification is its own auth).
 */
import { randomBytes } from "node:crypto";
import { json } from "#/hub/routes";
import { DEV_AUTOVERIFY, HEDERA, marketEnabled, WORLD } from "#/market/config";
import {
	mintSessionValue,
	readSession,
	sessionSetCookie,
} from "#/market/session";
import {
	getRow,
	type LedgerRow,
	listBonds,
	listRows,
	marketStats,
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
		hederaAccountId: row.operator.hederaAccountId,
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

export const handleMarketRequest = async (
	request: Request,
	url: URL,
): Promise<Response> => {
	const path = url.pathname.slice("/api/market".length) || "/";

	// reachable even when the market is off so the UI can ask one question
	if (path === "/session" && request.method === "GET") {
		if (!marketEnabled()) return json({ marketMode: false, verified: false });
		ensureWorker();
		const session = readSession(request);
		if (session !== null)
			return json({
				marketMode: true,
				verified: true,
				nullifier: `${session.nullifier.slice(0, 12)}…`,
				devAutoverify: DEV_AUTOVERIFY,
			});
		if (DEV_AUTOVERIFY) {
			// local bring-up: mint a verified session on sight — the deny path
			// is rehearsed by simply not setting MARKET_DEV_AUTOVERIFY
			const nullifier = `dev-${randomBytes(8).toString("hex")}`;
			const value = mintSessionValue(nullifier);
			return new Response(
				JSON.stringify({
					marketMode: true,
					verified: true,
					nullifier: `${nullifier.slice(0, 12)}…`,
					devAutoverify: true,
				}),
				{
					headers: {
						"content-type": "application/json",
						"set-cookie": sessionSetCookie(value, url.protocol === "https:"),
					},
				},
			);
		}
		return json({
			marketMode: true,
			verified: false,
			devAutoverify: false,
			world: WORLD.configured
				? { appId: WORLD.appId, action: WORLD.action, preset: WORLD.preset }
				: null,
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
			// Identity Check must actually attest the requested attributes;
			// proof-of-human returns null here and passes
			if (result.identityAttested === false)
				return json({ error: "identity attributes not attested" }, 403);
			let accountId: string | null = null;
			if (HEDERA.configured) {
				const h = await import("#/market/hedera");
				accountId = (await h.ensureOperatorAccount(result.nullifier)).accountId;
			}
			const value = mintSessionValue(result.nullifier);
			return new Response(JSON.stringify({ verified: true, accountId }), {
				headers: {
					"content-type": "application/json",
					"set-cookie": sessionSetCookie(value, url.protocol === "https:"),
				},
			});
		} catch (e) {
			console.error("[market] verify failed:", e);
			return json({ error: "verification failed" }, 400);
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
				nullifier: `${b.nullifier.slice(0, 12)}…`,
				rig: b.rig,
				status: b.status,
				amountHbar: b.amountHbar,
				lockTxId: b.lockTxId,
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
