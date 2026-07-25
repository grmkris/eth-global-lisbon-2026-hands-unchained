import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Brain } from "lucide-react";
import { ErrorNote } from "#/components/error-note";
import { PageHeader } from "#/components/page-header";
import { StatusBadge, type StatusTone } from "#/components/status-badge";
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
import { rigsQuery } from "#/lib/hub-api";
import { runsQuery } from "#/lib/queries";

export const Route = createFileRoute("/trainings/")({
	component: TrainingsPage,
});

const statusTone: Record<string, StatusTone> = {
	draft: "neutral",
	launched: "info",
	imported: "neutral",
	done: "success",
	failed: "danger",
};

function TrainingsPage() {
	const runs = useQuery(runsQuery);
	const rigs = useQuery(rigsQuery);

	// One list from two sources: runs advertised by live rigs (their sidecar is
	// the source of truth) ∪ hub-visible runs (imported kris0/* models). A run
	// pushed to the Hub eventually appears in both — dedupe by hubModelId.
	const advertised = (rigs.data ?? []).flatMap((rig) => rig.runs);
	const seen = new Set(advertised.map((r) => r.hubModelId));
	const merged = [
		...advertised,
		...(runs.data ?? []).filter((r) => !seen.has(r.hubModelId)),
	].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));

	const pending = runs.isPending && rigs.isPending;

	return (
		<div>
			<PageHeader
				title="Trainings"
				description="Rig-registered runs merged with kris0/* Hub models"
				actions={
					<Button asChild>
						<Link to="/trainings/new">New training</Link>
					</Button>
				}
			/>

			{pending ? (
				<div className="mt-6 flex flex-col gap-3">
					{[0, 1, 2].map((i) => (
						<Skeleton key={i} className="h-8 w-full" />
					))}
				</div>
			) : runs.isError && rigs.isError ? (
				<div className="mt-6">
					<ErrorNote error={runs.error} />
				</div>
			) : merged.length === 0 ? (
				<Empty className="mt-6 border">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<Brain />
						</EmptyMedia>
						<EmptyTitle>No training runs yet</EmptyTitle>
						<EmptyDescription>
							Runs registered here track Hub checkpoints automatically.
						</EmptyDescription>
					</EmptyHeader>
					<EmptyContent>
						<Button asChild>
							<Link to="/trainings/new">New training</Link>
						</Button>
					</EmptyContent>
				</Empty>
			) : (
				<Table className="mt-2">
					<TableHeader>
						<TableRow>
							<TableHead>name</TableHead>
							<TableHead>status</TableHead>
							<TableHead>dataset</TableHead>
							<TableHead className="text-right">steps</TableHead>
							<TableHead>created</TableHead>
							<TableHead>hypothesis</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{merged.map((r) => (
							<TableRow key={r.id}>
								<TableCell className="font-mono">
									<Link
										className="underline"
										to="/trainings/$runId"
										params={{ runId: r.id }}
									>
										{r.name}
									</Link>
								</TableCell>
								<TableCell>
									<StatusBadge tone={statusTone[r.status] ?? "neutral"}>
										{r.status}
									</StatusBadge>
								</TableCell>
								<TableCell className="font-mono">
									{r.config?.datasetRepoId ?? "—"}
								</TableCell>
								<TableCell className="text-right tabular-nums">
									{r.config?.steps ?? "—"}
								</TableCell>
								<TableCell>{r.createdAt?.slice(0, 10) ?? "—"}</TableCell>
								<TableCell
									className="max-w-md truncate"
									title={r.hypothesis ?? undefined}
								>
									{r.hypothesis ?? "—"}
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			)}
		</div>
	);
}
