/**
 * Rig-agent configuration — resolved from env at boot. Server-side only
 * (reads process.env). The web app has exactly one role now (the hub);
 * these are consumed by the headless agent entry (`src/agent.ts`).
 */
import * as os from "node:os";
import { DEFAULT_HUB } from "#/lib/constants";

/** Hub to dial. Defaults to the deployed instance so `bun run agent` works
 * with zero config; HUB_URL overrides (dev scripts point it at localhost). */
export const HUB_URL = process.env.HUB_URL || DEFAULT_HUB;

/** Rig names travel in URL paths — keep them tame. Hostname beats a shared
 * "local-rig" default: two friends on one hub must not collide. */
const hostName = os
	.hostname()
	.split(".")[0]
	.toLowerCase()
	.replace(/[^a-z0-9-]/g, "-");
export const RIG_NAME = process.env.RIG_NAME ?? (hostName || "local-rig");

/** Hub shared secret. Unset = open (loopback dev). */
export const HUB_TOKEN = process.env.HUB_TOKEN ?? "";
