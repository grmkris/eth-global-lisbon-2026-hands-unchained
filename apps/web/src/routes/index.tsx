import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, Check, TriangleAlert } from "lucide-react";
import { PageHeader } from "#/components/page-header";
import { ArmStateBadge, SimBadge } from "#/components/status-badge";
import { Button } from "#/components/ui/button";
import {
	Card,
	CardAction,
	CardContent,
	CardHeader,
	CardTitle,
} from "#/components/ui/card";
import { modeQuery } from "#/lib/hub-api";
import {
	cameraStatusQuery,
	datasetsQuery,
	healthQuery,
	robotStateQuery,
	runsQuery,
} from "#/lib/queries";
import { LobbyPage } from "./lobby";

export const Route = createFileRoute("/")({ component: Home });

function CardLink({
	to,
	children,
}: {
	to: "/robot" | "/datasets" | "/trainings" | "/record" | "/trainings/new";
	children: React.ReactNode;
}) {
	return (
		<Button asChild variant="ghost" size="sm" className="text-muted-foreground">
			<Link to={to}>
				{children}
				<ArrowRight />
			</Link>
		</Button>
	);
}

function Home() {
	const mode = useQuery(modeQuery);
	// A hub has no arm and no local dataset cache — send it to the lobby rather
	// than render a dashboard about hardware it does not have.
	if (mode.data?.mode === "hub") return <LobbyPage />;
	if (mode.isPending) return null;
	return <LabDashboard />;
}

function LabDashboard() {
	const health = useQuery(healthQuery);
	const robot = useQuery(robotStateQuery);
	const cams = useQuery(cameraStatusQuery);
	const datasets = useQuery(datasetsQuery);
	const runs = useQuery(runsQuery);

	const r = robot.data;
	const c = cams.data;
	const latestDataset = datasets.data?.[0];
	const launched = (runs.data ?? []).filter((x) => x.status === "launched");

	return (
		<div>
			<PageHeader
				title="Lab Console"
				description={
					health.isPending
						? "checking…"
						: health.isError
							? "API unreachable"
							: `hf ${health.data.hfUser} · v${health.data.version}`
				}
			/>

			<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
				<Card>
					<CardHeader>
						<CardTitle>Rig</CardTitle>
						<CardAction>
							<CardLink to="/robot">robot page</CardLink>
						</CardAction>
					</CardHeader>
					<CardContent className="text-sm">
						<p className="flex items-center gap-2">
							arm: <ArmStateBadge state={r?.state} />
							{r && r.state !== "disconnected" && (
								<span className="text-muted-foreground">
									{r.backend}
									{r.source ? ` · ${r.source}` : ""}
									{r.backend === "real" && !r.leader ? " · no leader" : ""}
								</span>
							)}
						</p>
						<p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
							cameras:{" "}
							{c
								? c.previewing.length > 0
									? c.previewing.map((name) => {
											const b = c.brightness[name];
											const inBand =
												b !== undefined &&
												b >= c.brightnessBand.min &&
												b <= c.brightnessBand.max;
											return (
												<span key={name} className="flex items-center gap-1">
													{name} ({b ?? "…"}
													{b !== undefined &&
														(inBand ? (
															<Check className="size-3.5 text-success" />
														) : (
															<TriangleAlert className="size-3.5 text-warn" />
														))}
													)
												</span>
											);
										})
									: c.mapping.workspace !== null && c.mapping.wrist !== null
										? "confirmed, not previewing"
										: "not confirmed — verify indexes before a session"
								: "…"}
						</p>
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle>Trainings in flight</CardTitle>
						<CardAction>
							<CardLink to="/trainings">all runs</CardLink>
						</CardAction>
					</CardHeader>
					<CardContent className="text-sm">
						{launched.length === 0 ? (
							<p className="text-muted-foreground">
								none launched —{" "}
								<Link className="underline" to="/trainings/new">
									start one
								</Link>
							</p>
						) : (
							<ul className="flex flex-col gap-1">
								{launched.map((run) => (
									<li key={run.id} className="font-mono">
										<Link
											className="underline"
											to="/trainings/$runId"
											params={{ runId: run.id }}
										>
											{run.name}
										</Link>
										{run.config && (
											<span className="text-muted-foreground">
												{" "}
												· {run.config.steps} steps
											</span>
										)}
									</li>
								))}
							</ul>
						)}
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle>Latest dataset</CardTitle>
						<CardAction>
							<CardLink to="/datasets">all datasets</CardLink>
						</CardAction>
					</CardHeader>
					<CardContent className="text-sm">
						{latestDataset ? (
							<p className="flex items-center gap-2 font-mono">
								{latestDataset.repoId}
								<span className="text-muted-foreground">
									{latestDataset.totalEpisodes
										? `· ${latestDataset.totalEpisodes} eps`
										: ""}
								</span>
								{latestDataset.sim && <SimBadge />}
							</p>
						) : (
							<p className="text-muted-foreground">none yet</p>
						)}
						<p className="mt-2">
							<Link className="underline" to="/record">
								record a session
							</Link>
						</p>
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle>API</CardTitle>
					</CardHeader>
					<CardContent className="text-sm">
						<p className="text-muted-foreground">
							<a className="underline" href="/api/docs">
								docs
							</a>{" "}
							·{" "}
							<a className="underline" href="/api/openapi.json">
								openapi.json
							</a>
						</p>
					</CardContent>
				</Card>
			</div>
		</div>
	);
}
