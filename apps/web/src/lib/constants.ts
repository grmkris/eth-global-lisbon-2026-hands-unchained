/** Client-safe shared literals (imported by both browser code and the server). */

/** Cookie carrying the hub token — exists because <img> MJPEG streams and the
 * lease-release sendBeacon cannot set headers. Read by hub/auth.ts, written by
 * lib/hub-api.ts. */
export const HUB_TOKEN_COOKIE = "lab_hub_token";

/** The deployed hub — the zero-config default for agents and leader agents.
 * Mirrored in apps/driver/controller.py (python cannot import this). */
export const DEFAULT_HUB = "https://web-production-b5106.up.railway.app";
