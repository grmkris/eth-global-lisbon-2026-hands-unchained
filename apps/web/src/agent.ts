/**
 * Headless rig agent — the ENTIRE on-machine footprint of a rig:
 * the python driver (spawned lazily) + the outbound hub link. No vite, no
 * UI, no HTTP server, NO LISTENING PORT AT ALL — the rig link calls the
 * typed API in-process (apiHandler is just a function) and everything else
 * dials out. Run with plain bun:
 *
 *   HUB_URL=https://<hub> RIG_NAME=my-arm LAB_AUTOCONNECT=real bun src/agent.ts
 *
 * All UI lives on the hub — owners manage this rig (cameras, record,
 * tasks, trainings) from its drive page with the owner key printed below.
 */
import { HUB_URL, RIG_NAME } from "#/api/config";
import { startRigLink } from "#/rig/link";

if (!HUB_URL) {
	console.error(
		"agent: HUB_URL is required (e.g. HUB_URL=https://<hub>.up.railway.app)",
	);
	process.exit(1);
}

console.error(
	`[agent] ${RIG_NAME} -> ${HUB_URL} (headless: no UI, no listening port)`,
);
startRigLink({
	hubUrl: HUB_URL,
	rigName: RIG_NAME,
	autoConnect: process.env.LAB_AUTOCONNECT,
	token: process.env.HUB_TOKEN,
});
