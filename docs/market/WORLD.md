# World — Identity Check Beta Test (Proof of Hands market layer)

**Track:** Identity Check Beta Test. **Why the attribute is necessary:**
operators remotely actuate a **physical robot arm**. That is machinery
operation with real liability — the market gates execution rights on (a)
**minimum_age: 18** (legal capacity to operate machinery and to be paid for
work) and (b) **require_user_presence** (a live human is at the controls
right now, not a replayed credential driving hardware). This is an
eligibility/abuse-prevention signal, not a login: an unverified browser can
watch every camera feed freely — it just cannot take the lease (HTTP 402)
or start paid attempts.

**Data minimization:** we request exactly one attribute (`minimum_age: 18`)
and keep exactly one value — the nullifier (one-way, per-action). No name,
no nationality, no document number ever reaches the hub; the nullifier also
derives the operator's payout account, so there is no secondary identity
store to leak.

## Integration

- Widget: `IDKitRequestWidget` (`@worldcoin/idkit@4.2.1`) in
  `apps/web/src/components/verify-gate.tsx`, preset
  `identityCheck({ attributes: [{ type: "minimum_age", value: 18 }] })`,
  `require_user_presence: true`, `allow_legacy_proofs: false`.
- rp_context: backend-signed per request (`signRequest` from
  `@worldcoin/idkit-core/signing`, TTL 300 s) — `GET /api/market/rp-context`.
- Verify: `POST /api/market/verify` forwards the result to
  `POST https://developer.world.org/api/v4/verify/{rp_id}`, requires
  `identity_attested === true`, extracts `nullifier`, mints an HttpOnly
  session cookie. Deny path: claiming a rig without it → **402**.
- Fallback (if the Identity Check preview is not granted):
  `WORLD_PRESET=proof-of-human` swaps the preset only — same widget, same
  verify endpoint, same nullifier semantics.

## Testing documentation

### Developer feedback (integration experience, Sat)

1. **The 3.0→4.0 split is the biggest doc hazard.** Half the search results
   (and LLM training data) describe `IDKitWidget` + `/api/v2/verify` +
   `nullifier_hash`; 4.x is `IDKitRequestWidget` + `/api/v4/verify/{rp_id}`
   + `nullifier` + a mandatory backend-signed `rp_context`. A prominent
   "which era am I reading" banner on every docs page would save hours.
2. **rp_context signing was the easy part** — `signRequest({signingKeyHex,
   action, ttl})` from `@worldcoin/idkit-core/signing` is self-contained and
   worked first try in Bun (no WASM needed server-side). Good design.
3. **Type-level friction:** `IDKitRequestWidgetProps` requires a `Preset`
   union instance; building the preset server-side and shipping it as JSON
   is not supported, so preset choice must be duplicated client-side (we
   ship a `preset` *name* from `/api/market/config` and call
   `identityCheck()`/`proofOfHuman()` in the browser). An
   `IDKit.presetFromJSON()` would let servers own policy.
4. **`@worldcoin/idkit-core` is not hoisted** as a transitive dep under bun
   workspaces — server code importing `/signing` needs it as a direct
   dependency. Worth a note in the install docs.
5. **The v4 verify response shape is under-documented** (which fields beyond
   `nullifier`/`identity_attested` are guaranteed?). We coded defensively.
6. **Identity Check preview gating:** "contact us" is a real speed bump in a
   36-hour hackathon; a self-serve sandbox flag on hackathon app ids would
   remove it.

### User feedback (booth testing)

<!-- Fill during Saturday-night testing with 3-5 booth visitors:
  - time-to-verified (target < 60 s from QR scan)
  - comprehension: did they understand WHAT was attested (18+) and what was
    NOT shared (name/document)? quote answers
  - consent friction: did anyone balk at the age attestation for a robot
    demo? drop-off count
  - liveness (require_user_presence) UX: retries needed?
  - device coverage: iOS/Android, World App versions
-->

## Demo beat

1. Incognito browser tries to take the rig → **402, arm stays locked** (the
   deny path is the feature).
2. Judge verifies on their own phone (18+, liveness) → lease granted →
   drives a real SO-101.
3. The same nullifier that unlocked the arm derives the Hedera account their
   HBAR lands on — identity → labor → payment, one chain of custody.
