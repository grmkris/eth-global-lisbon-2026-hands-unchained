import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Copy } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ErrorNote } from "#/components/error-note";
import { PageHeader } from "#/components/page-header";
import { StatusBadge } from "#/components/status-badge";
import { Button } from "#/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "#/components/ui/card";
import { Checkbox } from "#/components/ui/checkbox";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "#/components/ui/table";
import { datasetEpisodesQuery } from "#/lib/queries";

export const Route = createFileRoute("/datasets_/$owner/$name")({
	component: DatasetReportPage,
});

function DatasetReportPage() {
	const { owner, name } = Route.useParams();
	const repoId = `${owner}/${name}`;
	const report = useQuery(datasetEpisodesQuery(repoId));
	const [excluded, setExcluded] = useState<ReadonlySet<number>>(new Set());

	const toggle = (index: number) => {
		const next = new Set(excluded);
		if (next.has(index)) next.delete(index);
		else next.add(index);
		setExcluded(next);
	};

	if (report.isPending)
		return <p className="text-muted-foreground">reading meta…</p>;
	if (report.isError) return <ErrorNote error={report.error} />;
	const r = report.data;

	const kept = r.episodes.map((e) => e.index).filter((i) => !excluded.has(i));
	const episodesArg = `[${kept.join(",")}]`;
	const flagged = r.episodes.filter((e) => e.flag !== null);

	return (
		<div>
			<PageHeader
				title={repoId}
				titleClassName="font-mono"
				back={{ to: "/datasets", label: "Datasets" }}
				description={
					<>
						{r.episodes.length} episodes · median {r.medianFrames ?? "—"} frames
						· {r.fps ?? "—"} fps
						{flagged.length > 0 && (
							<span className="text-warn">
								{" "}
								· {flagged.length} length outlier{flagged.length > 1 ? "s" : ""}
							</span>
						)}
					</>
				}
			/>

			{!r.local && (
				<p className="mt-4 text-sm text-warn">
					Not in the local cache — episode meta unavailable. Pull it locally
					(record/replay/train uses it) to see the report card.
				</p>
			)}

			{r.local && (
				<>
					<div className="mt-4 max-w-3xl">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>exclude</TableHead>
									<TableHead>ep</TableHead>
									<TableHead className="text-right">frames</TableHead>
									<TableHead className="text-right">seconds</TableHead>
									<TableHead>flag</TableHead>
									<TableHead>task</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{r.episodes.map((e) => (
									<TableRow
										key={e.index}
										className={excluded.has(e.index) ? "opacity-40" : ""}
									>
										<TableCell>
											<Checkbox
												checked={excluded.has(e.index)}
												onCheckedChange={() => toggle(e.index)}
												aria-label={`exclude episode ${e.index}`}
											/>
										</TableCell>
										<TableCell className="font-mono">{e.index}</TableCell>
										<TableCell className="text-right tabular-nums">
											{e.frames}
										</TableCell>
										<TableCell className="text-right tabular-nums">
											{e.seconds}s
										</TableCell>
										<TableCell>
											{e.flag && (
												<StatusBadge tone="warn">{e.flag}</StatusBadge>
											)}
										</TableCell>
										<TableCell className="text-muted-foreground">
											{e.task}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</div>

					<Card className="mt-6 max-w-3xl">
						<CardHeader>
							<CardTitle>
								Train on kept episodes ({kept.length}/{r.episodes.length})
							</CardTitle>
							<CardDescription>
								Never delete episodes from a dataset — exclude them at train
								time instead (delete_episodes is fragile on multi-resume
								datasets).
							</CardDescription>
						</CardHeader>
						<CardContent className="text-sm">
							{excluded.size > 0 ? (
								<pre className="overflow-x-auto rounded bg-muted p-3 font-mono text-xs">
									--dataset.episodes "{episodesArg}"
								</pre>
							) : (
								<p className="text-xs text-muted-foreground">
									nothing excluded — training uses all episodes
								</p>
							)}
							<div className="mt-3 flex gap-2">
								{excluded.size > 0 && (
									<Button
										variant="outline"
										size="sm"
										onClick={() => {
											navigator.clipboard.writeText(
												`--dataset.episodes "${episodesArg}"`,
											);
											toast.success("flag copied");
										}}
									>
										<Copy />
										copy flag
									</Button>
								)}
								<Button asChild size="sm">
									<Link
										to="/trainings/new"
										search={{
											dataset: repoId,
											episodes: excluded.size > 0 ? episodesArg : undefined,
										}}
									>
										use in new training
									</Link>
								</Button>
							</div>
						</CardContent>
					</Card>
				</>
			)}
		</div>
	);
}
