import { CheckCircle2, ListTodo, Play, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent } from "#/components/ui/card";
import type { RigSummary } from "#/lib/hub-api";

/**
 * The crowdsourcing surface: tasks the rig owner wants done. Each attempt is
 * one recorded episode; Success keeps it (labeled training data), Discard
 * throws the buffer away.
 */
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
						<div className="flex gap-2">
							<Button size="sm" onClick={() => onFinish(true)} disabled={busy}>
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
				{active.map((task) => (
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
								{task.maxEpisodes ? ` · max ${task.maxEpisodes} eps` : ""}
							</div>
						</div>
						<Button
							size="sm"
							onClick={() => onStart(task.id)}
							disabled={!iAmDriving || recording || busy}
							title={
								iAmDriving ? undefined : "Take control first, then attempt"
							}
						>
							<Play />
							Start attempt
						</Button>
					</div>
				))}
			</CardContent>
		</Card>
	);
}
