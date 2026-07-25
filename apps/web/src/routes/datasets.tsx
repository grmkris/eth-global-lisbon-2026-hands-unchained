import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Brain, Database, ExternalLink, FileText, Play } from "lucide-react";
import { ErrorNote } from "#/components/error-note";
import { PageHeader } from "#/components/page-header";
import { SimBadge, StatusBadge } from "#/components/status-badge";
import { Button } from "#/components/ui/button";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "#/components/ui/empty";
import { Skeleton } from "#/components/ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "#/components/ui/table";
import { datasetsQuery } from "#/lib/queries";

export const Route = createFileRoute("/datasets")({ component: DatasetsPage });

const STACK_VERSION = "v3.0"; // dataset codebase version written by lerobot 0.6.0

function DatasetsPage() {
	const datasets = useQuery(datasetsQuery);

	return (
		<div>
			<PageHeader
				title="Datasets"
				description="Local cache (~/.cache/huggingface/lerobot) merged with Hub (kris0/*)"
			/>

			{datasets.isPending ? (
				<div className="mt-6 flex flex-col gap-3">
					{[0, 1, 2].map((i) => (
						<Skeleton key={i} className="h-8 w-full" />
					))}
				</div>
			) : datasets.isError ? (
				<div className="mt-6">
					<ErrorNote error={datasets.error} />
				</div>
			) : datasets.data.length === 0 ? (
				<Empty className="mt-6 border">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<Database />
						</EmptyMedia>
						<EmptyTitle>No datasets yet</EmptyTitle>
						<EmptyDescription>
							Nothing in the local cache or on the Hub.
						</EmptyDescription>
					</EmptyHeader>
					<EmptyContent>
						<Button asChild>
							<Link to="/record">Record a session</Link>
						</Button>
					</EmptyContent>
				</Empty>
			) : (
				<Table className="mt-2">
					<TableHeader>
						<TableRow>
							<TableHead>repo</TableHead>
							<TableHead className="text-right">episodes</TableHead>
							<TableHead className="text-right">frames</TableHead>
							<TableHead className="text-right">fps</TableHead>
							<TableHead>cameras</TableHead>
							<TableHead>format</TableHead>
							<TableHead>where</TableHead>
							<TableHead>actions</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{datasets.data.map((d) => (
							<TableRow key={d.repoId}>
								<TableCell className="font-mono">
									<span className="flex items-center gap-2">
										{d.repoId}
										{d.sim && <SimBadge />}
									</span>
								</TableCell>
								<TableCell className="text-right tabular-nums">
									{d.totalEpisodes ?? "—"}
								</TableCell>
								<TableCell className="text-right tabular-nums">
									{d.totalFrames ?? "—"}
								</TableCell>
								<TableCell className="text-right tabular-nums">
									{d.fps ?? "—"}
								</TableCell>
								<TableCell>{d.cameras.join(", ") || "—"}</TableCell>
								<TableCell>
									{d.codebaseVersion ? (
										<StatusBadge
											tone={
												d.codebaseVersion === STACK_VERSION ? "success" : "warn"
											}
											title={
												d.codebaseVersion === STACK_VERSION
													? "matches lerobot 0.6.0 stack"
													: `dataset format ${d.codebaseVersion} — verify against the 0.6.0 stack before training`
											}
										>
											{d.codebaseVersion}
										</StatusBadge>
									) : (
										"—"
									)}
								</TableCell>
								<TableCell className="text-muted-foreground">
									{[d.isLocal ? "local" : null, d.onHub ? "hub" : null]
										.filter(Boolean)
										.join(" + ")}
								</TableCell>
								<TableCell>
									<span className="flex items-center gap-1">
										{d.onHub && (
											<>
												<Button
													asChild
													variant="ghost"
													size="sm"
													className="text-muted-foreground"
												>
													<a
														target="_blank"
														rel="noreferrer"
														href={`https://huggingface.co/datasets/${d.repoId}`}
														title="open on the Hub"
													>
														hub
														<ExternalLink />
													</a>
												</Button>
												<Button
													asChild
													variant="ghost"
													size="sm"
													className="text-muted-foreground"
												>
													<a
														target="_blank"
														rel="noreferrer"
														href={`https://huggingface.co/spaces/lerobot/visualize_dataset?dataset=${encodeURIComponent(d.repoId)}`}
														title="lerobot dataset visualizer"
													>
														<Play />
														visualize
													</a>
												</Button>
											</>
										)}
										{d.isLocal && (
											<Button
												asChild
												variant="ghost"
												size="sm"
												className="text-muted-foreground"
											>
												<Link
													to="/datasets/$owner/$name"
													params={{
														owner: d.repoId.split("/")[0],
														name: d.repoId.split("/")[1],
													}}
													title="report card + exclude builder"
												>
													<FileText />
													report
												</Link>
											</Button>
										)}
										<Button asChild variant="outline" size="sm">
											<Link
												to="/trainings/new"
												search={{ dataset: d.repoId }}
												title="new training on this dataset"
											>
												<Brain />
												train
											</Link>
										</Button>
									</span>
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			)}
		</div>
	);
}
