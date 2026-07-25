import { CheckCircle2, ListTodo, Play, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { TaskInfo } from "#/api/contract";
import { StatusBadge } from "#/components/status-badge";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent } from "#/components/ui/card";
import { Checkbox } from "#/components/ui/checkbox";
import { Label } from "#/components/ui/label";
import { Progress } from "#/components/ui/progress";
import type { RigSummary } from "#/lib/hub-api";

/**
 * The crowdsourcing surface: tasks the rig owner wants done. Each attempt is
 * one recorded episode; Success keeps it (labeled training data), Discard
 * throws the buffer away. `episodesDone` (derived rig-side from the dataset's
 * lerobot meta) turns "max 20 eps" into a real 13/20 progress loop.
 */

/** How long the chain waits for a finished attempt's episode to show up in
 * the count (recorder encode + the rig's 2s task advertisement) before it
 * concludes nothing was saved and disarms. */
const CHAIN_WAIT_MS = 20_000;

const collected = (task: TaskInfo): number => task.episodesDone ?? 0;
const isComplete = (task: TaskInfo): boolean =>
	task.maxEpisodes !== null && collected(task) >= task.maxEpisodes;

export function TaskPanel(props: {
	rig: RigSummary;
	iAmDriving: boolean;
	myAttempt: boolean;
	onStart: (taskId: string) => void;
	onFinish: (success: boolean) => void;
	busy: boolean;
}) {
	const { rig, iAmDriving, myAttempt, onStart, onFinish, busy } = props;
	const active = rig.tasks.filter((t) => t.active);
	const attempt = rig.attempt;
	const recording = rig.record?.active === true;

	// Ticks for the attempt countdown, and while the chain is armed so the
	// progress gate below re-evaluates without a second timer.
	const [now, setNow] = useState(() => Date.now());
	const [autoContinue, setAutoContinue] = useState(false);
	useEffect(() => {
		if (!attempt?.active && !autoContinue) return;
		const t = setInterval(() => setNow(Date.now()), 500);
		return () => clearInterval(t);
	}, [attempt?.active, autoContinue]);

	// --- the episode chain -------------------------------------------------
	// Collecting 20 episodes is 20 attempts; without this the operator clicks
	// Start 20 times. This panel stays mounted across an attempt, so plain
	// component state is enough state.
	//
	// The chain advances on PROGRESS (a saved episode), never on "an attempt
	// ended". A discarded attempt saves nothing, and a failed one (camera
	// unplugged mid-session, driver crash) publishes an attemptId and then
	// closes itself — keying the guard on attempt identity re-fired every ~9s
	// forever, rewriting attempts.json each round. Waiting for the episode
	// count to actually rise also removes the race at the finish line: the
	// chain can no longer start one past the quota while the count is stale.
	const [chainTaskId, setChainTaskId] = useState<string | null>(null);
	const chainTask = active.find((t) => t.id === chainTaskId);
	/** episodes collected when the chain's current attempt began */
	const chainBase = useRef<number | null>(null);
	/** when we started waiting for that attempt's episode to land */
	const waitingSince = useRef<number | null>(null);

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
		if (isComplete(chainTask)) {
			setAutoContinue(false);
			toast.success(
				`${chainTask.title} — ${collected(chainTask)} episodes, done`,
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
		now,
		onStart,
	]);

	const autoContinueToggle = (
		<div className="flex items-center gap-2">
			<Checkbox
				id="auto-continue"
				checked={autoContinue}
				onCheckedChange={(v) => setAutoContinue(v === true)}
			/>
			<Label
				htmlFor="auto-continue"
				className="text-muted-foreground font-normal"
			>
				auto-start the next attempt (until the task is complete)
			</Label>
		</div>
	);

	if (active.length === 0 && !attempt?.active) return null;

	if (attempt?.active) {
		const elapsed = attempt.startedAt
			? Math.max(0, (now - Date.parse(attempt.startedAt)) / 1000)
			: 0;
		const remaining = attempt.episodeSeconds
			? Math.max(0, attempt.episodeSeconds - elapsed)
			: null;
		return (
			<Card className="border-primary/40">
				<CardContent className="flex flex-col gap-3">
					<div className="flex flex-wrap items-center gap-3">
						<Badge variant={recording ? "destructive" : "secondary"}>
							{recording ? "● REC" : (rig.record?.phase ?? "starting…")}
						</Badge>
						<span className="font-medium">{attempt.taskTitle}</span>
						<span className="font-mono text-xs text-muted-foreground">
							{attempt.operator} ·{" "}
							{remaining !== null ? `${remaining.toFixed(0)}s left` : ""}
						</span>
					</div>
					{myAttempt ? (
						<>
							<div className="flex gap-2">
								<Button
									size="sm"
									onClick={() => onFinish(true)}
									disabled={busy}
								>
									<CheckCircle2 />
									Success — keep episode
								</Button>
								<Button
									size="sm"
									variant="outline"
									onClick={() => onFinish(false)}
									disabled={busy}
								>
									<XCircle />
									Discard
								</Button>
							</div>
							{autoContinueToggle}
						</>
					) : (
						<p className="text-sm text-muted-foreground">
							{attempt.operator} is attempting this task.
						</p>
					)}
				</CardContent>
			</Card>
		);
	}

	return (
		<Card>
			<CardContent className="flex flex-col gap-3">
				<div className="flex items-center gap-2 font-medium">
					<ListTodo className="size-4 text-muted-foreground" />
					Tasks on this rig
				</div>
				{active.map((task) => {
					const done = collected(task);
					const complete = isComplete(task);
					return (
						<div
							key={task.id}
							className="flex flex-wrap items-center justify-between gap-2 rounded border p-3"
						>
							<div className="min-w-0">
								<div className="font-medium">{task.title}</div>
								<div className="text-sm text-muted-foreground">
									{task.instructions}
								</div>
								<div className="mt-1 font-mono text-xs text-muted-foreground">
									{task.repoName} · {task.episodeSeconds}s episode
								</div>
								{task.maxEpisodes !== null ? (
									<div className="mt-2 flex items-center gap-2">
										<Progress
											value={Math.min(100, (done / task.maxEpisodes) * 100)}
											className="w-32"
										/>
										<span className="font-mono text-xs tabular-nums text-muted-foreground">
											{done}/{task.maxEpisodes}
										</span>
									</div>
								) : (
									<div className="mt-1 font-mono text-xs text-muted-foreground">
										{done} eps collected
									</div>
								)}
							</div>
							<div className="flex items-center gap-2">
								{/* the rig hard-blocks a start past the quota too — this is
								    just honest UI */}
								{complete && (
									<StatusBadge tone="success">complete ✓</StatusBadge>
								)}
								<Button
									size="sm"
									onClick={() => start(task.id)}
									disabled={!iAmDriving || recording || busy || complete}
									title={
										iAmDriving ? undefined : "Take control first, then attempt"
									}
								>
									<Play />
									{task.maxEpisodes !== null
										? `Start attempt (${Math.min(done + 1, task.maxEpisodes)}/${task.maxEpisodes})`
										: "Start attempt"}
								</Button>
							</div>
						</div>
					);
				})}
				{/* also here, not just on the active-attempt card: between attempts
				    that card is unmounted, and a chain you cannot switch off is
				    worse than one you have to re-arm. */}
				{chainTaskId !== null && iAmDriving && autoContinueToggle}
			</CardContent>
		</Card>
	);
}
