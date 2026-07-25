/**
 * World ID verification backend (IDKit 4.x / World ID 4.0):
 * - getRpContext(): the browser widget needs a BACKEND-signed rp_context —
 *   signRequest() with the RP's ECDSA key from the Developer Portal.
 * - verifyWorldProof(): forward the IDKit result to the cloud verifier at
 *   POST https://developer.world.org/api/v4/verify/{rp_id}; extract the
 *   `nullifier` (v4 name — NOT nullifier_hash) and `identity_attested`
 *   (Identity Check preset only; null for proof-of-human).
 *
 * The preset (identity-check: minimum_age 18 + liveness / proof-of-human
 * fallback) is chosen client-side from /api/market/config — WORLD_PRESET
 * flips it with zero code changes if the Identity Check preview isn't
 * granted at the booth.
 */
import { signRequest } from "@worldcoin/idkit-core/signing";
import { WORLD } from "#/market/config";

export interface WorldVerification {
	nullifier: string;
	identityAttested: boolean | null;
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
	const res = await fetch(
		`https://developer.world.org/api/v4/verify/${WORLD.rpId}`,
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(WORLD.apiKey ? { authorization: `Bearer ${WORLD.apiKey}` } : {}),
			},
			body: JSON.stringify({ ...payload, action: WORLD.action }),
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
	return {
		nullifier,
		identityAttested:
			typeof body.identity_attested === "boolean"
				? body.identity_attested
				: null,
	};
};
