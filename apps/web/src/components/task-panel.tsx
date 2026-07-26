import { ChevronDown, ChevronRight, ListTodo, Play } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import type { TaskInfo } from "#/api/contract";
import { Button } from "#/components/ui/button";
import { Card, CardContent } from "#/components/ui/card";
import { Checkbox } from "#/components/ui/checkbox";
import { Label } from "#/components/ui/label";
import { Progress } from "#/components/ui/progress";
import type { RigSummary } from "#/lib/hub-api";
import { collected, completeNow, keptOf } from "#/lib/use-attempt-chain";
import type { TaskProgress } from "#/market/market-api";

/** No task has an empty id, so this cannot collide with one — it means the
 * operator closed the panel on purpose, as opposed to never having touched it. */
const CLOSED = "";

/**
 * Tasks that have hit their quota, out of the way but not gone.
 *
 * Not deleted, because "what has this arm already collected" is a real question
 * for both the operator and the owner — but a finished task has no action left,
 * so it has no business occupying a full card with a dead button in it. Inside a
 * fold literally labelled "complete" the per-task `complete ✓` badge is noise
 * too, so a row is just the title and the count.
 *
 * Hand-rolled disclosure, matching owner-panel.tsx and diagnostics-fold.tsx —
 * there is no shadcn Collapsible in this project and one fold pattern is enough.
 */
function CompleteFold({
	tasks,
	progress,
}: {
	tasks: ReadonlyArray<TaskInfo>;
	progress: TaskProgress | null;
}) {
	const [open, setOpen] = useState(false);
	return (
		<div className="flex flex-col gap-2">
			<button
				type="button"
				className="flex items-center gap-2 text-left text-muted-foreground text-sm"
				onClick={() => setOpen(!open)}
			>
				{open ? (
					<ChevronDown className="size-4" />
				) : (
					<ChevronRight className="size-4" />
				)}
				{tasks.length} complete
			</button>
			{open &&
				tasks.map((task) => (
					<div
						key={task.id}
						className="flex items-center justify-between gap-2 pl-6 text-sm"
					>
						<span className="min-w-0 truncate text-muted-foreground">
							<span className="text-success">✓</span> {task.title}
						</span>
						<span className="shrink-0 font-mono text-muted-foreground text-xs tabular-nums">
							{keptOf(task, progress)}
							{task.maxEpisodes !== null ? `/${task.maxEpisodes}` : ""}
						</span>
					</div>
				))}
		</div>
	);
}

/**
 * The crowdsourcing surface: tasks the rig owner wants done. Each attempt is
 * one recorded episode; Success keeps it (labeled training data), Discard
 * throws the buffer away. `episodesDone` (derived rig-side from the dataset's
 * lerobot meta) turns "max 20 eps" into a real 13/20 progress loop.
 *
 * This panel owns the LIST. The live attempt is components/attempt-bar.tsx,
 * mounted under the camera, and the chain that links attempts together is
 * lib/use-attempt-chain.ts, owned by the route because both need it.
 */
export function TaskPanel(props: {
	rig: RigSummary;
	iAmDriving: boolean;
	/** start an attempt through the chain, so auto-continue can follow it */
	onStart: (taskId: string) => void;
	/** why an attempt cannot start right now, null when it can. The route owns
	 * this because it is the thing that knows what is driving. */
	blockedReason: string | null;
	busy: boolean;
	/** end of the operator's booked slot, unix seconds; null = no slot layer.
	 * The ONLY thing this panel knows about slots: don't offer an attempt that
	 * cannot finish before the arm is taken away. */
	slotEndsAt?: number | null;
	/** per task, what the referee kept and threw out. null = no market layer,
	 * and the recorder's own count is the only truth there is. */
	progress?: TaskProgress | null;
	/** the chain's state, so it can be switched off between attempts — when the
	 * attempt bar is unmounted this is the only place left to reach it */
	autoContinue: boolean;
	onAutoContinue: (on: boolean) => void;
	chainTaskId: string | null;
	/** What stands between this operator and starting the given task, rendered
	 * inside the task's own row. A render prop rather than the market types
	 * themselves: this panel owns the WORKLIST and has never known what a slot
	 * or a World proof is, and the requirements panel is identical for every
	 * task, so there is nothing here worth teaching it. */
	renderRequirements?: (task: TaskInfo) => ReactNode;
	/** the terms, while they still apply — the route owns the numbers */
	subtitle?: ReactNode;
}) {
	const {
		rig,
		iAmDriving,
		onStart,
		blockedReason,
		busy,
		slotEndsAt = null,
		progress = null,
		autoContinue,
		onAutoContinue,
		chainTaskId,
		renderRequirements,
		subtitle,
	} = props;
	const active = rig.tasks.filter((t) => t.active);
	const attempt = rig.attempt;
	const recording = rig.record?.active === true;

	const [picked, setPicked] = useState<string | null>(null);
	// Ticks so `fitsInSlot` below re-evaluates as the slot clock runs down.
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (slotEndsAt === null) return;
		const t = setInterval(() => setNow(Date.now()), 500);
		return () => clearInterval(t);
	}, [slotEndsAt]);

	/** An episode needs its own seconds plus the reset. Offering one that the
	 * clock will cut off wastes the operator's stake-backed minutes and lands
	 * them a `slot_expired` row they did not ask for. */
	const fitsInSlot = (task: TaskInfo): boolean => {
		if (slotEndsAt === null) return true;
		const needMs =
			((task.episodeSeconds ?? 20) + (task.resetSeconds ?? 5) + 5) * 1000;
		return slotEndsAt * 1000 - now > needMs;
	};

	if (active.length === 0) return null;
	// the attempt bar under the camera has taken over — a second copy of the
	// same controls a screen apart is how this page got confusing
	if (attempt?.active === true) return null;

	/**
	 * A worklist leads with WORK. Tasks arrive in creation order, so on a rig
	 * that has been used for a while the finished ones sit on top — three full
	 * cards each carrying a permanently disabled `Start attempt (5/5)`, pushing
	 * the only startable task off the bottom of the rail.
	 */
	const todo = active.filter((t) => !completeNow(t, progress));
	const finished = active.filter((t) => completeNow(t, progress));

	/**
	 * Which task's requirements are open.
	 *
	 * DERIVED, not synced with an effect: while something blocks starting, the
	 * first startable task is open by default, so a gated visitor lands on "here
	 * is the work, and here is what it takes" rather than having to discover that
	 * clicking reveals a toll. An explicit click wins from then on.
	 *
	 * `CLOSED` is a sentinel rather than plain null because null means "nobody
	 * has chosen" and falls back to that default — so closing the auto-opened
	 * panel would spring it straight back. Closing matters: once every row is ✓
	 * the panel is seven receipts plus the source chips.
	 */
	const blocked = blockedReason !== null;
	const armed =
		picked === CLOSED
			? null
			: (picked ?? (blocked ? (todo[0]?.id ?? null) : null));

	return (
		<Card>
			<CardContent className="flex flex-col gap-3">
				<div className="flex items-center gap-2 font-medium">
					<ListTodo className="size-4 text-muted-foreground" />
					Tasks on this rig
				</div>
				{subtitle}
				{todo.map((task) => {
					const done = collected(task);
					// What the referee kept. Recorded-minus-failed rather than the
					// raw pass count, so episodes recorded before the market existed
					// (or while it was off) still count as data — only a verdict we
					// actually hold, and that actually failed, subtracts.
					const kept = progress === null ? null : keptOf(task, progress);
					return (
						<div
							key={task.id}
							className="flex flex-col gap-2 rounded border p-3"
						>
							{/* The header IS the disclosure. It has to be a real button:
							    people click buttons, not cards, and Start can no longer do
							    double duty as the opener now that it is properly disabled
							    while anything is unmet. */}
							<button
								type="button"
								className="min-w-0 text-left"
								aria-expanded={armed === task.id}
								onClick={() => setPicked(armed === task.id ? CLOSED : task.id)}
							>
								<div className="font-medium">{task.title}</div>
								<div className="text-sm text-muted-foreground">
									{task.instructions}
								</div>
								<div className="mt-1 font-mono text-xs text-muted-foreground">
									{task.repoName} · {task.episodeSeconds}s episode
								</div>
								{task.maxEpisodes !== null ? (
									<div className="mt-2 flex flex-wrap items-center gap-2">
										{/* The bar tracks what the dataset will actually SHIP —
										    failed episodes are dropped at publish, so counting
										    them here would promise data that never arrives. */}
										<Progress
											value={Math.min(
												100,
												((kept ?? done) / task.maxEpisodes) * 100,
											)}
											className="w-32"
										/>
										<span className="font-mono text-xs tabular-nums text-muted-foreground">
											{kept ?? done}/{task.maxEpisodes}
										</span>
										{kept !== null && kept < done && (
											<span
												className="text-warn text-xs"
												title="the referee failed these — they are left out of the published dataset"
											>
												{done - kept} rejected
											</span>
										)}
									</div>
								) : (
									<div className="mt-1 font-mono text-xs text-muted-foreground">
										{kept ?? done} eps collected
										{kept !== null && kept < done
											? ` · ${done - kept} rejected`
											: ""}
									</div>
								)}
							</button>

							{armed === task.id && renderRequirements?.(task)}

							{/* ALWAYS LAST, and purely terminal. It used to sit above the
							    requirements and double as their opener, which meant that on
							    the already-open task it re-set the same id and did nothing —
							    a button that looked live and wasn't. Now it only ever starts
							    an attempt, and says why it can't when it can't. */}
							<div className="flex justify-end border-t pt-2">
								<Button
									size="sm"
									onClick={() => onStart(task.id)}
									disabled={
										blockedReason !== null ||
										recording ||
										busy ||
										!fitsInSlot(task)
									}
									title={
										blockedReason ??
										(fitsInSlot(task)
											? undefined
											: "less than one episode left in your slot")
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

				{finished.length > 0 && (
					<CompleteFold tasks={finished} progress={progress} />
				)}
				{/* between attempts the bar is unmounted, and a chain you cannot
				    switch off is worse than one you have to re-arm */}
				{chainTaskId !== null && iAmDriving && (
					<div className="flex items-center gap-2">
						<Checkbox
							id="auto-continue-list"
							checked={autoContinue}
							onCheckedChange={(v) => onAutoContinue(v === true)}
						/>
						<Label
							htmlFor="auto-continue-list"
							className="font-normal text-muted-foreground"
						>
							auto-start the next attempt (until the task is complete)
						</Label>
					</div>
				)}
			</CardContent>
		</Card>
	);
}
