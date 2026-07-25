import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { apiErrorMessage } from "#/lib/errors";
import { checkpointsQuery, patchRun, runQuery } from "#/lib/queries";

export const Route = createFileRoute("/trainings/$runId")({
	component: RunPage,
});

function RunPage() {
	const { runId } = Route.useParams();
	const run = useQuery(runQuery(runId));
	const checkpoints = useQuery(checkpointsQuery(runId));
	const queryClient = useQueryClient();
	const [finding, setFinding] = useState<string | null>(null);

	const saveFinding = useMutation({
		mutationFn: (value: string) =>
			patchRun(runId, { status: null, hypothesis: null, finding: value }),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["runs"] });
			toast.success("finding saved");
		},
		onError: (e) => toast.error(apiErrorMessage(e)),
	});

	const markLaunched = useMutation({
		mutationFn: () =>
			patchRun(runId, { status: "launched", hypothesis: null, finding: null }),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["runs"] });
			toast.success("marked launched — checkpoint polling active");
		},
		onError: (e) => toast.error(apiErrorMessage(e)),
	});

	if (run.isPending) return <p className="text-muted-foreground">loading…</p>;
	if (run.isError) return <ErrorNote error={run.error} />;
	const r = run.data;

	const targetSteps = r.config?.steps ?? null;
	const ckptSteps = checkpoints.data?.steps ?? [];
	const lastCkpt = ckptSteps.at(-1)
		? Number.parseInt(ckptSteps.at(-1) as string, 10)
		: 0;
	const progress = targetSteps
		? Math.min(100, Math.round((lastCkpt / targetSteps) * 100))
		: null;

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

				{r.status !== "imported" && (
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
								disabled={finding === null || saveFinding.isPending}
								onClick={() => finding !== null && saveFinding.mutate(finding)}
							>
								{saveFinding.isPending && <Spinner />}
								save
							</Button>
						</CardContent>
					</Card>
				)}

				{r.colabCell && (
					<Card>
						<CardHeader>
							<CardTitle>Colab cell (version-matched)</CardTitle>
							<CardAction>
								<div className="flex gap-2">
									<Button
										variant="outline"
										size="sm"
										onClick={() => {
											navigator.clipboard.writeText(r.colabCell as string);
											toast.success("Colab cell copied");
										}}
									>
										<Copy />
										copy
									</Button>
									{r.status === "draft" && (
										<Button
											size="sm"
											disabled={markLaunched.isPending}
											onClick={() => markLaunched.mutate()}
										>
											{markLaunched.isPending && <Spinner />}
											mark launched
										</Button>
									)}
								</div>
							</CardAction>
						</CardHeader>
						<CardContent>
							<pre className="overflow-x-auto rounded bg-muted p-3 font-mono text-xs">
								{r.colabCell}
							</pre>
						</CardContent>
					</Card>
				)}
			</div>
		</div>
	);
}
