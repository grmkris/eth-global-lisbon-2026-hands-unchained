import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Hand, OctagonX, Play, Square, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CamFeed, CamOffAir } from "#/components/cam-feed";
import { CameraSetup } from "#/components/camera-setup";
import { ErrorNote } from "#/components/error-note";
import { KeyJogPad } from "#/components/key-jog-pad";
import { OwnerPanel } from "#/components/owner-panel";
import { PageHeader } from "#/components/page-header";
import { RecordPanel } from "#/components/record-panel";
import {
	ArmStateBadge,
	SimBadge,
	StatusBadge,
} from "#/components/status-badge";
import { TaskPanel } from "#/components/task-panel";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { Button } from "#/components/ui/button";
import { Card, CardContent } from "#/components/ui/card";
import { DEFAULT_HUB } from "#/lib/constants";
import { apiErrorMessage } from "#/lib/errors";
import {
	claimRig,
	clientId,
	leadersQuery,
	ownerKeyStore,
	releaseRig,
	rigQuery,
	sendLeaderCommand,
	sendRigCommand,
	sendRigInput,
} from "#/lib/hub-api";

export const Route = createFileRoute("/drive/$rig")({ component: DrivePage });

/** Bring-your-own-leader onboarding: run one command, then a "Drive with
 * your leader" button appears in the controls above. */
function LeaderOnboardCard() {
	const origin = typeof window === "undefined" ? "" : window.location.origin;
	const hubFlag = origin && origin !== DEFAULT_HUB ? ` --hub ${origin}` : "";
	const commands = `cd apps/driver && uv sync   # first time only\ncd ../web && bun run teleop${hubFlag}`;
	return (
		<Card className="mt-4">
			<CardContent className="flex flex-col gap-2 text-sm">
				<div className="font-medium">Drive with your own leader arm</div>
				<p className="text-muted-foreground">
					Plug in your SO-101 leader, run this from a clone of the repo, and a
					"Drive with your leader" button appears here. First run walks you
					through lerobot's calibration.
				</p>
				<pre className="overflow-x-auto rounded bg-muted p-3 font-mono text-xs">
					{commands}
				</pre>
				<div>
					<Button
						size="sm"
						variant="outline"
						onClick={() => {
							navigator.clipboard.writeText(commands.replace(/ {3}#.*$/m, ""));
							toast.success("commands copied");
						}}
					>
						copy
					</Button>
				</div>
			</CardContent>
		</Card>
	);
}

/**
 * Age of the newest frame the HUB holds, measured hub-side — so it covers the
 * rig->hub half of the path (capture, push cadence, uplink) and not the
 * hub->browser half. That is the half we control, and the half that degrades
 * on a bad uplink: a number that climbs instead of holding steady means the
 * rig cannot carry the push cadence and is falling behind.
 */
function FrameAge({ ms }: { ms: number | undefined }) {
	if (ms === undefined) return null;
	return <span>{ms} ms</span>;
}

function DrivePage() {
	const { rig: rigName } = Route.useParams();
	const rig = useQuery(rigQuery(rigName));
	const leaders = useQuery(leadersQuery);
	const [rtt, setRtt] = useState<number | null>(null);

	const holder = rig.data?.holder ?? null;
	const iAmDriving = holder === clientId;

	// leader agents registered on the hub (controller.py on operator machines).
	// A leader never holds the lease — it is a bound input device of a browser
	// session, so the holder stays whoever clicked Drive.
	const onlineLeaders = (leaders.data ?? []).filter((l) => l.online);
	const drivingLeader = onlineLeaders.find((l) => l.driving === rigName);

	const leaderCommand = useMutation({
		mutationFn: (input: { name: string; action: "drive" | "stop" }) =>
			sendLeaderCommand(input.name, input.action, rigName),
		onSuccess: (_d, input) =>
			toast.success(
				input.action === "drive"
					? `${input.name}'s leader is taking the rig`
					: `stopping ${input.name}'s leader`,
			),
		onError: (e) => toast.error(apiErrorMessage(e)),
	});

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
	const commandWith = useMutation({
		mutationFn: (input: {
			verb: string;
			args?: Record<string, unknown>;
			ownerKey?: string;
		}) =>
			sendRigCommand(rigName, input.verb, {
				args: input.args,
				ownerKey: input.ownerKey,
			}),
		onError: (e) => toast.error(apiErrorMessage(e)),
	});

	const myAttempt =
		rig.data?.attempt?.active === true &&
		rig.data.attempt.operator === clientId;

	// owner verbs carry the stored key; rejection surfaces via lastCommandResult
	const ownerCommand = (verb: string, args?: Record<string, unknown>) =>
		commandWith.mutate({
			verb,
			args,
			ownerKey: ownerKeyStore.get(rigName),
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
	// While MY attempt runs, keep claiming even if the lease evaporated (a hub
	// redeploy wipes leases; without this the attempt would be orphaned).
	useEffect(() => {
		if (!iAmDriving && !myAttempt) return;
		const t = setInterval(() => void claimRig(rigName).catch(() => {}), 5_000);
		return () => clearInterval(t);
	}, [iAmDriving, myAttempt, rigName]);

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
							statusLine={<FrameAge ms={data.camAgeMs?.[cam]} />}
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

			{data && (
				<div className="mt-4 flex flex-col gap-4">
					<TaskPanel
						rig={data}
						iAmDriving={iAmDriving}
						myAttempt={myAttempt}
						busy={commandWith.isPending}
						onStart={(taskId) =>
							commandWith.mutate({ verb: "attempt_start", args: { taskId } })
						}
						onFinish={(success) =>
							commandWith.mutate({ verb: "attempt_finish", args: { success } })
						}
					/>
				</div>
			)}

			<Card className="mt-4">
				<CardContent className="flex flex-col gap-3">
					<div className="flex flex-wrap items-center gap-4 text-sm">
						<StatusBadge tone={iAmDriving ? "success" : "neutral"}>
							{iAmDriving
								? drivingLeader
									? `you are driving — via ${drivingLeader.name}'s leader`
									: "you are driving"
								: holder
									? drivingLeader
										? `someone else is driving — via ${drivingLeader.name}'s leader`
										: "someone else is driving"
									: "nobody driving"}
						</StatusBadge>
						{drivingLeader && (
							<Button
								size="sm"
								variant="outline"
								disabled={leaderCommand.isPending}
								onClick={() =>
									leaderCommand.mutate({
										name: drivingLeader.name,
										action: "stop",
									})
								}
							>
								<Square />
								Stop {drivingLeader.name}'s leader
							</Button>
						)}
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
							{/* remote leader agents — the hub relays "drive this rig" */}
							{onlineLeaders
								.filter((l) => l.driving === null)
								.map((l) => (
									<Button
										key={l.name}
										size="sm"
										variant="outline"
										disabled={leaderCommand.isPending}
										onClick={() =>
											leaderCommand.mutate({ name: l.name, action: "drive" })
										}
									>
										<Play />
										Drive with {l.name}'s leader
									</Button>
								))}
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

					{/* The pad stays live while your leader drives: keyboard axes and
					    leader joints are latest-wins on the same mailbox, so whichever
					    packet lands last wins. Undesigned, not a bug. */}
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

			{data?.online && <LeaderOnboardCard />}

			{data && (
				<div className="mt-4 flex flex-col gap-4">
					<CameraSetup
						rig={data}
						busy={commandWith.isPending}
						onCommand={ownerCommand}
					/>
					<RecordPanel
						rig={data}
						busy={commandWith.isPending}
						onCommand={ownerCommand}
					/>
					<OwnerPanel
						rig={data}
						busy={commandWith.isPending}
						onUpsert={(ownerKey, task) =>
							commandWith.mutate({
								verb: "task_upsert",
								ownerKey,
								args: { task },
							})
						}
						onDelete={(ownerKey, id) =>
							commandWith.mutate({
								verb: "task_delete",
								ownerKey,
								args: { id },
							})
						}
					/>
				</div>
			)}
		</div>
	);
}
