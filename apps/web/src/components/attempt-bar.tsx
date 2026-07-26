import { CheckCircle2, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Checkbox } from "#/components/ui/checkbox";
import { Label } from "#/components/ui/label";
import { Progress } from "#/components/ui/progress";
import type { RigSummary } from "#/lib/hub-api";

/**
 * The recorder, welded to the bottom of the camera.
 *
 * This used to be a card at the bottom of the page, below the slot ledger and
 * the drive panel — roughly 1100px down on a laptop. So for twenty seconds you
 * watched the arm while the two buttons that end the episode sat off screen.
 * Now the control rail simply becomes this while an attempt runs.
 *
 * The clock is a draining bar, not just a number: your eyes are on the arm, and
 * peripheral vision can read a shrinking bar but cannot read "12".
 *
 * With E-STOP gone from this page, `● REC` is the only destructive-red element
 * left in the drive UI — red now means exactly one thing, which is what
 * styles.css means by "color is reserved for state".
 */
export function AttemptBar({
	attempt,
	record,
	mine,
	busy,
	onFinish,
	autoContinue,
	onAutoContinue,
}: {
	attempt: NonNullable<RigSummary["attempt"]>;
	record: RigSummary["record"];
	/** this attempt is the one THIS browser started */
	mine: boolean;
	busy: boolean;
	onFinish: (success: boolean) => void;
	autoContinue: boolean;
	onAutoContinue: (on: boolean) => void;
}) {
	const recording = record?.active === true;

	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), 500);
		return () => clearInterval(t);
	}, []);

	const elapsed = attempt.startedAt
		? Math.max(0, (now - Date.parse(attempt.startedAt)) / 1000)
		: 0;
	const total = attempt.episodeSeconds ?? null;
	const remaining = total === null ? null : Math.max(0, total - elapsed);

	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-wrap items-center gap-3">
				<Badge variant={recording ? "destructive" : "secondary"}>
					{recording ? "● REC" : (record?.phase ?? "starting…")}
				</Badge>
				<span className="font-medium">{attempt.taskTitle}</span>
				{remaining !== null && (
					<span className="ms-auto font-mono text-sm tabular-nums">
						{remaining.toFixed(0)}s
					</span>
				)}
			</div>

			{total !== null && (
				<Progress
					value={Math.max(0, Math.min(100, ((remaining ?? 0) / total) * 100))}
				/>
			)}

			{mine ? (
				<>
					<div className="flex flex-wrap gap-2">
						<Button onClick={() => onFinish(true)} disabled={busy}>
							<CheckCircle2 />
							Success — keep episode
						</Button>
						<Button
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
							onCheckedChange={(v) => onAutoContinue(v === true)}
						/>
						<Label
							htmlFor="auto-continue"
							className="font-normal text-muted-foreground"
						>
							auto-start the next attempt (until the task is complete)
						</Label>
					</div>
				</>
			) : (
				<p className="font-mono text-sm text-muted-foreground">
					{attempt.operator} is attempting this task.
				</p>
			)}
		</div>
	);
}
