/**
 * The rig owner key — ONE secret per rig, auto-generated at first boot,
 * printed to the rig terminal, stored in the sidecar. Owner-tier verbs relay
 * it opaquely through the hub; the RIG validates it (the portless agent's
 * link layer is its network boundary — the in-process API is unreachable
 * from outside). Lost key = delete .data/owner.json and restart.
 *
 * `OWNER_KEY` in the env overrides the sidecar, so a demo rig can be started
 * with a key you already have in the browser instead of copying a fresh hex
 * string out of the terminal every restart. It is deliberately NOT written to
 * disk: an env key is for the life of that process only, and must not
 * silently become the persisted key of a rig started later without it.
 * The sim launch scripts set a fixed one; the real-arm scripts do not, because
 * on a hub with no HUB_TOKEN this key is the only thing standing between a
 * passer-by and someone's physical arm.
 *
 * Plain module (not an Effect service) so both the Effect services and the
 * non-Effect rig link can use it.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";

const DATA_DIR = `${process.cwd()}/.data`;
const OWNER_FILE = `${DATA_DIR}/owner.json`;

const load = (): string => {
	const fromEnv = process.env.OWNER_KEY?.trim();
	if (fromEnv) return fromEnv;
	try {
		return (JSON.parse(fs.readFileSync(OWNER_FILE, "utf8")) as { key: string })
			.key;
	} catch {
		const key = crypto.randomBytes(16).toString("hex");
		fs.mkdirSync(DATA_DIR, { recursive: true });
		fs.writeFileSync(OWNER_FILE, JSON.stringify({ key }));
		return key;
	}
};

export const OWNER_KEY: string = load();
console.error(`[owner] rig owner key: ${OWNER_KEY}`);

export const isOwnerKey = (candidate: string): boolean => {
	const a = Buffer.from(candidate);
	const b = Buffer.from(OWNER_KEY);
	return a.length === b.length && crypto.timingSafeEqual(a, b);
};
