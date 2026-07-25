import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
	Hand,
	OctagonX,
	Play,
	Plug,
	Square,
	TriangleAlert,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CamFeed, CamOffAir } from "#/components/cam-feed";
import { ErrorNote } from "#/components/error-note";
import { KeyJogPad } from "#/components/key-jog-pad";
import { OwnerPanel } from "#/components/owner-panel";
import { PageHeader } from "#/components/page-header";
import {
	ArmStateBadge,
	SimBadge,
	StatusBadge,
} from "#/components/status-badge";
import { TaskPanel } from "#/components/task-panel";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { Button } from "#/components/ui/button";
import { Card, CardContent } from "#/components/ui/card";
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

	// What is consuming input right now — the record source while a session runs,
	// otherwise the live teleop source. Only keys/phone accept browser axes; a
	// leader's joints go through set_joints and cannot take them.
	const armState = rig.data?.armState;
	const inTeleop = armState === "teleop" || armState === "recording";
	const sink =
		rig.data?.record?.active === true
			? (rig.data.record.source ?? null)
			: (rig.data?.source ?? null);
	const axesSink = sink === "keys" || sink === "phone";
	const padArmed = armState === "connected" || axesSink;
	const padReason =
		padArmed || armState === undefined
			? null
			: armState === "disconnected"
				? "the arm is not connected"
				: sink === "remote"
					? `${drivingLeader?.name ?? "a remote"}'s leader arm is driving — stop it to use the keyboard`
					: sink === "leader"
						? "the rig's own leader arm is driving — stop teleop to use the keyboard"
						: `${sink ?? "another source"} is driving`;

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

					{/* Only what can actually succeed right now. Connect SIM/REAL became
					    one recovery button (the rig reports its own backend, and it
					    autoconnects at boot); "Teleop (keys)" is gone because the jog pad
					    starts keys teleop itself; the rig-local leader button appears only
					    when a leader arm is really attached — it used to offer itself on
					    every rig and then fail with "connect with the leader arm first". */}
					{(iAmDriving || inTeleop || data?.online) && (
						<div className="flex flex-wrap items-center gap-2">
							{iAmDriving && data?.armState === "disconnected" && (
								<Button
									size="sm"
									variant="outline"
									onClick={() =>
										command.mutate(
											data.backend === "sim" ? "connect_sim" : "connect_real",
										)
									}
								>
									<Plug />
									Connect ({data.backend === "sim" ? "sim" : "real arm"})
								</Button>
							)}
							{iAmDriving && data?.leader && data.armState === "connected" && (
								<Button
									size="sm"
									variant="outline"
									onClick={() => command.mutate("teleop_start_leader")}
								>
									<Play />
									Drive with the rig's own leader arm
								</Button>
							)}
							{/* remote leader agents — the hub relays "drive this rig" */}
							{iAmDriving &&
								data?.armState !== "disconnected" &&
								onlineLeaders
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
							{/* Safety verbs bypass the lease on purpose: anyone watching a rig
							    misbehave can stop it. One instance each, for everyone. */}
							{inTeleop && (
								<Button
									size="sm"
									variant="outline"
									onClick={() => command.mutate("teleop_stop")}
								>
									<Square />
									Stop teleop
								</Button>
							)}
							{data?.online && (
								<Button
									size="sm"
									variant="destructive"
									onClick={() => command.mutate("estop")}
								>
									<OctagonX />
									E-STOP
								</Button>
							)}
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

					{/* The pad ARMS itself: focusing it starts keys teleop when the arm is
					    merely connected, so "Teleop (keys)" is not a button you can forget
					    to press. It goes inert when something else owns the input instead
					    of fighting it — a leader's joints and browser axes share one
					    single-slot mailbox, and axes would displace the leader's packet
					    AND then fail rig-side ("no input-driven teleop source active"),
					    which looked like nothing happening. */}
					{iAmDriving ? (
						<KeyJogPad
							onAxes={onAxes}
							armed={padArmed}
							disabledReason={padReason}
							onArm={() => {
								// Not while a leader owns this rig: arming keys teleop here
								// stole the source from a bound leader, and the driver then
								// refused teleop_start_remote ("teleop already active"), so
								// the leader streamed into a keys source and the arm went
								// dead. The hub's drive command now recovers from that
								// anyway (teleop_stop first), but don't cause it.
								if (data?.armState === "connected" && !drivingLeader)
									command.mutate("teleop_start");
							}}
						/>
					) : (
						<p className="text-sm text-muted-foreground">
							Take control to drive. Video stays live either way.
						</p>
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

			{data && (
				<div className="mt-4 flex flex-col gap-4">
					<OwnerPanel
						rig={data}
						busy={commandWith.isPending}
						onCommand={ownerCommand}
						onUpsert={(ownerKey, task) =>
							commandWith.mutate({
								verb: "task_upsert",
								ownerKey,
								args: { task },
							})
						}
						onPush={(ownerKey, repoName) =>
							commandWith.mutate({
								verb: "dataset_push",
								ownerKey,
								args: { repoName },
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
