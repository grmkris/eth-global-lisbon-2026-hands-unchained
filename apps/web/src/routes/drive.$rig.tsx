import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { AttemptBar } from "#/components/attempt-bar";
import { ControlRail } from "#/components/control-rail";
import { DiagnosticsFold } from "#/components/diagnostics-fold";
import { ErrorNote } from "#/components/error-note";
import { KeyJogPad } from "#/components/key-jog-pad";
import { OwnerPanel } from "#/components/owner-panel";
import { PageHeader } from "#/components/page-header";
import { RigViewport } from "#/components/rig-viewport";
import { SlotTerms, StartRequirements } from "#/components/slot-gate";
import { SlotPanel } from "#/components/slot-panel";
import { type DriveChoice, SourcePicker } from "#/components/source-picker";
import {
	ArmStateBadge,
	SimBadge,
	StatusBadge,
} from "#/components/status-badge";
import { TaskPanel } from "#/components/task-panel";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { Button } from "#/components/ui/button";
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
import { useAttemptChain } from "#/lib/use-attempt-chain";
import { useStartRequirements } from "#/lib/use-start-requirements";
import { marketSessionQuery, taskProgressQuery } from "#/market/market-api";
import { useSlot } from "#/market/use-slot";

// The one page that breaks the reading-width column (see __root.tsx): you drive
// by watching the camera, and at 1024px two feeds are 480px stamps.
export const Route = createFileRoute("/drive/$rig")({
	component: DrivePage,
	staticData: { wide: true },
});

function DrivePage() {
	const { rig: rigName } = Route.useParams();
	const rig = useQuery(rigQuery(rigName));
	const leaders = useQuery(leadersQuery);
	const market = useQuery(marketSessionQuery);
	/** what the referee kept per task — drives the progress bar and the
	 * "complete" gate, so neither is made of failed work */
	const taskProgress = useQuery(taskProgressQuery(rigName));
	const [rtt, setRtt] = useState<number | null>(null);

	const holder = rig.data?.holder ?? null;
	const iAmDriving = holder === clientId;
	// market on + not verified, or no slot on this rig -> the hub will 402
	// every claim ("verification required" / "book a slot" / "unlock your slot")
	const marketOn = market.data?.marketMode === true;
	const needsVerify = marketOn && market.data?.verified === false;
	const slot = useSlot(rigName, market.data);
	// Slots configured: the slot IS the gate. Otherwise fall back to the
	// (dormant) Hedera bond, so a hub without a slot contract is unchanged.
	const needsStake = slot.enabled
		? slot.needsBooking || slot.needsUnlock
		: marketOn &&
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
						? "verify your World ID beside the feed to take control"
						: apiErrorMessage(e) === "bond required"
							? "stake beside the feed to take control"
							: apiErrorMessage(e),
			),
	});
	/** Ask before stealing a live holder's rig — friends-tier, same as before. */
	const pickSource = (choice: DriveChoice) => {
		if (gated) {
			toast.error(
				needsVerify
					? "verify your World ID beside the feed to take control"
					: (slot.blockedReason ?? "stake beside the feed to take control"),
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

	/**
	 * The page's one stop, replacing "Stop teleop" AND "Stop <name>'s leader".
	 *
	 * They were never a real choice: with a leader bound, plain teleop_stop is
	 * the INCOMPLETE action — the agent stays bound and keeps streaming ~25
	 * packets/s into a source that no longer exists ("no remote-joints teleop
	 * source active"), while the page still reads "you are driving". The leader
	 * branch is complete on its own: the hub unbinds the agent and queues
	 * teleop_stop for the rig in the same handler.
	 *
	 * Not gated on holding the lease. Both underlying verbs are `safety: true`
	 * so that anyone watching a rig misbehave can end it — see hub/verbs.ts.
	 */
	const stopDriving = () => {
		if (drivingLeader)
			leaderCommand.mutate({ name: drivingLeader.name, action: "stop" });
		else command.mutate("teleop_stop");
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
					? `${drivingLeader?.name ?? "a remote"}'s leader arm is driving — Stop driving first`
					: sink === "leader"
						? "the rig's own leader arm is driving — Stop driving first"
						: `${sink ?? "another source"} is driving`;

	/**
	 * Everything between this operator and one recorded episode. Used to be a
	 * seven-branch ternary collapsed into a tooltip; now the task rows render the
	 * whole list with each unmet item's remedy inline, which is what let the slot
	 * gate stop being its own card — it is two rows of this.
	 */
	const { requirements, blockedLabel: attemptBlockedReason } =
		useStartRequirements({
			rig: rig.data,
			slot,
			marketOn,
			verified: market.data?.verified === true,
			needsStake,
			iAmDriving,
			inTeleop,
			sink,
			drivingLeaderName: drivingLeader?.name ?? null,
		});

	const myAttempt =
		rig.data?.attempt?.active === true &&
		rig.data.attempt.operator === clientId;

	// The attempt controls live under the camera while an attempt runs and in
	// the task list between them, so the chain that links them belongs here.
	const startAttempt = useCallback(
		(taskId: string) =>
			commandWith.mutate({ verb: "attempt_start", args: { taskId } }),
		[commandWith.mutate],
	);
	const chain = useAttemptChain({
		rig: rig.data,
		iAmDriving,
		progress: taskProgress.data ?? null,
		onStart: startAttempt,
	});

	/**
	 * Is there anything left to record on this arm?
	 *
	 * Same rule TaskPanel uses for its per-task "complete ✓", applied across
	 * every active task. False means an operator holding a live slot has no way
	 * to earn another credit, so the panel offers them the exit instead of
	 * letting the clock run out on a rig nobody else can book.
	 */
	const activeTasks = rig.data?.tasks.filter((t) => t.active) ?? [];
	const workLeft =
		activeTasks.length === 0 ||
		activeTasks.some(
			(t) => t.maxEpisodes === null || (t.episodesDone ?? 0) < t.maxEpisodes,
		);

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

			{/*
			 * The cockpit.
			 *
			 * Left column is the instrument — the camera, and welded under it the
			 * only things you touch while looking at the arm. It is STICKY: the
			 * feed never leaves the screen no matter how far the right column
			 * scrolls, which is also what keeps the Success/Discard buttons
			 * reachable through a twenty-second recording.
			 *
			 * Right column answers exactly one question — "what do I do next" —
			 * and therefore holds exactly one thing at a time: the gate while you
			 * are blocked, the ledger and worklist once you are not.
			 *
			 * The grid's max width is derived from the camera's height budget
			 * (CAM_MAX_W), so the feed fills its column instead of floating in a
			 * gutter with the rail stranded far to the right. The cockpit is as
			 * wide as the camera needs; leftover page width becomes symmetric
			 * margin.
			 */}
			{/* camera(56vh·4/3) + filmstrip(6rem) + card padding + gap + rail(25rem) */}
			<div className="mx-auto grid max-w-[calc(56vh*4/3+33rem)] grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_25rem]">
				<div className="flex min-w-0 flex-col gap-4 xl:sticky xl:top-16 xl:self-start">
					<RigViewport
						rig={rigName}
						cams={cams}
						camAgeMs={data?.camAgeMs}
						online={data?.online === true}
						recording={recordingNow}
					>
						{data?.attempt?.active === true ? (
							<AttemptBar
								attempt={data.attempt}
								record={data.record}
								mine={myAttempt}
								busy={commandWith.isPending}
								onFinish={(success) =>
									commandWith.mutate({
										verb: "attempt_finish",
										args: { success },
									})
								}
								autoContinue={chain.autoContinue}
								onAutoContinue={chain.setAutoContinue}
							/>
						) : (
							<ControlRail
								iAmDriving={iAmDriving}
								holder={holder}
								drivingLeaderName={drivingLeader?.name ?? null}
								inTeleop={inTeleop}
								linkMs={data?.linkMs}
								rttMs={rtt}
								inputTransport={data?.inputTransport}
								busy={drive.isPending}
								onStopDriving={stopDriving}
							/>
						)}
					</RigViewport>

					{/* The pad ARMS itself: focusing it starts keys teleop when the arm is
					    merely connected. It is mounted only once keys ARE the source, so
					    it arrives already focused — picking the keyboard chip is the whole
					    gesture. It still goes inert rather than fighting for the mailbox if
					    something takes the source away underneath it: a leader's joints and
					    browser axes share one single-slot mailbox, and axes would displace
					    the leader's packet AND then fail rig-side ("no input-driven teleop
					    source active"), which looked like nothing happening. */}
					{iAmDriving && axesSink && (
						<KeyJogPad
							autoFocus
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
				</div>

				<div className="flex min-w-0 flex-col gap-4">
					{/* The holder's own ledger — a spectator sees the badge, not this.
					    Keyed on `mine` rather than `hasToken` so it does NOT vanish the
					    instant the clock runs out: that is the moment the operator wants
					    to read the last verdict and click their payout. */}
					{slot.enabled &&
						slot.info &&
						(slot.mine || slot.info.state === "voided") && (
							<SlotPanel
								info={slot.info}
								maxStrikes={slot.maxStrikes}
								gradeGraceSeconds={slot.gradeGraceSeconds}
								workLeft={workLeft}
							/>
						)}

					{/*
					 * ONE card, because the gate and the worklist were never siblings:
					 * the tasks are the reason to put 0.05 OG down and the gate is the
					 * mechanism, so stacking them as peers put the toll before the
					 * reason. Now a blocked `Start attempt` opens that task's
					 * requirements in place, and the stake is two rows of the list.
					 */}
					{data && (
						<TaskPanel
							slotEndsAt={slot.live?.endAt ?? null}
							progress={taskProgress.data ?? null}
							rig={data}
							iAmDriving={iAmDriving}
							blockedReason={attemptBlockedReason}
							busy={commandWith.isPending}
							onStart={chain.start}
							autoContinue={chain.autoContinue}
							onAutoContinue={chain.setAutoContinue}
							chainTaskId={chain.chainTaskId}
							// the price of everything in the list, while it still applies
							subtitle={
								gated ? <SlotTerms slots={slot.config ?? null} /> : null
							}
							// Unconditional: on a hub with the market off there is no gate,
							// but the source picker still lives in here and every hub needs
							// it. `session` is nullable for exactly that case.
							renderRequirements={() => (
								<StartRequirements
									rig={rigName}
									session={market.data ?? null}
									slots={slot.config ?? null}
									info={slot.info}
									requirements={requirements}
									sourcePicker={
										<SourcePicker
											online={data.online}
											armState={armState}
											iAmDriving={iAmDriving}
											drivingLeaderName={drivingLeader?.name ?? null}
											idleLeaderNames={onlineLeaders
												.filter((l) => l.driving === null)
												.map((l) => l.name)}
											hasRigLeader={data.leader === true}
											sink={sink}
											recording={recordingNow}
											backend={data.backend}
											keyboardBlockedReason={padReason}
											busy={drive.isPending}
											onPick={pickSource}
											onConnect={() =>
												command.mutate(
													data.backend === "sim"
														? "connect_sim"
														: "connect_real",
												)
											}
										/>
									}
								/>
							)}
						/>
					)}
				</div>
			</div>

			{data && (
				<div className="mt-4 flex flex-col gap-4">
					<DiagnosticsFold
						leader={drivingLeader?.name ?? null}
						input={data.leaderInputDebug}
						joints={data.joints}
					/>
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
