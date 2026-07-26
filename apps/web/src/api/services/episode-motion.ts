/**
 * What the arm ACTUALLY did, read back from the recorded episode.
 *
 * Everything else we had was a proxy: the hub's input odometer only sees
 * sources that send input over the network (a leader arm plugged into this
 * machine never does), and `rig.joints` is a frozen cache for the whole
 * recording because the recorder stops the teleop loop that emits it.
 *
 * The dataset on disk has no such blind spots. `observation.state` is the
 * follower's real position at 30 fps — the same rows that train the model —
 * so measuring it is both unforgeable by the operator and identical for
 * every drive source.
 *
 * Rig-side only: this reads the local lerobot cache.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";

const LEROBOT_CACHE = `${os.homedir()}/.cache/huggingface/lerobot`;

export interface EpisodeMotion {
	episodeIndex: number;
	frames: number;
	durationS: number;
	/** total path length summed over joints, degrees — the honest "how much
	 * did this arm actually move" number */
	jointPathDeg: number;
	/** widest single-joint excursion, degrees */
	maxJointRangeDeg: number;
	gripperCycles: number;
	/** share of frames where nothing moved — a parked arm scores ~1 */
	stillFraction: number;
}

/** Per-frame joint vector; lerobot writes these as plain number arrays. */
const stateOf = (row: Record<string, unknown>): Array<number> | null => {
	const v = row["observation.state"] ?? row.action;
	return Array.isArray(v) ? (v as Array<number>).map(Number) : null;
};

const num = (v: unknown): number => Number(v ?? 0);

/**
 * Every `data/chunk-NNN/file-NNN.parquet` in a dataset, in write order.
 *
 * This used to be a hardcoded `data/chunk-000/file-000.parquet`, which is a
 * path that only tells the truth about the FIRST episode a dataset ever had:
 * lerobot 0.6.0 opens a NEW data file per record session, and every attempt is
 * one session. Measured on a real rig dataset, `file-000` was a 17.6°/98%-still
 * parked arm while the episode the operator had just driven — five files
 * later — was 635° across 450 frames. Honest work was being graded as fraud.
 *
 * Names are zero-padded, so lexicographic order is write order. A dataset that
 * does not exist yet is an empty list, not an error: the first attempt on a
 * task legitimately has nothing to read.
 */
const dataFiles = async (root: string): Promise<Array<string>> => {
	const chunks = await fs
		.readdir(`${root}/data`)
		.then((names) => names.filter((n) => n.startsWith("chunk-")).sort())
		.catch(() => [] as Array<string>);
	const files: Array<string> = [];
	for (const chunk of chunks) {
		const names = await fs
			.readdir(`${root}/data/${chunk}`)
			.catch(() => [] as Array<string>);
		for (const name of names.sort())
			if (name.endsWith(".parquet"))
				files.push(`${root}/data/${chunk}/${name}`);
	}
	return files;
};

const readRows = async (
	path: string,
): Promise<Array<Record<string, unknown>>> =>
	(await parquetReadObjects({
		file: await asyncBufferFromFile(path),
	})) as Array<Record<string, unknown>>;

/**
 * Read the trajectory and reduce it to motion evidence. `episodeIndex: null`
 * means "whichever episode was written last", which is what an attempt just
 * produced — more robust than doing index arithmetic against the recorder's
 * saved counter. Returns null when the episode isn't on disk yet, which the
 * caller must treat as "unknown", never as "no motion".
 */
export const readEpisodeMotion = async (
	repoId: string,
	episodeIndex: number | null,
): Promise<EpisodeMotion | null> => {
	try {
		const files = await dataFiles(`${LEROBOT_CACHE}/${repoId}`);
		// Newest first: the episode an attempt just wrote is in the last file.
		let rows: Array<Record<string, unknown>> | null = null;
		let index = episodeIndex;
		for (let i = files.length - 1; i >= 0; i--) {
			const candidate = await readRows(files[i]);
			if (candidate.length === 0) continue;
			if (episodeIndex === null) {
				index = Math.max(...candidate.map((r) => num(r.episode_index)));
				rows = candidate;
				break;
			}
			if (candidate.some((r) => num(r.episode_index) === episodeIndex)) {
				rows = candidate;
				break;
			}
		}
		if (rows === null || index === null) return null;

		const mine = rows.filter((r) => num(r.episode_index) === index);
		if (mine.length === 0) return null;
		mine.sort((a, b) => num(a.frame_index) - num(b.frame_index));

		let jointPathDeg = 0;
		let still = 0;
		let gripperFlips = 0;
		let gripperSign: -1 | 0 | 1 = 0;
		const mins: Array<number> = [];
		const maxs: Array<number> = [];
		let previous: Array<number> | null = null;

		for (const row of mine) {
			const state = stateOf(row);
			if (state === null) continue;
			state.forEach((v, i) => {
				mins[i] = mins[i] === undefined ? v : Math.min(mins[i], v);
				maxs[i] = maxs[i] === undefined ? v : Math.max(maxs[i], v);
			});
			if (previous !== null) {
				let frameDelta = 0;
				for (let i = 0; i < state.length; i++)
					frameDelta += Math.abs(state[i] - (previous[i] ?? state[i]));
				jointPathDeg += frameDelta;
				if (frameDelta < 0.5) still += 1;
				// the gripper is the last joint on an SO-101
				const g = state.length - 1;
				const gd = state[g] - (previous[g] ?? state[g]);
				if (Math.abs(gd) >= 2) {
					const sign = gd > 0 ? 1 : -1;
					if (gripperSign !== 0 && sign !== gripperSign) gripperFlips += 1;
					gripperSign = sign;
				}
			}
			previous = state;
		}

		const first = num(mine[0].timestamp);
		const last = num(mine[mine.length - 1].timestamp);
		const ranges = maxs.map((m, i) => m - (mins[i] ?? m));

		return {
			episodeIndex: index,
			frames: mine.length,
			durationS: Math.max(0, last - first),
			jointPathDeg: Math.round(jointPathDeg * 10) / 10,
			maxJointRangeDeg: Math.round(Math.max(0, ...ranges) * 10) / 10,
			gripperCycles: Math.floor((gripperFlips + 1) / 2),
			stillFraction:
				mine.length > 1
					? Math.round((still / (mine.length - 1)) * 100) / 100
					: 1,
		};
	} catch (e) {
		// Unknown, not zero — but say so out loud. A silent catch is exactly how
		// a wrong parquet path spent five attempts impersonating "the operator
		// did nothing", and nothing anywhere said why.
		console.error(`[episode-motion] could not measure ${repoId}:`, e);
		return null;
	}
};

/** Highest episode index currently in the dataset, or -1 when there is none.
 * Sampled at attempt START so we can tell OUR episode from the ones already
 * on disk. */
export const latestEpisodeIndex = async (repoId: string): Promise<number> => {
	try {
		const files = await dataFiles(`${LEROBOT_CACHE}/${repoId}`);
		for (let i = files.length - 1; i >= 0; i--) {
			const rows = await readRows(files[i]);
			if (rows.length === 0) continue;
			return Math.max(...rows.map((r) => num(r.episode_index)));
		}
		return -1;
	} catch {
		return -1; // no dataset yet — the first episode will be index 0
	}
};

/**
 * The recorder flushes the parquet a beat AFTER it reports the session done,
 * so a single read right after "keep" finds nothing. Poll instead of guessing
 * a delay, and give up quietly — a missing measurement is unknown, and the
 * grader is built to say so rather than assume idleness.
 *
 * `afterIndex` is what makes the answer OURS. Without it this returned
 * whatever episode happened to be newest, so an attempt that saved nothing
 * silently inherited the previous operator's trajectory — two attempts in a
 * row reported byte-identical motion, which is how the bug surfaced.
 */
export const awaitEpisodeMotion = async (
	repoId: string,
	opts: { timeoutMs?: number; afterIndex?: number } = {},
): Promise<EpisodeMotion | null> => {
	const after = opts.afterIndex ?? -1;
	const deadline = Date.now() + (opts.timeoutMs ?? 20_000);
	while (Date.now() < deadline) {
		const motion = await readEpisodeMotion(repoId, null);
		if (motion !== null && motion.frames > 0 && motion.episodeIndex > after)
			return motion;
		await new Promise((r) => setTimeout(r, 1_000));
	}
	return null;
};
