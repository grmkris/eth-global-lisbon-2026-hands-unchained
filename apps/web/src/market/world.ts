/**
 * World ID verification backend — M4 fills these: rp_context signing for
 * IDKit 4.x and the forward to POST https://developer.world.org/api/v4/
 * verify/{rp_id} (returns `nullifier`, and `identity_attested` for the
 * Identity Check preset). Until then the only way to a session is
 * MARKET_DEV_AUTOVERIFY (local dev).
 */

export interface WorldVerification {
	nullifier: string;
	identityAttested: boolean | null;
}

export const getRpContext = async (): Promise<Record<string, unknown>> => {
	throw new Error("World rp-context not wired yet (M4)");
};

export const verifyWorldProof = async (
	_payload: Record<string, unknown>,
): Promise<WorldVerification> => {
	throw new Error("World verify not wired yet (M4)");
};
