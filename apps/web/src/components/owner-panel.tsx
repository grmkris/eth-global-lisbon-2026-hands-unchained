import {
	ChevronDown,
	ChevronRight,
	ExternalLink,
	KeyRound,
	Trash2,
	UploadCloud,
} from "lucide-react";
import { useState } from "react";
import type { TaskInfo } from "#/api/contract";
import { Button } from "#/components/ui/button";
import { Card, CardContent } from "#/components/ui/card";
import { Checkbox } from "#/components/ui/checkbox";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Spinner } from "#/components/ui/spinner";
import { Textarea } from "#/components/ui/textarea";
import { ownerKeyStore, type RigSummary } from "#/lib/hub-api";

/**
 * Publish one task's dataset to the HF Hub, and show where it landed.
 *
 * The upload runs on the RIG (that is where the episodes and the HF token are)
 * so this is a fire-and-watch button: the verb starts it, and `rig.push`
 * telemetry carries the phase, the resulting URL, and any failure back. Only
 * one push runs at a time rig-wide, hence gating every task's button on it.
 */
function PublishTask({
	task,
	push,
	busy,
	ownerKey,
	onPush,
}: {
	task: TaskInfo;
	push: RigSummary["push"];
	busy: boolean;
	ownerKey: string;
	onPush: (ownerKey: string, repoName: string) => void;
}) {
	const collected = task.episodesDone ?? 0;
	// telemetry is rig-wide; only claim it for the task whose repo it names
	const mine = push && push.repoId?.endsWith(`/${task.repoName}`) ? push : null;
	const uploading = push?.phase === "uploading";

	if (mine?.phase === "done" && mine.url)
		return (
			<a
				href={mine.url}
				target="_blank"
				rel="noreferrer"
				className="inline-flex items-center gap-1 text-xs underline underline-offset-2"
			>
				<ExternalLink className="size-3" />
				on the Hub
			</a>
		);

	return (
		<div className="flex items-center gap-1">
			<Button
				size="sm"
				variant="outline"
				onClick={() => onPush(ownerKey, task.repoName)}
				// nothing recorded yet = nothing to publish; the rig would only
				// answer "no local dataset — record an episode first"
				disabled={!ownerKey || busy || uploading || collected === 0}
				title={
					collected === 0
						? "no episodes recorded yet"
						: `publish ${task.repoName} to the HF Hub`
				}
			>
				{mine?.phase === "uploading" ? (
					<Spinner className="size-3" />
				) : (
					<UploadCloud />
				)}
				{mine?.phase === "uploading" ? "publishing…" : "Publish"}
			</Button>
			{mine?.phase === "failed" && (
				<span className="text-destructive text-xs" title={mine.error ?? ""}>
					push failed
				</span>
			)}
		</div>
	);
}

/**
 * Rig-owner controls: define/edit the tasks operators can attempt. The key is
 * printed by the rig at boot; it relays opaquely through the hub and only the
 * rig validates it — feedback comes back via lastCommandResult telemetry.
 */
export function OwnerPanel(props: {
	rig: RigSummary;
	onUpsert: (ownerKey: string, task: Record<string, unknown>) => void;
	onDelete: (ownerKey: string, id: string) => void;
	onPush: (ownerKey: string, repoName: string) => void;
	busy: boolean;
}) {
	const { rig, onUpsert, onDelete, onPush, busy } = props;
	const [open, setOpen] = useState(false);
	const [key, setKey] = useState(() => ownerKeyStore.get(rig.name));
	const [editingId, setEditingId] = useState<string>("");
	const [title, setTitle] = useState("");
	const [instructions, setInstructions] = useState("");
	const [repoName, setRepoName] = useState("");
	const [episodeSeconds, setEpisodeSeconds] = useState(20);
	const [resetSeconds, setResetSeconds] = useState(5);
	const [maxEpisodes, setMaxEpisodes] = useState<number | "">("");
	const [active, setActive] = useState(true);

	const saveKey = (v: string) => {
		setKey(v);
		ownerKeyStore.set(rig.name, v);
	};

	const loadTask = (id: string) => {
		const t = rig.tasks.find((x) => x.id === id);
		if (!t) return;
		setEditingId(t.id);
		setTitle(t.title);
		setInstructions(t.instructions);
		setRepoName(t.repoName);
		setEpisodeSeconds(t.episodeSeconds);
		setResetSeconds(t.resetSeconds);
		setMaxEpisodes(t.maxEpisodes ?? "");
		setActive(t.active);
	};

	const submit = () => {
		onUpsert(key, {
			id: editingId,
			title,
			instructions,
			repoName:
				repoName ||
				`poh_${title
					.toLowerCase()
					.replace(/[^a-z0-9]+/g, "_")
					.slice(0, 30)}`,
			episodeSeconds,
			resetSeconds,
			maxEpisodes: maxEpisodes === "" ? null : maxEpisodes,
			active,
		});
	};

	const cmd = rig.lastCommandResult;

	return (
		<Card>
			<CardContent className="flex flex-col gap-3">
				<button
					type="button"
					className="flex items-center gap-2 text-left font-medium"
					onClick={() => setOpen(!open)}
				>
					{open ? (
						<ChevronDown className="size-4" />
					) : (
						<ChevronRight className="size-4" />
					)}
					<KeyRound className="size-4 text-muted-foreground" />
					Rig owner — manage tasks
				</button>
				{open && (
					<>
						<div className="flex flex-col gap-2">
							<Label htmlFor="owner-key">
								Owner key (printed in the rig's terminal at boot)
							</Label>
							<Input
								id="owner-key"
								type="password"
								value={key}
								onChange={(e) => saveKey(e.target.value)}
								placeholder="paste the rig owner key"
							/>
						</div>

						{rig.tasks.length > 0 && (
							<div className="flex flex-col gap-1">
								{rig.tasks.map((t) => (
									<div key={t.id} className="flex items-center gap-2 text-sm">
										<button
											type="button"
											className="underline-offset-2 hover:underline"
											onClick={() => loadTask(t.id)}
										>
											{t.title}
										</button>
										<span className="font-mono text-xs text-muted-foreground">
											{t.episodesDone ?? 0} ep
										</span>
										{!t.active && (
											<span className="text-xs text-muted-foreground">
												(inactive)
											</span>
										)}
										<PublishTask
											task={t}
											push={rig.push}
											busy={busy}
											ownerKey={key}
											onPush={onPush}
										/>
										<Button
											size="icon-sm"
											variant="ghost"
											onClick={() => onDelete(key, t.id)}
											disabled={!key || busy}
										>
											<Trash2 />
										</Button>
									</div>
								))}
							</div>
						)}

						<div className="grid grid-cols-1 gap-2 md:grid-cols-2">
							<div className="flex flex-col gap-1 md:col-span-2">
								<Label htmlFor="t-title">Title (the episode label)</Label>
								<Input
									id="t-title"
									value={title}
									onChange={(e) => setTitle(e.target.value)}
									placeholder="push the cube into the corner"
								/>
							</div>
							<div className="flex flex-col gap-1 md:col-span-2">
								<Label htmlFor="t-instr">Instructions for operators</Label>
								<Textarea
									id="t-instr"
									value={instructions}
									onChange={(e) => setInstructions(e.target.value)}
								/>
							</div>
							<div className="flex flex-col gap-1">
								<Label htmlFor="t-repo">Dataset name</Label>
								<Input
									id="t-repo"
									value={repoName}
									onChange={(e) => setRepoName(e.target.value)}
									placeholder="auto from title"
								/>
							</div>
							<div className="flex items-end gap-4">
								<div className="flex flex-col gap-1">
									<Label htmlFor="t-ep">Episode s</Label>
									<Input
										id="t-ep"
										type="number"
										value={episodeSeconds}
										onChange={(e) => setEpisodeSeconds(Number(e.target.value))}
									/>
								</div>
								<div className="flex flex-col gap-1">
									<Label htmlFor="t-reset">Reset s</Label>
									<Input
										id="t-reset"
										type="number"
										value={resetSeconds}
										onChange={(e) => setResetSeconds(Number(e.target.value))}
									/>
								</div>
								<div className="flex flex-col gap-1">
									<Label htmlFor="t-max">Max eps</Label>
									<Input
										id="t-max"
										type="number"
										min={1}
										value={maxEpisodes}
										placeholder="∞"
										onChange={(e) =>
											// 0 would render a NaN progress bar and mark the task
											// complete before the first attempt — blank means ∞
											setMaxEpisodes(
												e.target.value === ""
													? ""
													: Math.max(1, Number(e.target.value)),
											)
										}
									/>
								</div>
							</div>
							<div className="flex items-center gap-2">
								<Checkbox
									id="t-active"
									checked={active}
									onCheckedChange={(v) => setActive(v === true)}
								/>
								<Label htmlFor="t-active">Active (visible to operators)</Label>
							</div>
						</div>
						<div className="flex items-center gap-3">
							<Button
								size="sm"
								onClick={submit}
								disabled={!key || !title.trim() || busy}
							>
								{editingId ? "Update task" : "Create task"}
							</Button>
							{editingId && (
								<Button
									size="sm"
									variant="ghost"
									onClick={() => {
										setEditingId("");
										setTitle("");
										setInstructions("");
										setRepoName("");
									}}
								>
									New task
								</Button>
							)}
							{cmd?.verb.startsWith("task_") && (
								<span
									className={`font-mono text-xs ${cmd.ok ? "text-muted-foreground" : "text-destructive"}`}
								>
									{cmd.ok ? "✓ applied" : `✗ ${cmd.error}`}
								</span>
							)}
						</div>
					</>
				)}
			</CardContent>
		</Card>
	);
}
