/**
 * Isolated episode-measurement smoke test — the evidence the referee grades on.
 *
 *   cd apps/web
 *   bun scripts/smoke-episode-motion.ts <hfUser>/<repoName>
 *   bun scripts/smoke-episode-motion.ts                      # every local dataset
 *
 * Read-only: it only reads the local lerobot cache, so it is safe to run while
 * a rig is recording.
 *
 * This exists because the reader used to hardcode `data/chunk-000/file-000.
 * parquet`, and lerobot 0.6.0 opens a NEW data file per record session. Every
 * attempt after a dataset's first one therefore measured the FIRST episode
 * ever recorded — a parked arm — or, once the `afterIndex` guard rejected that
 * stale index, measured nothing at all and the referee read the absence as
 * fraud. If this script reports the newest episode with the motion you just
 * drove, that whole class of bug is gone.
 */
export {};
import * as fs from "node:fs/promises";
import * as os from "node:os";

const { readEpisodeMotion, latestEpisodeIndex } = await import(
	"#/api/services/episode-motion"
);

const LEROBOT_CACHE = `${os.homedir()}/.cache/huggingface/lerobot`;

/** Every `<owner>/<name>` under the cache that actually holds a dataset. */
const allRepoIds = async (): Promise<Array<string>> => {
	const owners = await fs.readdir(LEROBOT_CACHE).catch(() => [] as string[]);
	const repos: Array<string> = [];
	for (const owner of owners) {
		const names = await fs
			.readdir(`${LEROBOT_CACHE}/${owner}`)
			.catch(() => [] as string[]);
		for (const name of names)
			if (
				await fs
					.stat(`${LEROBOT_CACHE}/${owner}/${name}/meta/info.json`)
					.then(() => true)
					.catch(() => false)
			)
				repos.push(`${owner}/${name}`);
	}
	return repos.sort();
};

const repoIds =
	process.argv.length > 2 ? process.argv.slice(2) : await allRepoIds();

if (repoIds.length === 0) {
	console.log(`no lerobot datasets under ${LEROBOT_CACHE}`);
	process.exit(0);
}

let bad = 0;
let skipped = 0;
for (const repoId of repoIds) {
	const latest = await latestEpisodeIndex(repoId);
	// meta but no data = a crashed session that never wrote an episode. Nothing
	// to measure is the right answer there, not a failure.
	if (latest === -1) {
		console.log(`${repoId}\n  no episodes on disk — skipped`);
		skipped += 1;
		continue;
	}
	const motion = await readEpisodeMotion(repoId, null);
	if (motion === null) {
		console.log(`${repoId}\n  latest=${latest}  NO MEASUREMENT`);
		bad += 1;
		continue;
	}
	// The whole point: the measurement must be OF the newest episode. A reader
	// that silently measures an older one is what produced the fraud verdicts.
	const ok = motion.episodeIndex === latest;
	if (!ok) bad += 1;
	console.log(
		`${repoId}\n  latest=${latest}  measured=${motion.episodeIndex} ${ok ? "ok" : "MISMATCH"}` +
			`  frames=${motion.frames}  jointPathDeg=${motion.jointPathDeg}` +
			`  stillFraction=${motion.stillFraction}  maxJointRangeDeg=${motion.maxJointRangeDeg}` +
			`  gripperCycles=${motion.gripperCycles}`,
	);
}

const checked = repoIds.length - skipped;
console.log(
	`\n${checked - bad}/${checked} datasets measured their newest episode` +
		(skipped > 0 ? ` (${skipped} empty, skipped)` : ""),
);
process.exit(bad > 0 ? 1 : 0);
