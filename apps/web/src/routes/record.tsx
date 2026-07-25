import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ErrorNote, PreflightGateList } from "#/components/error-note";
import { PageHeader } from "#/components/page-header";
import { RecordHud } from "#/components/record/record-hud";
import {
	ArmStateBadge,
	SimBadge,
	StatusBadge,
} from "#/components/status-badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent } from "#/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "#/components/ui/field";
import { Input } from "#/components/ui/input";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select";
import { Spinner } from "#/components/ui/spinner";
import { isPreflightError } from "#/lib/errors";
import {
	recordControl,
	recordStart,
	recordStatusQuery,
	robotStateQuery,
} from "#/lib/queries";

// demo source options per backend; first entry = the backend's default
const SOURCES: Record<
	string,
	ReadonlyArray<{ value: string; label: string }>
> = {
	real: [
		{ value: "leader", label: "Leader arm" },
		{ value: "keys", label: "Keyboard (browser)" },
		{ value: "phone", label: "Phone (HEBI)" },
	],
	sim: [
		{ value: "scripted", label: "Scripted expert" },
		{ value: "keys", label: "Keyboard (browser)" },
		{ value: "phone", label: "Phone (HEBI)" },
	],
};

export const Route = createFileRoute("/record")({ component: RecordPage });

const ts = () => {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

const toInt = (value: string, fallback: number) => {
	const n = Number.parseInt(value, 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
};

function RecordPage() {
	const robot = useQuery(robotStateQuery);
	const status = useQuery(recordStatusQuery);
	const queryClient = useQueryClient();

	const backend = robot.data?.backend ?? "real";
	const isSim = backend === "sim";

	// empty by default — the real default name is computed at submit time, so
	// neither the timestamp nor the sim/session prefix can go stale
	const [repoName, setRepoName] = useState("");
	const [task, setTask] = useState("pick the piece and place it on the peg");
	const [numEpisodes, setNumEpisodes] = useState(5);
	const [episodeS, setEpisodeS] = useState(20);
	const [resetS, setResetS] = useState(10);
	const [source, setSource] = useState<string | null>(null); // null -> backend default
	const sources = SOURCES[backend] ?? SOURCES.real;
	const effectiveSource = source ?? sources[0].value;

	// durations are only known for sessions started from this page — keyed by
	// repoId so a reload mid-session falls back to the elapsed clock
	const sessionRef = useRef<{
		repoId: string;
		episodeS: number;
		resetS: number;
	} | null>(null);

	const start = useMutation({
		mutationFn: () => {
			const name =
				repoName.trim() || `so101_${isSim ? "sim" : "session"}_${ts()}`;
			return recordStart({
				repoName: name,
				task,
				numEpisodes,
				episodeS,
				resetS,
				resume: false,
				source: effectiveSource,
			});
		},
		onSuccess: (s) => {
			if (s.repoId) sessionRef.current = { repoId: s.repoId, episodeS, resetS };
			queryClient.invalidateQueries({ queryKey: ["record"] });
		},
	});
	const control = useMutation({
		mutationFn: recordControl,
		onSuccess: (_s, action) => {
			if (action === "rerecord") setRedone((n) => n + 1);
			if (action === "finish") toast.success("session finished");
			queryClient.invalidateQueries({ queryKey: ["record"] });
		},
	});

	const s = status.data;
	const active = s?.active ?? false;

	// redone tally is session-local (client-side) — reset when the repo changes
	const [redone, setRedone] = useState(0);
	const repoId = s?.repoId ?? null;
	const prevRepo = useRef(repoId);
	useEffect(() => {
		if (repoId !== prevRepo.current) {
			prevRepo.current = repoId;
			setRedone(0);
		}
	}, [repoId]);

	const durations =
		s?.repoId && sessionRef.current?.repoId === s.repoId
			? {
					episodeS: sessionRef.current.episodeS,
					resetS: sessionRef.current.resetS,
				}
			: null;

	const namePlaceholder = `so101_${isSim ? "sim" : "session"}_${ts().slice(0, 8)}_… (auto)`;

	return (
		<div>
			<PageHeader
				title="Record"
				badge={
					<span className="flex items-center gap-2">
						{isSim ? (
							<SimBadge />
						) : (
							<StatusBadge tone="neutral">REAL</StatusBadge>
						)}
						<ArmStateBadge state={robot.data?.state} />
					</span>
				}
			/>

			{robot.data?.state === "disconnected" && (
				<p className="mt-4 text-sm text-warn">
					Connect on the Robot page first (real arm or SIM).
				</p>
			)}

			{!active && robot.data?.state !== "disconnected" && (
				<Card className="mt-4 max-w-xl">
					<CardContent>
						<FieldGroup>
							<Field>
								<FieldLabel htmlFor="rec-name">
									Dataset name (kris0/…)
								</FieldLabel>
								<Input
									id="rec-name"
									value={repoName}
									onChange={(e) => setRepoName(e.target.value)}
									placeholder={namePlaceholder}
								/>
							</Field>
							<Field>
								<FieldLabel htmlFor="rec-task">Task</FieldLabel>
								<Input
									id="rec-task"
									value={task}
									onChange={(e) => setTask(e.target.value)}
								/>
							</Field>
							<Field>
								<FieldLabel htmlFor="rec-source">Demo source</FieldLabel>
								<Select
									value={effectiveSource}
									onValueChange={(v) => setSource(v)}
								>
									<SelectTrigger id="rec-source" className="w-full">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectGroup>
											{sources.map((src) => (
												<SelectItem key={src.value} value={src.value}>
													{src.label}
												</SelectItem>
											))}
										</SelectGroup>
									</SelectContent>
								</Select>
							</Field>
							<div className="grid grid-cols-3 gap-4">
								<Field>
									<FieldLabel htmlFor="rec-eps">Episodes</FieldLabel>
									<Input
										id="rec-eps"
										type="number"
										min={1}
										value={numEpisodes}
										onChange={(e) => setNumEpisodes(toInt(e.target.value, 5))}
									/>
								</Field>
								<Field>
									<FieldLabel htmlFor="rec-epls">Episode s</FieldLabel>
									<Input
										id="rec-epls"
										type="number"
										min={1}
										value={episodeS}
										onChange={(e) => setEpisodeS(toInt(e.target.value, 20))}
									/>
								</Field>
								<Field>
									<FieldLabel htmlFor="rec-resets">Reset s</FieldLabel>
									<Input
										id="rec-resets"
										type="number"
										min={1}
										value={resetS}
										onChange={(e) => setResetS(toInt(e.target.value, 10))}
									/>
								</Field>
							</div>
						</FieldGroup>
						{!isSim && (
							<p className="mt-4 text-xs text-muted-foreground">
								{effectiveSource === "leader"
									? "Real recording with the leader arm needs it connected and cameras confirmed (Robot page)."
									: "Synthetic sources are clamped to 15°/frame on the real arm; cameras must be confirmed (Robot page)."}{" "}
								Episode saves on timeout or “keep”.
							</p>
						)}
						<Button
							className="mt-4"
							disabled={start.isPending || !task}
							onClick={() => start.mutate()}
						>
							{start.isPending && <Spinner />}
							{start.isPending
								? "starting…"
								: `Start recording (${numEpisodes} eps)`}
						</Button>
						{start.isError && (
							<div className="mt-3">
								{isPreflightError(start.error) ? (
									<PreflightGateList error={start.error} />
								) : (
									<ErrorNote error={start.error} />
								)}
							</div>
						)}
					</CardContent>
				</Card>
			)}

			{active && s && (
				<RecordHud
					status={s}
					isSim={isSim}
					durations={durations}
					redone={redone}
					controlPending={control.isPending}
					onKeep={() => control.mutate("keep")}
					onRerecord={() => control.mutate("rerecord")}
					onFinish={() => control.mutate("finish")}
				/>
			)}

			{!active && s && (s.phase === "done" || s.phase === "failed") && (
				<Card className="mt-4 max-w-xl">
					<CardContent className="flex flex-wrap items-center justify-between gap-3 text-sm">
						<p className="flex items-center gap-2">
							<StatusBadge tone={s.phase === "done" ? "success" : "danger"}>
								{s.phase}
							</StatusBadge>
							last session: {s.saved}/{s.total} episodes saved
							{s.repoId && <span className="font-mono"> · {s.repoId}</span>}
						</p>
						<Button asChild variant="outline" size="sm">
							<Link to="/datasets">Datasets</Link>
						</Button>
					</CardContent>
				</Card>
			)}
		</div>
	);
}
