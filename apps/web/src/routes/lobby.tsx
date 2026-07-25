import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Cpu, Radio } from "lucide-react";
import { ErrorNote } from "#/components/error-note";
import { HubTokenGate } from "#/components/hub-token-gate";
import { PageHeader } from "#/components/page-header";
import { SimBadge, StatusBadge } from "#/components/status-badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent } from "#/components/ui/card";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "#/components/ui/empty";
import { Skeleton } from "#/components/ui/skeleton";
import { impairmentQuery, rigsQuery } from "#/lib/hub-api";

export const Route = createFileRoute("/lobby")({ component: LobbyPage });

/** Also rendered at `/` on a hub, where a local-rig dashboard would be a lie. */
export function LobbyPage() {
	const rigs = useQuery(rigsQuery);
	const impairment = useQuery(impairmentQuery);
	const imp = impairment.data;

	return (
		<div>
			<PageHeader
				title="Lobby"
				description="Rigs registered with this hub. Each one dials out — no inbound ports, no port forwarding."
				badge={
					imp && (imp.latencyMs > 0 || imp.dropRate > 0) ? (
						<StatusBadge tone="warn">
							impaired: {imp.latencyMs}ms · {Math.round(imp.dropRate * 100)}%
							drop
						</StatusBadge>
					) : undefined
				}
			/>

			{rigs.isPending ? (
				<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
					<Skeleton className="h-64 w-full" />
					<Skeleton className="h-64 w-full" />
				</div>
			) : rigs.isError ? (
				rigs.error.message === "unauthorized" ? (
					<HubTokenGate />
				) : (
					<ErrorNote error={rigs.error} />
				)
			) : rigs.data.length === 0 ? (
				<Empty className="border">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<Radio />
						</EmptyMedia>
						<EmptyTitle>No rigs registered</EmptyTitle>
						<EmptyDescription>
							Start a rig with HUB_URL pointing here and it will appear within a
							couple of seconds.
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : (
				<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
					{rigs.data.map((rig) => (
						<Card key={rig.name}>
							<CardContent className="flex flex-col gap-3">
								<div className="flex items-center justify-between">
									<span className="flex items-center gap-2 font-mono font-medium">
										<Cpu className="size-4 text-muted-foreground" />
										{rig.name}
									</span>
									<span className="flex items-center gap-2">
										{rig.backend === "sim" && <SimBadge />}
										<StatusBadge tone={rig.online ? "success" : "neutral"}>
											{rig.online ? "online" : "offline"}
										</StatusBadge>
									</span>
								</div>

								<div className="aspect-[4/3] overflow-hidden rounded bg-black">
									{rig.online && rig.cams.length > 0 ? (
										<img
											src={`/api/hub/cams/${encodeURIComponent(rig.name)}/${encodeURIComponent(rig.cams[0])}`}
											alt={`${rig.name} preview`}
											className="size-full object-contain"
										/>
									) : (
										<div className="flex size-full items-center justify-center text-xs text-white/50">
											no feed
										</div>
									)}
								</div>

								<p className="font-mono text-xs text-muted-foreground">
									arm {rig.armState}
									{rig.source ? ` · ${rig.source}` : ""} · link {rig.linkMs}ms
									{rig.holder ? " · in use" : ""}
								</p>

								{/* `disabled` on an asChild anchor does nothing — render a
								    real disabled button instead of a clickable dead link */}
								{rig.online ? (
									<Button asChild>
										<Link to="/drive/$rig" params={{ rig: rig.name }}>
											{rig.holder ? "Watch" : "Drive this rig"}
										</Link>
									</Button>
								) : (
									<Button disabled>Rig offline</Button>
								)}
							</CardContent>
						</Card>
					))}
				</div>
			)}
		</div>
	);
}
