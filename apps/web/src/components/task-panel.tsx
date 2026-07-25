import { CheckCircle2, ListTodo, Play, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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

	// countdown from the attempt snapshot
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!attempt?.active) return;
		const t = setInterval(() => setNow(Date.now()), 500);
		return () => clearInterval(t);
	}, [attempt?.active]);

	// --- the episode chain -------------------------------------------------
	// Collecting 20 episodes is 20 attempts; without this the operator clicks
	// Start 20 times. This panel stays mounted across an attempt, so plain
	// component state is enough state.
	const [autoContinue, setAutoContinue] = useState(false);
	const [chainTaskId, setChainTaskId] = useState<string | null>(null);
	const chainTask = active.find((t) => t.id === chainTaskId);
	// which attempt we already chained from — the loop guard
	const chainedFrom = useRef<string | null>(null);
	const lastAttemptId = useRef<string | null>(null);
	const liveAttemptId = attempt?.active === true ? attempt.attemptId : null;
	useEffect(() => {
		if (liveAttemptId !== null) lastAttemptId.current = liveAttemptId;
	}, [liveAttemptId]);

	const start = (taskId: string) => {
		setChainTaskId(taskId);
		onStart(taskId);
	};

	useEffect(() => {
		if (!autoContinue || !iAmDriving || chainTask === undefined) return;
		// the recorder refuses a start while its session closes (video encoding
		// keeps `recording` true for a beat — exactly the gate we want)
		if (attempt?.active || recording || isComplete(chainTask)) return;
		// fire ONCE per finished attempt: if the verb still loses a race, the
		// error shows in lastCommandResult and the operator clicks Start —
		// a self-retrying chain that can't be turned off is worse.
		if (chainedFrom.current === lastAttemptId.current) return;
		chainedFrom.current = lastAttemptId.current;
		onStart(chainTask.id);
	}, [
		autoContinue,
		iAmDriving,
		chainTask,
		attempt?.active,
		recording,
		onStart,
	]);

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
			</CardContent>
		</Card>
	);
}
