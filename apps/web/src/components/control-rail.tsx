import { Square } from "lucide-react";
import { StatusBadge } from "#/components/status-badge";
import { Button } from "#/components/ui/button";

/**
 * The live strip, welded to the bottom of the camera: what is happening, and the
 * one control that ends it. Nothing you set up, only what you reach for while
 * looking at the arm.
 *
 * Picking a source moved out to components/source-picker.tsx, into the
 * `pick how you'll drive` requirement in the rail — setup belongs with the
 * requirement that asks for it. `Stop driving` deliberately did NOT follow it:
 *
 * - **The stops collapsed from three to one.** "Stop teleop" and "Stop <name>'s
 *   leader" were the same intent at different completeness — during a remote
 *   session the plain teleop_stop left the agent bound and still streaming
 *   ~25 pkt/s into a dead source, which is a trap, not a choice. `onStopDriving`
 *   picks the right verb. It renders for EVERYONE, holder or not: teleop_stop
 *   is `safety: true` (hub/verbs.ts) precisely so a bystander watching a rig
 *   misbehave can end it — and a bystander has no rail, only this strip.
 * - **E-STOP is gone from the UI** (the verb still exists on the rig API). Read
 *   docs/SPEC.md before bringing a torque-kill back — it was removed
 *   deliberately, and this is now the only stop control on the page.
 */
export function ControlRail({
	iAmDriving,
	holder,
	drivingLeaderName,
	inTeleop,
	linkMs,
	rttMs,
	inputTransport,
	busy,
	onStopDriving,
}: {
	iAmDriving: boolean;
	holder: string | null;
	drivingLeaderName: string | null;
	inTeleop: boolean;
	linkMs: number | undefined;
	rttMs: number | null;
	inputTransport: string | undefined;
	busy: boolean;
	onStopDriving: () => void;
}) {
	return (
		<div className="flex flex-wrap items-center gap-3 text-sm">
			<StatusBadge tone={iAmDriving ? "success" : "neutral"}>
				{iAmDriving
					? drivingLeaderName
						? `you are driving — via ${drivingLeaderName}'s leader`
						: "you are driving"
					: holder
						? drivingLeaderName
							? `someone else is driving — via ${drivingLeaderName}'s leader`
							: "someone else is driving"
						: "nobody driving"}
			</StatusBadge>
			<span className="font-mono text-muted-foreground text-xs">
				link {linkMs ?? "…"}ms
				{rttMs !== null ? ` · your rtt ${rttMs}ms` : ""}
				{inputTransport ? ` · input ${inputTransport}` : ""}
			</span>
			{inputTransport === "http" && (
				<StatusBadge
					tone="warn"
					title="the rig's input socket is down — input rides the polled HTTP link (slower)"
				>
					input: http fallback
				</StatusBadge>
			)}
			{inTeleop && (
				<Button
					size="sm"
					variant="outline"
					disabled={busy}
					className="ms-auto"
					title="ends the input source — torque stays on, the arm holds its pose"
					onClick={onStopDriving}
				>
					<Square />
					Stop driving
				</Button>
			)}
		</div>
	);
}
