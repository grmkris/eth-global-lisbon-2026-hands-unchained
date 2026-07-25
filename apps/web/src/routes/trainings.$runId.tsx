import {
	queryOptions,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Copy } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ErrorNote } from "#/components/error-note";
import { PageHeader } from "#/components/page-header";
import { Button } from "#/components/ui/button";
import {
	Card,
	CardAction,
	CardContent,
	CardHeader,
	CardTitle,
} from "#/components/ui/card";
import { Progress } from "#/components/ui/progress";
import { Spinner } from "#/components/ui/spinner";
import { Textarea } from "#/components/ui/textarea";
import { colabCell } from "#/lib/colab-cell";
import { apiErrorMessage } from "#/lib/errors";
import { ownerKeyStore, rigsQuery, sendRigCommand } from "#/lib/hub-api";
import { runQuery } from "#/lib/queries";

export const Route = createFileRoute("/trainings/$runId")({
	component: RunPage,
});

// Checkpoints straight from the HF API (public repos, CORS-enabled) — works
// for rig-advertised runs the hub registry has never heard of.
const hfCheckpointsQuery = (hubModelId: string) =>
	queryOptions({
		queryKey: ["hf", "checkpoints", hubModelId],
		queryFn: async (): Promise<ReadonlyArray<string>> => {
			const res = await fetch(
				`https://huggingface.co/api/models/${hubModelId}/tree/main/checkpoints`,
			);
			if (!res.ok) return [];
			const body = (await res.json()) as Array<{ type: string; path: string }>;
			return body
				.filter((e) => e.type === "directory")
				.map((e) => e.path.split("/").at(-1) ?? e.path)
				.sort();
		},
		refetchInterval: 60_000,
		enabled: hubModelId !== "",
	});

function RunPage() {
	const { runId } = Route.useParams();
	const rigs = useQuery(rigsQuery);
	const queryClient = useQueryClient();
	const [finding, setFinding] = useState<string | null>(null);

	// The run lives in a rig's sidecar and reaches us via its advertisement;
	// the owning rig is also the target for run_update verbs. Hub-imported
	// models (no rig) come from the hub's own /api/runs.
	const owning = (rigs.data ?? [])
		.map((rig) => ({
			rigName: rig.name,
			run: rig.runs.find((r) => r.id === runId),
		}))
		.find((x) => x.run !== undefined);
	const hubRun = useQuery({
		...runQuery(runId),
		enabled: owning === undefined,
		retry: false,
	});
	const r = owning?.run ?? hubRun.data;

	const checkpoints = useQuery(hfCheckpointsQuery(r?.hubModelId ?? ""));

	const update = useMutation({
		mutationFn: (patch: {
			status: string | null;
			finding: string | null;
		}) => {
			if (!owning) throw new Error("owning rig is offline");
			return sendRigCommand(owning.rigName, "run_update", {
				ownerKey: ownerKeyStore.get(owning.rigName),
				args: { id: runId, hypothesis: null, ...patch },
			});
		},
		onSuccess: (_d, patch) => {
			queryClient.invalidateQueries({ queryKey: ["hub", "rigs"] });
			toast.success(
				patch.status === "launched"
					? "marked launched — checkpoint polling active"
					: "finding saved",
			);
		},
		onError: (e) => toast.error(apiErrorMessage(e)),
	});

	if (!r) {
		if (rigs.isPending || hubRun.isPending)
			return <p className="text-muted-foreground">loading…</p>;
		if (hubRun.isError && rigs.isError)
			return <ErrorNote error={hubRun.error} />;
		// freshly created: the rig advertisement lands within ~2s (rigsQuery polls)
		return (
			<p className="flex items-center gap-2 text-muted-foreground">
				<Spinner /> waiting for the rig to advertise this run…
			</p>
		);
	}

	const targetSteps = r.config?.steps ?? null;
	const ckptSteps = checkpoints.data ?? [];
	const lastCkpt = ckptSteps.at(-1)
		? Number.parseInt(ckptSteps.at(-1) as string, 10)
		: 0;
	const progress = targetSteps
		? Math.min(100, Math.round((lastCkpt / targetSteps) * 100))
		: null;

	// advertisements omit the cell (link payload); regenerate it client-side
	const cell =
		r.colabCell ??
		(r.config
			? colabCell({ name: r.name, hubModelId: r.hubModelId, config: r.config })
			: null);
	const canEdit = owning !== undefined;

	return (
		<div className="max-w-3xl">
			<PageHeader
				title={r.name}
				titleClassName="font-mono"
				back={{ to: "/trainings", label: "Trainings" }}
				description={
					<>
						{r.status} · {r.hubModelId} ·{" "}
						<a
							className="underline"
							target="_blank"
							rel="noreferrer"
							href={`https://huggingface.co/${r.hubModelId}`}
						>
							hub
						</a>
						{canEdit ? ` · rig ${owning.rigName}` : ""}
					</>
				}
			/>

			<div className="flex flex-col gap-4">
				{r.config && (
					<Card>
						<CardHeader>
							<CardTitle>Lineage</CardTitle>
						</CardHeader>
						<CardContent className="text-sm">
							<div className="font-mono text-muted-foreground">
								dataset {r.config.datasetRepoId}
								{r.config.episodes
									? ` · episodes ${r.config.episodes}`
									: " · all episodes"}
								{r.config.pretrainedPath
									? ` · warm-start ${r.config.pretrainedPath}`
									: " · from scratch"}
							</div>
							<div className="mt-1 text-muted-foreground">
								{r.config.steps} steps · batch {r.config.batchSize} · save every{" "}
								{r.config.saveFreq}
							</div>
						</CardContent>
					</Card>
				)}

				<Card>
					<CardHeader>
						<CardTitle>Checkpoints on Hub</CardTitle>
					</CardHeader>
					<CardContent className="text-sm">
						{checkpoints.isPending ? (
							<p className="text-muted-foreground">polling…</p>
						) : ckptSteps.length === 0 ? (
							<p className="text-muted-foreground">
								none yet — appear every save_freq steps once training runs
							</p>
						) : (
							<div>
								<div className="font-mono text-muted-foreground">
									{ckptSteps.join(" · ")}
								</div>
								{progress !== null && (
									<div className="mt-3 flex items-center gap-3">
										<Progress value={progress} />
										<span className="shrink-0 font-mono text-xs text-muted-foreground">
											{lastCkpt}/{targetSteps}
										</span>
									</div>
								)}
							</div>
						)}
					</CardContent>
				</Card>

				{r.hypothesis && (
					<Card>
						<CardHeader>
							<CardTitle>Hypothesis</CardTitle>
						</CardHeader>
						<CardContent className="text-sm">
							<p>{r.hypothesis}</p>
						</CardContent>
					</Card>
				)}

				{r.status !== "imported" && canEdit && (
					<Card>
						<CardHeader>
							<CardTitle>Finding (after eval)</CardTitle>
						</CardHeader>
						<CardContent className="text-sm">
							<Textarea
								rows={2}
								defaultValue={r.finding ?? ""}
								onChange={(e) => setFinding(e.target.value)}
								placeholder="what did this run teach you?"
							/>
							<Button
								className="mt-3"
								size="sm"
								disabled={finding === null || update.isPending}
								onClick={() =>
									finding !== null &&
									update.mutate({ status: null, finding })
								}
							>
								{update.isPending && <Spinner />}
								save
							</Button>
						</CardContent>
					</Card>
				)}

				{cell && (
					<Card>
						<CardHeader>
							<CardTitle>Colab cell (version-matched)</CardTitle>
							<CardAction>
								<div className="flex gap-2">
									<Button
										variant="outline"
										size="sm"
										onClick={() => {
											navigator.clipboard.writeText(cell);
											toast.success("Colab cell copied");
										}}
									>
										<Copy />
										copy
									</Button>
									{r.status === "draft" && canEdit && (
										<Button
											size="sm"
											disabled={update.isPending}
											onClick={() =>
												update.mutate({ status: "launched", finding: null })
											}
										>
											{update.isPending && <Spinner />}
											mark launched
										</Button>
									)}
								</div>
							</CardAction>
						</CardHeader>
						<CardContent>
							<pre className="overflow-x-auto rounded bg-muted p-3 font-mono text-xs">
								{cell}
							</pre>
						</CardContent>
					</Card>
				)}
			</div>
		</div>
	);
}
