/**
 * Hub access: one shared secret, HUB_TOKEN. Unset (loopback dev) = open.
 *
 * Header for the rig link and API calls; cookie for <img> MJPEG streams and
 * the lease-release sendBeacon (neither can set headers); query param as a
 * curl-debug fallback only — never put it in UI-generated URLs, proxies log
 * query strings.
 *
 * Accepted limit: the token gates who may talk to the hub at all, not who is
 * who among token-holders — the lease clientId is still client-chosen. Fine
 * for a friend-group deployment; real identity is a later problem.
 */
import { HUB_TOKEN } from "#/api/config";
import { HUB_TOKEN_COOKIE } from "#/lib/constants";

export const hubAuthorized = (request: Request, url: URL): boolean => {
	if (!HUB_TOKEN) return true;
	if (request.headers.get("authorization") === `Bearer ${HUB_TOKEN}`)
		return true;
	const cookies = request.headers.get("cookie") ?? "";
	if (
		cookies
			.split(/;\s*/)
			.includes(`${HUB_TOKEN_COOKIE}=${encodeURIComponent(HUB_TOKEN)}`)
	)
		return true;
	return url.searchParams.get("token") === HUB_TOKEN;
};
