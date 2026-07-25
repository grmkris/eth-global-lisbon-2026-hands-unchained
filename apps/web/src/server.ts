import {
	createStartHandler,
	defaultStreamHandler,
} from "@tanstack/react-start/server";
import type { Server } from "bun";
import { apiHandler } from "#/api/live";
import { hubAuthorized } from "#/hub/auth";
import { handleHubRequest, json } from "#/hub/routes";
import { type WsData, websocketHandlers } from "#/hub/ws";
import { marketEnabled } from "#/market/config";
import { marketIntercept } from "#/market/interceptor";
import { handleMarketRequest } from "#/market/routes";

const startFetch = createStartHandler(defaultStreamHandler);

// The web app has exactly one role: the hub. Rigs are headless agents
// (`bun run agent`, src/agent.ts) that dial out — they serve nothing.
if (process.env.LAB_MODE)
	console.error(
		"LAB_MODE is gone — the web app is always the hub; rigs run `bun run agent`",
	);

// The hub serves ONLY these /api paths, read-only (an allowlist, not a
// deny-regex — hardware endpoints are rig-local and must not exist on a
// machine with no arm and no cameras; writes go through the rig verb pipe).
// Datasets/runs/hf read the HF Hub API here (local scans fail soft to empty).
const HUB_API_EXACT = new Set([
	"/api/health",
	"/api/docs",
	"/api/openapi.json",
]);
const HUB_API_PREFIX = ["/api/datasets", "/api/runs", "/api/hf"];
const hubServes = (pathname: string, method: string): boolean =>
	method === "GET" &&
	(HUB_API_EXACT.has(pathname) ||
		HUB_API_PREFIX.some((p) => pathname.startsWith(p)));

export default {
	// Bun honors PORT implicitly; explicit so the contract is visible (Railway).
	port: Number(process.env.PORT ?? 3000),
	hostname: "0.0.0.0",
	websocket: websocketHandlers,
	async fetch(request: Request, server?: Server<WsData>): Promise<Response> {
		const url = new URL(request.url);

		// Railway healthcheck target; the "mode" shape is a fossil kept stable.
		if (url.pathname === "/api/mode") return json({ mode: "hub" });

		// The input plane (see hub/ws.ts). Before the /api/hub/ routing below so
		// the upgrade is never handled as a normal request. `server` is absent
		// under vite dev (node http, not Bun.serve) — callers then fail to
		// connect and keep using the HTTP input mailbox, which is the point of
		// keeping that path alive.
		if (url.pathname === "/api/hub/ws") {
			if (!hubAuthorized(request, url))
				return json({ error: "unauthorized" }, 401);
			const role = url.searchParams.get("role");
			const name = url.searchParams.get("name");
			if ((role !== "rig" && role !== "leader") || !name)
				return json({ error: "role and name required" }, 400);
			if (server?.upgrade(request, { data: { role, name } }))
				// Bun requires returning nothing once the socket is taken over
				return undefined as unknown as Response;
			return json({ error: "websocket upgrade unavailable" }, 400);
		}

		// Hub relay — raw routes beside the typed contract. The market layer
		// (MARKET_MODE=1) gates lease acquisition and observes attempt verbs
		// here; disabled, it is a single boolean check.
		if (url.pathname.startsWith("/api/hub/")) {
			if (!hubAuthorized(request, url))
				return json({ error: "unauthorized" }, 401);
			if (marketEnabled()) {
				const gate = await marketIntercept(request, url);
				if (gate !== "pass") return gate;
			}
			return handleHubRequest(request, url);
		}

		// Market layer: session/verify/ledger/stats — public, own auth story
		// (World ID verification), reachable even when disabled so the UI can
		// ask one question and render as today.
		if (url.pathname.startsWith("/api/market/"))
			return handleMarketRequest(request, url);

		if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
			if (!hubServes(url.pathname, request.method))
				return json({ error: "read-only hub — use a rig's verb pipe" }, 404);
			return apiHandler(request);
		}

		// Production static assets. `bun dist/server/server.js` has no vite in
		// front of it, and TanStack Start ships no static middleware — the SSR
		// HTML references /assets/* that would otherwise 404. dist/client sits
		// beside dist/server, so resolve relative to the bundle.
		if (
			!import.meta.env.DEV &&
			url.pathname.startsWith("/assets/") &&
			!url.pathname.includes("..")
		) {
			const file = Bun.file(
				new URL(`../client${url.pathname}`, import.meta.url).pathname,
			);
			if (await file.exists())
				return new Response(file, {
					headers: { "cache-control": "public, max-age=31536000, immutable" },
				});
		}

		return startFetch(request);
	},
};
