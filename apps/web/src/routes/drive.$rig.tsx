import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Hand, OctagonX, Play, Square, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CamFeed, CamOffAir } from "#/components/cam-feed";
import { ErrorNote } from "#/components/error-note";
import { KeyJogPad } from "#/components/key-jog-pad";
import { PageHeader } from "#/components/page-header";
import {
	ArmStateBadge,
	SimBadge,
	StatusBadge,
} from "#/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { Button } from "#/components/ui/button";
import { Card, CardContent } from "#/components/ui/card";
import { apiErrorMessage } from "#/lib/errors";
import {
	claimRig,
	clientId,
	releaseRig,
	rigQuery,
	sendRigCommand,
	sendRigInput,
} from "#/lib/hub-api";

export const Route = createFileRoute("/drive/$rig")({ component: DrivePage });

function DrivePage() {
	const { rig: rigName } = Route.useParams();
	const rig = useQuery(rigQuery(rigName));
	const [rtt, setRtt] = useState<number | null>(null);

	const holder = rig.data?.holder ?? null;
	const iAmDriving = holder === clientId;

	const claim = useMutation({
		// Taking over from a live holder is a force-steal (friends-only hub);
		// the kicked client learns on its next input and backs off.
		mutationFn: (force: boolean) => claimRig(rigName, force),
		onSuccess: () => toast.success("you have control"),
		onError: (e) => toast.error(apiErrorMessage(e)),
	});
	const release = useMutation({
		mutationFn: () => releaseRig(rigName),
		onSuccess: () => toast.success("control released"),
	});
	const command = useMutation({
		mutationFn: (verb: string) => sendRigCommand(rigName, verb),
		onError: (e) => toast.error(apiErrorMessage(e)),
	});

	// Hand control back when the tab closes so the rig is not stuck held.
	useEffect(() => {
		const drop = () => {
			if (iAmDriving)
				navigator.sendBeacon?.(
					`/api/hub/rigs/${encodeURIComponent(rigName)}/release`,
					new Blob([JSON.stringify({ clientId })], {
						type: "application/json",
					}),
				);
		};
		window.addEventListener("pagehide", drop);
		return () => {
			window.removeEventListener("pagehide", drop);
			drop(); // client-side nav away: hand the rig back immediately
		};
	}, [iAmDriving, rigName]);

	// Hold the slot with a lease renewal that carries NO axes. Renewing via the
	// input path would resend the last command forever and a frozen tab would
	// leave the arm driving — the keepalive must not be a control packet.
	useEffect(() => {
		if (!iAmDriving) return;
		const t = setInterval(() => void claimRig(rigName).catch(() => {}), 5_000);
		return () => clearInterval(t);
	}, [iAmDriving, rigName]);

	const onAxes = (axes: Record<string, number>) => {
		const started = performance.now();
		void sendRigInput(rigName, axes)
			.then(() => setRtt(Math.round(performance.now() - started)))
			.catch(() => setRtt(null));
	};

	if (rig.isError)
		return (
			<div>
				<PageHeader title={rigName} back={{ to: "/lobby", label: "Lobby" }} />
				<ErrorNote error={rig.error} />
			</div>
		);

	const data = rig.data;
	const cams = data?.cams ?? [];

	return (
		<div>
			<PageHeader
				title={rigName}
				titleClassName="font-mono"
				back={{ to: "/lobby", label: "Lobby" }}
				badge={
					<span className="flex items-center gap-2">
						{data?.backend === "sim" && <SimBadge />}
						<ArmStateBadge state={data?.armState} />
						{data && !data.online && (
							<StatusBadge tone="danger">offline</StatusBadge>
						)}
					</span>
				}
				actions={
					iAmDriving ? (
						<Button
							variant="outline"
							onClick={() => release.mutate()}
							disabled={release.isPending}
						>
							Release control
						</Button>
					) : (
						<Button
							onClick={() => {
								if (
									holder &&
									!confirm("Someone is driving this rig. Take over anyway?")
								)
									return;
								claim.mutate(holder !== null);
							}}
							disabled={claim.isPending || !data?.online}
						>
							<Hand />
							{holder ? "Take over" : "Take control"}
						</Button>
					)
				}
			/>

			<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
				{/* cam names come from the rig's own advertisement — no hardcoded list */}
				{(cams.length > 0 ? cams : ["camera"]).map((cam) =>
					data?.online && cams.includes(cam) ? (
						<CamFeed
							key={cam}
							name={cam}
							src={`/api/hub/cams/${encodeURIComponent(rigName)}/${encodeURIComponent(cam)}`}
						/>
					) : (
						<CamOffAir
							key={cam}
							name={cam}
							note="no frames from this rig yet"
						/>
					),
				)}
			</div>

			<Card className="mt-4">
				<CardContent className="flex flex-col gap-3">
					<div className="flex flex-wrap items-center gap-4 text-sm">
						<StatusBadge tone={iAmDriving ? "success" : "neutral"}>
							{iAmDriving
								? "you are driving"
								: holder
									? "someone else is driving"
									: "nobody driving"}
						</StatusBadge>
						<span className="font-mono text-muted-foreground">
							link {data?.linkMs ?? "…"}ms
							{rtt !== null ? ` · your rtt ${rtt}ms` : ""}
						</span>
					</div>

					{iAmDriving && (
						<div className="flex flex-wrap gap-2">
							<Button
								size="sm"
								variant="outline"
								onClick={() => command.mutate("connect_sim")}
							>
								Connect SIM
							</Button>
							<Button
								size="sm"
								variant="outline"
								onClick={() => command.mutate("connect_real")}
							>
								Connect REAL
							</Button>
							<Button
								size="sm"
								variant="outline"
								onClick={() => command.mutate("teleop_start")}
							>
								<Play />
								Teleop (keys)
							</Button>
							<Button
								size="sm"
								variant="outline"
								onClick={() => command.mutate("teleop_start_leader")}
							>
								<Play />
								Teleop (leader arm)
							</Button>
							<Button
								size="sm"
								variant="outline"
								onClick={() => command.mutate("teleop_stop")}
							>
								<Square />
								Stop teleop
							</Button>
							<Button
								size="sm"
								variant="destructive"
								onClick={() => command.mutate("estop")}
							>
								<OctagonX />
								E-STOP
							</Button>
						</div>
					)}

					{data?.lastError && (
						<Alert className="border-warn/50 text-warn [&>svg]:text-warn">
							<TriangleAlert />
							<AlertTitle>Rig reported a fault</AlertTitle>
							<AlertDescription className="font-mono text-xs">
								{data.lastError}
							</AlertDescription>
						</Alert>
					)}

					{iAmDriving ? (
						<KeyJogPad onAxes={onAxes} />
					) : (
						<div className="flex flex-wrap items-center gap-3">
							<p className="text-sm text-muted-foreground">
								Take control to drive. Video stays live either way.
							</p>
							{/* Safety verbs work without the lease — anyone watching a rig
							    misbehave can stop it. */}
							<Button
								size="sm"
								variant="outline"
								onClick={() => command.mutate("teleop_stop")}
							>
								<Square />
								Stop teleop
							</Button>
							<Button
								size="sm"
								variant="destructive"
								onClick={() => command.mutate("estop")}
							>
								<OctagonX />
								E-STOP
							</Button>
						</div>
					)}

					{data && Object.keys(data.joints).length > 0 && (
						<div className="grid grid-cols-3 gap-2 font-mono text-xs md:grid-cols-6">
							{Object.entries(data.joints).map(([joint, pos]) => (
								<div key={joint} className="rounded bg-muted p-2">
									<div className="text-muted-foreground">{joint}</div>
									<div className="tabular-nums">{pos.toFixed(1)}</div>
								</div>
							))}
						</div>
					)}
				</CardContent>
			</Card>
		</div>
	);
}
