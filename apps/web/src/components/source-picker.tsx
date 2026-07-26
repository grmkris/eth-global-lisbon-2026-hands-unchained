import { Keyboard, Play, Plug } from "lucide-react";
import { Button } from "#/components/ui/button";

/** How the operator wants to move the arm — the entry point to everything. */
export type DriveChoice =
	| { kind: "keys" }
	| { kind: "rigLeader" }
	| { kind: "leader"; name: string };

/**
 * How you drive, as the remedy for the `pick how you'll drive` requirement.
 *
 * It used to sit under the camera, a column away from the checklist that asks
 * for it — the one control the requirement list names, and the one control that
 * was not in it. Setup belongs with the requirement; live control (the status
 * readout and `Stop driving`) stays welded to the feed, because that is what you
 * reach for while watching the arm rather than reading a worklist.
 *
 * Choosing a source IS taking the rig: each chip claims the lease and then
 * starts that source, which is why there is no "Take control" button anywhere on
 * this page.
 *
 * A chip that cannot succeed is not rendered (docs/UX.md principle 4) — the
 * exception is the keyboard, which keeps `blockedReason` as its title, because
 * "why can't I type" is the question operators actually ask.
 */
export function SourcePicker({
	online,
	armState,
	iAmDriving,
	drivingLeaderName,
	idleLeaderNames,
	hasRigLeader,
	sink,
	recording,
	backend,
	keyboardBlockedReason,
	busy,
	onPick,
	onConnect,
}: {
	online: boolean;
	armState: string | undefined;
	iAmDriving: boolean;
	drivingLeaderName: string | null;
	idleLeaderNames: ReadonlyArray<string>;
	hasRigLeader: boolean;
	sink: string | null;
	recording: boolean;
	backend: string | undefined;
	keyboardBlockedReason: string | null;
	busy: boolean;
	onPick: (choice: DriveChoice) => void;
	onConnect: () => void;
}) {
	// All choices go quiet during a recording: the recorder owns the arm, so
	// teleop_start* is refused ("recording is active") and the click would
	// half-succeed, binding a leader whose joints then hit a source that cannot
	// accept them, silently, at ~25 packets/s.
	const canPick = online && armState !== "disconnected" && !recording;

	return (
		<div className="flex flex-wrap items-center gap-2">
			{iAmDriving && armState === "disconnected" && (
				<Button size="sm" variant="outline" onClick={onConnect}>
					<Plug />
					Connect ({backend === "sim" ? "sim" : "real arm"})
				</Button>
			)}

			{canPick && (
				<Button
					size="sm"
					variant={sink === "keys" ? "default" : "outline"}
					disabled={busy}
					title={keyboardBlockedReason ?? undefined}
					onClick={() => onPick({ kind: "keys" })}
				>
					<Keyboard />
					keyboard
				</Button>
			)}
			{/* only when a leader arm is really attached — it used to offer itself on
			    every rig and then fail with "connect with the leader arm first" */}
			{canPick && hasRigLeader && armState === "connected" && (
				<Button
					size="sm"
					variant={sink === "leader" ? "default" : "outline"}
					disabled={busy}
					onClick={() => onPick({ kind: "rigLeader" })}
				>
					<Play />
					this rig's leader arm
				</Button>
			)}
			{/* remote leader agents — the hub relays "drive this rig" */}
			{canPick &&
				idleLeaderNames.map((name) => (
					<Button
						key={name}
						size="sm"
						variant="outline"
						disabled={busy}
						onClick={() => onPick({ kind: "leader", name })}
					>
						<Play />
						{name}'s leader
					</Button>
				))}
			{/* The leader bound to you, and it stays CLICKABLE.
			    It used to be disabled because it is already selected — but a
			    recording tears the rig's teleop source down, and re-issuing `drive`
			    is the only path in the codebase that queues `teleop_start_remote`
			    again. Disabled, the operator's only way back was Stop driving
			    followed by re-picking: a two-step ritual after every episode. */}
			{drivingLeaderName && (
				<Button
					size="sm"
					variant="default"
					disabled={busy || recording}
					title="re-arm this leader if the arm stopped following it"
					onClick={() => onPick({ kind: "leader", name: drivingLeaderName })}
				>
					<Play />
					{drivingLeaderName}'s leader
				</Button>
			)}
		</div>
	);
}
