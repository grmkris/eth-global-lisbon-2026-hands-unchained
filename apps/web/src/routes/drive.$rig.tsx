import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
	Keyboard,
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
import { LeaderInputDebugPanel } from "#/components/leader-input-debug";
import { OwnerPanel } from "#/components/owner-panel";
import { PageHeader } from "#/components/page-header";
import { StakeGate } from "#/components/stake-gate";
import {
	ArmStateBadge,
	SimBadge,
	StatusBadge,
} from "#/components/status-badge";
import { TaskPanel } from "#/components/task-panel";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { Button } from "#/components/ui/button";
import { Card, CardContent } from "#/components/ui/card";
import { WalletChip } from "#/components/wallet-chip";
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
import { marketSessionQuery } from "#/market/market-api";

export const Route = createFileRoute("/drive/$rig")({ component: DrivePage });

/** How the operator wants to move the arm — the entry point to everything. */
type DriveChoice =
	| { kind: "keys" }
	| { kind: "rigLeader" }
	| { kind: "leader"; name: string };

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
	const market = useQuery(marketSessionQuery);
	const [rtt, setRtt] = useState<number | null>(null);

	const holder = rig.data?.holder ?? null;
	const iAmDriving = holder === clientId;
	// market on + not verified, or verified but no stake posted -> the hub
	// will 402 every claim ("verification required" / "bond required")
	const marketOn = market.data?.marketMode === true;
	const needsVerify = marketOn && market.data?.verified === false;
	const needsStake =
		marketOn &&
		market.data?.verified === true &&
		market.data.stake?.bond == null;
	const gated = needsVerify || needsStake;

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

	/**
	 * Picking how you drive IS taking the rig.
	 *
	 * The lease exists for real reasons (single writer; the identity stamped onto
	 * every attempt) but nobody thinks "I would like to acquire a lease" — they
	 * think "I want to drive this arm with my leader". So there is no Take
	 * control button: each Drive choice claims first and then starts that source.
	 *
	 * Sequential on purpose: the hub 403s the leader-drive branch unless the
	 * caller ALREADY holds the lease ("take control first"), so the claim has to
	 * land before the bind.
	 */
	const drive = useMutation({
		mutationFn: async (choice: DriveChoice) => {
			await claimRig(rigName, holder !== null && holder !== clientId);
			if (choice.kind === "leader")
				return sendLeaderCommand(choice.name, "drive", rigName);
			return sendRigCommand(
				rigName,
				choice.kind === "rigLeader" ? "teleop_start_leader" : "teleop_start",
			);
		},
		onSuccess: (_d, choice) =>
			toast.success(
				choice.kind === "leader"
					? `${choice.name}'s leader is taking the rig`
					: choice.kind === "rigLeader"
						? "driving with the rig's own leader arm"
						: "you are driving with the keyboard",
			),
		// a lost claim race answers 409 with no `error` key, so say something useful
		onError: (e) =>
			toast.error(
				apiErrorMessage(e) === "Conflict"
					? "someone else took the rig first"
					: apiErrorMessage(e) === "verification required"
						? "verify your World ID above to take control"
						: apiErrorMessage(e) === "bond required"
							? "stake above to take control"
							: apiErrorMessage(e),
			),
	});
	/** Ask before stealing a live holder's rig — friends-tier, same as before. */
	const pickSource = (choice: DriveChoice) => {
		if (gated) {
			toast.error(
				needsVerify
					? "verify your World ID above to take control"
					: "stake above to take control",
			);
			return;
		}
		if (
			holder &&
			holder !== clientId &&
			!confirm("Someone is driving this rig. Take over anyway?")
		)
			return;
		drive.mutate(choice);
	};

	// What is consuming input right now — the record source while a session runs,
	// otherwise the live teleop source. Only keys/phone accept browser axes; a
	// leader's joints go through set_joints and cannot take them.
	const recordingNow = rig.data?.record?.active === true;
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

	/**
	 * Why "Start attempt" cannot work yet — the fix for the trap that recorded an
	 * episode with NOTHING driving the arm. attempts.ts takes whatever source is
	 * live (`priorSource = robotState.source ?? "keys"`), so an attempt started
	 * before choosing a source burns an episode against the task's quota while
	 * the arm sits still.
	 */
	const attemptBlockedReason =
		rig.data === undefined || !rig.data.online
			? "the rig is offline"
			: needsVerify
				? "verify your World ID to drive"
				: needsStake
					? "stake to drive"
					: armState === "disconnected"
						? "the arm is not connected"
						: rig.data.backend === "real" &&
								(rig.data.camMapping?.workspace === null ||
									rig.data.camMapping?.wrist === null)
							? "cameras not confirmed — the rig owner must assign workspace/wrist"
							: !inTeleop || sink === null
								? "pick how you'll drive first"
								: !iAmDriving
									? "someone else is driving this rig"
									: null;

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
					// No "Take control": you take the rig by choosing how to drive it.
					// Release stays so a booth visitor can hand it back.
					iAmDriving ? (
						<Button
							variant="outline"
							onClick={() => {
								// the attempt watcher discards a partial episode 30s after the
								// holder goes away — don't let that happen by surprise
								if (
									myAttempt &&
									!confirm(
										"An attempt is recording. Releasing the rig will discard it. Continue?",
									)
								)
									return;
								release.mutate();
							}}
							disabled={release.isPending}
						>
							Release control
						</Button>
					) : null
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

			{gated && market.data && (
				<div className="mt-4">
					<StakeGate session={market.data} />
				</div>
			)}

			{/* Cameras, then how you drive, THEN the tasks. Starting an attempt is
			    the one thing you do while watching the feed and the teleop panel at
			    the same time — tasks in between pushed them a screen apart. */}
			<Card className="mt-4">
				<CardContent className="flex flex-col gap-3">
					{/* the operator's money, visible while they work */}
					{market.data && <WalletChip session={market.data} />}
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
							{data ? ` · input ${data.inputTransport}` : ""}
						</span>
						{data?.inputTransport === "http" && (
							<StatusBadge
								tone="warn"
								title="the rig's input socket is down — input rides the polled HTTP link (slower)"
							>
								input: http fallback
							</StatusBadge>
						)}
					</div>

					<LeaderInputDebugPanel
						leader={drivingLeader?.name ?? null}
						input={data?.leaderInputDebug ?? null}
					/>

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
							{/* Drive choices: each CLAIMS the rig and starts that source. Not
							    gated on holding it — choosing is how you take it. All go quiet
							    during a recording: the recorder owns the arm, so teleop_start*
							    is refused ("recording is active") and the click would
							    half-succeed, binding a leader whose joints then hit a source
							    that cannot accept them, silently, at ~25 packets/s. */}
							{data?.online && armState !== "disconnected" && !recordingNow && (
								<Button
									size="sm"
									variant={sink === "keys" ? "default" : "outline"}
									disabled={drive.isPending}
									onClick={() => pickSource({ kind: "keys" })}
								>
									<Keyboard />
									{sink === "keys" && iAmDriving
										? "driving — keyboard"
										: "Drive with keyboard"}
								</Button>
							)}
							{data?.leader && armState === "connected" && !recordingNow && (
								<Button
									size="sm"
									variant="outline"
									disabled={drive.isPending}
									onClick={() => pickSource({ kind: "rigLeader" })}
								>
									<Play />
									Drive with the rig's own leader arm
								</Button>
							)}
							{/* remote leader agents — the hub relays "drive this rig" */}
							{data?.online &&
								armState !== "disconnected" &&
								!recordingNow &&
								onlineLeaders
									.filter((l) => l.driving === null)
									.map((l) => (
										<Button
											key={l.name}
											size="sm"
											variant="outline"
											disabled={drive.isPending}
											onClick={() =>
												pickSource({ kind: "leader", name: l.name })
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
							Pick how you'll drive above. Video stays live either way.
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
					<TaskPanel
						rig={data}
						iAmDriving={iAmDriving}
						myAttempt={myAttempt}
						blockedReason={attemptBlockedReason}
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
