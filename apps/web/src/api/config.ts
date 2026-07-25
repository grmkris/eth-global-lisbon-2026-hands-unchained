/**
 * Process-role configuration — one build, three roles, resolved from env at
 * boot. Server-side only (reads process.env); the browser asks /api/mode.
 */
export type Role = "hub" | "agent" | "console";

export const ROLE: Role =
	process.env.LAB_MODE === "hub"
		? "hub"
		: process.env.LAB_MODE === "agent"
			? "agent"
			: "console";

export const HUB_URL = process.env.HUB_URL;
export const RIG_NAME = process.env.RIG_NAME ?? "local-rig";
/** Hub shared secret. Unset = open (loopback dev). */
export const HUB_TOKEN = process.env.HUB_TOKEN ?? "";
