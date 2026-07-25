import { useEffect, useRef, useState } from "react";
import type { RecordStatus } from "#/api/contract";

export type EpisodeClock =
	| { mode: "countdown"; remaining: number; duration: number; overrun: boolean }
	| { mode: "elapsed"; elapsed: number }
	| null;

/**
 * Client-interpolated phase clock. The server's RecordStatus carries no timing,
 * so we mark Date.now() whenever phase/episode changes in the 1 s poll and
 * render against the durations the form submitted. Accuracy is ±1 poll — the
 * phase pill stays the source of truth. If durations are unknown (page
 * reloaded mid-session) we count up instead: honest and restart-safe.
 */
export function useEpisodeClock(
	status: RecordStatus | undefined,
	durations: { episodeS: number; resetS: number } | null,
): EpisodeClock {
	const marker = useRef<{ key: string; at: number } | null>(null);
	const [now, setNow] = useState(() => Date.now());

	const active = status?.active ?? false;
	const phase = status?.phase ?? "idle";
	const key = `${phase}:${status?.episode ?? 0}`;

	if (active && marker.current?.key !== key) {
		marker.current = { key, at: Date.now() };
	}
	if (!active && marker.current !== null) {
		marker.current = null;
	}

	useEffect(() => {
		if (!active) return;
		const t = setInterval(() => setNow(Date.now()), 250);
		return () => clearInterval(t);
	}, [active]);

	if (!active || marker.current === null) return null;
	if (phase !== "recording" && phase !== "resetting") return null;

	const elapsed = Math.max(0, (now - marker.current.at) / 1000);
	const duration =
		durations === null
			? null
			: phase === "recording"
				? durations.episodeS
				: durations.resetS;

	if (duration === null) return { mode: "elapsed", elapsed };
	return {
		mode: "countdown",
		remaining: Math.max(0, duration - elapsed),
		duration,
		overrun: elapsed > duration,
	};
}

export const fmtClock = (seconds: number): string => {
	const s = Math.max(0, Math.round(seconds));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
