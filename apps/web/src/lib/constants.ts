/** Client-safe shared literals (imported by both browser code and the server). */

/** Cookie carrying the hub token — exists because <img> MJPEG streams and the
 * lease-release sendBeacon cannot set headers. Read by hub/auth.ts, written by
 * lib/hub-api.ts. */
export const HUB_TOKEN_COOKIE = "lab_hub_token";

/** The deployed hub — the zero-config default for agents and leader agents.
 * Mirrored in apps/driver/controller.py (python cannot import this). */
export const DEFAULT_HUB = "https://web-production-b5106.up.railway.app";

/** Verified-operator session (market layer). HttpOnly — written only by the
 * server on a successful World ID verification, read by market/session.ts. */
export const MARKET_SESSION_COOKIE = "pm_session";

/** Proof that this browser unlocked a slot with the operator's key. Per-RIG on
 * purpose: one shared cookie would silently drop the first rig's token when
 * someone unlocks a second one, which is an ordinary two-rig booth. Written by
 * market/slot-session.ts on a verified PIN. */
export const slotCookieName = (rig: string): string =>
	`pm_slot_${rig.replace(/[^A-Za-z0-9_-]/g, "_")}`;
