/** Client-safe shared literals (imported by both browser code and the server). */

/** Cookie carrying the hub token — exists because <img> MJPEG streams and the
 * lease-release sendBeacon cannot set headers. Read by hub/auth.ts, written by
 * lib/hub-api.ts. */
export const HUB_TOKEN_COOKIE = "lab_hub_token";
