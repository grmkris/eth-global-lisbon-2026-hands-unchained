import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { TaskInfo } from "#/api/contract";
import type { RigSummary } from "#/lib/hub-api";
import type { TaskProgress } from "#/market/market-api";

/** How long the chain waits for a finished attempt's episode to show up in
 * the count (recorder encode + the rig's 2s task advertisement) before it
 * concludes nothing was saved and disarms. */
const CHAIN_WAIT_MS = 20_000;

/** what the recorder wrote — derived rig-side from the dataset's lerobot meta */
export const collected = (task: TaskInfo): number => task.episodesDone ?? 0;

/**
 * Episodes that will actually SHIP: what the recorder wrote, minus what the
 * referee threw out (they are dropped at publish). Recorded-minus-rejected
 * rather than a raw pass count, so episodes recorded before the market existed
 * still count — only a verdict we hold, and that failed, subtracts.
 *
 * The rig's own quota gate does the same arithmetic with the same number,
 * stamped onto attempt_start by the hub — so "keep going" here and "task
 * complete" there can never disagree.
 */
export const keptOf = (
	task: TaskInfo,
	progress: TaskProgress | null,
): number => {
	const verdicts = progress?.tasks[task.id];
	return verdicts
		? Math.max(0, collected(task) - verdicts.failed)
		: collected(task);
};

export const completeNow = (
	task: TaskInfo,
	progress: TaskProgress | null,
): boolean =>
	task.maxEpisodes !== null && keptOf(task, progress) >= task.maxEpisodes;

export interface AttemptChain {
	/** start an attempt AND arm the chain's bookkeeping for that task */
	start: (taskId: string) => void;
	autoContinue: boolean;
	setAutoContinue: (on: boolean) => void;
	/** the task the chain is following, null until something starts through it */
	chainTaskId: string | null;
}

/**
 * The episode chain: collecting 20 episodes is 20 attempts, and without this
 * the operator clicks Start twenty times.
 *
 * Lifted out of TaskPanel because the live-attempt controls now live under the
 * camera (components/attempt-bar.tsx) while the task list stays in the rail —
 * two components, one piece of state, so it belongs to the route. Precedent:
 * market/use-slot.ts. The logic below is unchanged; the comments are the
 * reasons it is shaped this way.
 *
 * The chain advances on PROGRESS (a saved episode), never on "an attempt
 * ended". A discarded attempt saves nothing, and a failed one (camera
 * unplugged mid-session, driver crash) publishes an attemptId and then
 * closes itself — keying the guard on attempt identity re-fired every ~9s
 * forever, rewriting attempts.json each round. Waiting for the episode
 * count to actually rise also removes the race at the finish line: the
 * chain can no longer start one past the quota while the count is stale.
 */
export function useAttemptChain({
	rig,
	iAmDriving,
	progress,
	onStart,
}: {
	rig: RigSummary | undefined;
	iAmDriving: boolean;
	progress: TaskProgress | null;
	onStart: (taskId: string) => void;
}): AttemptChain {
	const active = rig?.tasks.filter((t) => t.active) ?? [];
	const attempt = rig?.attempt;
	const recording = rig?.record?.active === true;

	const [autoContinue, setAutoContinue] = useState(false);
	const [chainTaskId, setChainTaskId] = useState<string | null>(null);
	const chainTask = active.find((t) => t.id === chainTaskId);
	/** episodes collected when the chain's current attempt began */
	const chainBase = useRef<number | null>(null);
	/** when we started waiting for that attempt's episode to land */
	const waitingSince = useRef<number | null>(null);

	// Ticks the effect below so the CHAIN_WAIT_MS bail-out can fire while
	// nothing else about the rig changes.
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!attempt?.active && !autoContinue) return;
		const t = setInterval(() => setNow(Date.now()), 500);
		return () => clearInterval(t);
	}, [attempt?.active, autoContinue]);

	const start = (taskId: string) => {
		const task = active.find((t) => t.id === taskId);
		setChainTaskId(taskId);
		chainBase.current = task ? collected(task) : 0;
		waitingSince.current = null;
		onStart(taskId);
	};

	// `now` (the 500ms ticker above) is deliberately a TRIGGER, not a read: the
	// body calls Date.now() directly, so biome sees the dep as unused. Dropping it
	// would leave the effect re-running only when an attempt/recording flag flips,
	// and the CHAIN_WAIT_MS bail-out below would never fire — auto-continue would
	// hang silently after an attempt that saved no episode, which is the exact
	// failure that timeout exists to report.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `now` is a ticker that must re-run this effect so the CHAIN_WAIT_MS timeout can fire
	useEffect(() => {
		if (!autoContinue || !iAmDriving || chainTask === undefined) return;
		// the recorder refuses a start while its session closes (video encoding
		// keeps `recording` true for a beat — exactly the gate we want)
		if (attempt?.active || recording) {
			waitingSince.current = null;
			return;
		}
		if (completeNow(chainTask, progress)) {
			setAutoContinue(false);
			toast.success(
				`${chainTask.title} — ${keptOf(chainTask, progress)} episodes, done`,
			);
			return;
		}
		const base = chainBase.current;
		if (base === null) return; // nothing started through this panel yet
		if (collected(chainTask) > base) {
			chainBase.current = collected(chainTask);
			waitingSince.current = null;
			onStart(chainTask.id);
			return;
		}
		// No episode yet — it may still be encoding, or the advertisement (2s
		// rig refresh) may not have landed. Wait, but never forever: a discard
		// or a failure never produces one.
		waitingSince.current ??= Date.now();
		if (Date.now() - waitingSince.current > CHAIN_WAIT_MS) {
			waitingSince.current = null;
			setAutoContinue(false);
			toast.info("auto-continue stopped — the last attempt saved no episode");
		}
	}, [
		autoContinue,
		iAmDriving,
		chainTask,
		attempt?.active,
		recording,
		progress,
		now,
		onStart,
	]);

	return { start, autoContinue, setAutoContinue, chainTaskId };
}
