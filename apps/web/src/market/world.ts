/**
 * World ID verification backend (IDKit 4.x / World ID 4.0).
 *
 * - getRpContext(): the browser widget needs a BACKEND-signed rp_context —
 *   signRequest() with the RP's ECDSA key from the Developer Portal.
 * - verifyWorldProof(): forward the IDKit result to the cloud verifier at
 *   POST https://developer.world.org/api/v4/verify/{rp_id}.
 *
 * Two things the docs make easy to get wrong, both fixed here:
 *
 * 1. `identity_attested` is NOT in the verify response. That response only
 *    carries {success, action, nullifier, created_at, environment, results,
 *    message}. The attestation lives on the IDKit CLIENT result, which the
 *    browser forwards to us — so we read it from the request payload, and
 *    only trust it alongside a verified proof.
 * 2. `environment` is caller-supplied, and a staging/simulator proof
 *    verifies happily against the staging verifier. Left unchecked, anyone
 *    could mint a session with a simulator proof. We pin it to WORLD_ENV
 *    and reject anything else.
 *
 * We run in `staging` by design (see docs/market/WORLD.md): the same
 * app_id/rp_id/signing key are registered in both registries, so this is an
 * env var, not a different app.
 */
import { signRequest } from "@worldcoin/idkit-core/signing";
import { WORLD } from "#/market/config";

export interface WorldVerification {
	nullifier: string;
	/** true/false when the credential carried an attestation; null when the
	 * flow doesn't produce one (proof-of-human, or a simulator that doesn't
	 * evaluate attributes). Never claim an age check on null. */
	identityAttested: boolean | null;
	environment: string;
}

const RP_CONTEXT_TTL_S = 300;

export const getRpContext = async (): Promise<Record<string, unknown>> => {
	if (!WORLD.rpId || !WORLD.rpKey)
		throw new Error("WORLD_RP_ID / WORLD_RP_KEY unset");
	const sig = signRequest({
		signingKeyHex: WORLD.rpKey,
		action: WORLD.action,
		ttl: RP_CONTEXT_TTL_S,
	});
	return {
		rp_id: WORLD.rpId,
		nonce: sig.nonce,
		created_at: sig.createdAt,
		expires_at: sig.expiresAt,
		signature: sig.sig,
	};
};

export const verifyWorldProof = async (
	payload: Record<string, unknown>,
): Promise<WorldVerification> => {
	if (!WORLD.rpId) throw new Error("WORLD_RP_ID unset");

	// Pin the environment before anything else: a simulator proof must not be
	// able to buy a session in an environment we didn't ask for.
	const claimedEnv =
		typeof payload.environment === "string" ? payload.environment : WORLD.env;
	if (claimedEnv !== WORLD.env)
		throw new Error(
			`proof environment ${claimedEnv} does not match this hub (${WORLD.env})`,
		);

	const res = await fetch(
		`https://developer.world.org/api/v4/verify/${WORLD.rpId}`,
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(WORLD.apiKey ? { authorization: `Bearer ${WORLD.apiKey}` } : {}),
			},
			body: JSON.stringify({
				...payload,
				action: WORLD.action,
				environment: WORLD.env,
			}),
		},
	);
	const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
	if (!res.ok)
		throw new Error(
			`world verify ${res.status}: ${JSON.stringify(body).slice(0, 300)}`,
		);

	const nullifier =
		(typeof body.nullifier === "string" && body.nullifier) ||
		(typeof body.nullifier_hash === "string" && body.nullifier_hash) ||
		null;
	if (!nullifier)
		throw new Error(
			`world verify returned no nullifier: ${JSON.stringify(body).slice(0, 300)}`,
		);

	// The verifier echoes the environment it actually checked against — trust
	// that over what the caller said.
	const environment =
		typeof body.environment === "string" ? body.environment : WORLD.env;
	if (environment !== WORLD.env)
		throw new Error(
			`world verified against ${environment}, expected ${WORLD.env}`,
		);

	return {
		nullifier,
		identityAttested: attestationFrom(payload),
		environment,
	};
};

/** Dig `identity_attested` out of the forwarded IDKit client result. IDKit
 * has moved its shape around between versions, so check the payload root and
 * one level of nesting rather than guessing a single path. */
const attestationFrom = (payload: Record<string, unknown>): boolean | null => {
	if (typeof payload.identity_attested === "boolean")
		return payload.identity_attested;
	for (const value of Object.values(payload)) {
		if (value !== null && typeof value === "object") {
			const nested = (value as Record<string, unknown>).identity_attested;
			if (typeof nested === "boolean") return nested;
		}
	}
	return null;
};
