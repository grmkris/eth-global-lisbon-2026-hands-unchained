/**
 * Verified-operator sessions. One cookie, HMAC-signed, bound to the World ID
 * NULLIFIER (not the clientId): clientId lives in per-tab sessionStorage while
 * the cookie is per-browser — a second tab must not re-verify. The interceptor
 * learns clientId→nullifier at claim time instead.
 *
 * Format: base64url(nullifier).expiresAtMs.hmac — no server-side session
 * store, so verification survives hub redeploys (the point of the design).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { MARKET_SESSION_COOKIE } from "#/lib/constants";
import { MARKET_SECRET } from "#/market/config";

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // outlives any demo day

const b64url = (s: string): string =>
	Buffer.from(s, "utf8").toString("base64url");
const unb64url = (s: string): string =>
	Buffer.from(s, "base64url").toString("utf8");

const sign = (payload: string): string =>
	createHmac("sha256", MARKET_SECRET).update(payload).digest("base64url");

export interface MarketSession {
	nullifier: string;
	expiresAt: number;
}

export const mintSessionValue = (nullifier: string): string => {
	const exp = Date.now() + SESSION_TTL_MS;
	const payload = `${b64url(nullifier)}.${exp}`;
	return `${payload}.${sign(payload)}`;
};

export const parseSessionValue = (value: string): MarketSession | null => {
	const parts = value.split(".");
	if (parts.length !== 3) return null;
	const payload = `${parts[0]}.${parts[1]}`;
	const expected = sign(payload);
	const got = parts[2];
	if (expected.length !== got.length) return null;
	if (!timingSafeEqual(Buffer.from(expected), Buffer.from(got))) return null;
	const expiresAt = Number(parts[1]);
	if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;
	try {
		return { nullifier: unb64url(parts[0]), expiresAt };
	} catch {
		return null;
	}
};

/** Raw cookie-header parse, same approach as hub/auth.ts — no framework. */
export const readSession = (request: Request): MarketSession | null => {
	const cookies = request.headers.get("cookie");
	if (!cookies) return null;
	for (const part of cookies.split(";")) {
		const [k, ...rest] = part.trim().split("=");
		if (k === MARKET_SESSION_COOKIE)
			return parseSessionValue(decodeURIComponent(rest.join("=")));
	}
	return null;
};

/** Secure only over https — mirrors the conditional in lib/hub-api.ts so
 * loopback dev (http://localhost) keeps working. */
export const sessionSetCookie = (value: string, secure: boolean): string =>
	`${MARKET_SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=${Math.floor(
		(24 * 60 * 60 * 1000) / 1000,
	)}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
