/**
 * Latest lease holder as seen by the rig link — written every /link tick,
 * read by the attempts watcher (30s of no holder while recording = the
 * operator is gone, discard the partial episode).
 */
let state: { holder: string | null; at: number } = { holder: null, at: 0 };

export const setHolder = (holder: string | null): void => {
	state = { holder, at: Date.now() };
};

export const getHolder = (): { holder: string | null; at: number } => state;
