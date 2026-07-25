/**
 * Rig-agent configuration — resolved from env at boot. Server-side only
 * (reads process.env). The web app has exactly one role now (the hub);
 * these are consumed by the headless agent entry (`src/agent.ts`).
 */
export const HUB_URL = process.env.HUB_URL;
export const RIG_NAME = process.env.RIG_NAME ?? "local-rig";
/** Hub shared secret. Unset = open (loopback dev). */
export const HUB_TOKEN = process.env.HUB_TOKEN ?? "";
