/**
 * Process-role configuration — resolved from env at boot. Server-side only
 * (reads process.env); the browser asks /api/mode.
 *
 * Two web roles: hub (deployed lobby/relay) and console (local lab tool).
 * The third thing that used to be a role — the headless rig — is now its own
 * entry (`src/agent.ts`, plain bun, no server at all).
 */
export type Role = "hub" | "console";

export const ROLE: Role = process.env.LAB_MODE === "hub" ? "hub" : "console";

export const HUB_URL = process.env.HUB_URL;
export const RIG_NAME = process.env.RIG_NAME ?? "local-rig";
/** Hub shared secret. Unset = open (loopback dev). */
export const HUB_TOKEN = process.env.HUB_TOKEN ?? "";
