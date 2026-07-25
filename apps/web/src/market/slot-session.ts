/**
 * Proof-of-unlock, as a cookie. Deliberately the same construction as
 * market/session.ts — `base64url(payload).expiresAt.hmac`, verified with
 * timingSafeEqual, no server-side store — so it survives a hub redeploy for the
 * same reason World sessions do.
 *
 * The cookie is a CLAIM, never the authority. Every use is re-checked against
 * the chain-backed mirror: a token whose slotId is not the rig's live slot is
 * refused even when the HMAC is perfect and unexpired. That is what covers a
 * third-strike void, an early settle, and clock skew between chain and hub.
 *
 * Multi-device is a feature, not a leak. Typing the key on a second device
 * mints a second valid token for the same slot; both are valid by construction
 * and control moves because the LEASE moves, not because a token was revoked.
 * A revocation list would be server state that dies on redeploy, which is the
 * exact failure class this design exists to avoid.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { slotCookieName } from "#/lib/constants";
import { MARKET_SECRET } from "#/market/config";

const b64url = (s: string): string =>
	Buffer.from(s, "utf8").toString("base64url");
const unb64url = (s: string): string =>
	Buffer.from(s, "base64url").toString("utf8");

const sign = (payload: string): string =>
	createHmac("sha256", MARKET_SECRET).update(payload).digest("base64url");

export interface SlotToken {
	slotId: number;
	rig: string;
	operator: string;
	expiresAt: number;
}

/** Expiry is clamped to the slot's own end — a token cannot outlive its slot. */
export const mintSlotValue = (input: {
	slotId: number;
	rig: string;
	operator: string;
	endAt: number;
}): string => {
	const exp = input.endAt * 1000;
	const payload = `${b64url(
		JSON.stringify({
			s: input.slotId,
			r: input.rig,
			o: input.operator,
		}),
	)}.${exp}`;
	return `${payload}.${sign(payload)}`;
};

export const parseSlotValue = (value: string): SlotToken | null => {
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
		const body = JSON.parse(unb64url(parts[0])) as {
			s: number;
			r: string;
			o: string;
		};
		return {
			slotId: body.s,
			rig: body.r,
			operator: body.o,
			expiresAt,
		};
	} catch {
		return null;
	}
};

/** Raw cookie-header parse, same approach as hub/auth.ts — no framework. */
export const readSlotToken = (
	request: Request,
	rig: string,
): SlotToken | null => {
	const cookies = request.headers.get("cookie");
	if (!cookies) return null;
	const name = slotCookieName(rig);
	for (const part of cookies.split(";")) {
		const [k, ...rest] = part.trim().split("=");
		if (k === name) return parseSlotValue(decodeURIComponent(rest.join("=")));
	}
	return null;
};

/** Secure only over https — mirrors market/session.ts so loopback dev works. */
export const slotSetCookie = (
	value: string,
	rig: string,
	secure: boolean,
	maxAgeMs: number,
): string =>
	`${slotCookieName(rig)}=${encodeURIComponent(value)}; Path=/; Max-Age=${Math.max(
		0,
		Math.floor(maxAgeMs / 1000),
	)}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;

/** Sent alongside any refusal, so a browser cannot keep rendering "you have
 * control" after the slot it is holding a token for has ended. */
export const slotClearCookie = (rig: string, secure: boolean): string =>
	`${slotCookieName(rig)}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${
		secure ? "; Secure" : ""
	}`;
