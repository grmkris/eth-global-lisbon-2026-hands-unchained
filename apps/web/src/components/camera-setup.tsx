import { Eye, Sun } from "lucide-react";
import { Button } from "#/components/ui/button";
import type { RigSummary } from "#/lib/hub-api";

/**
 * Camera identification, inside the Rig owner fold. Real rigs only.
 *
 * Why this still exists when "you can already see the cameras": the RECORDER
 * needs to know which index is the workspace and which is the wrist
 * (`record.ts` refuses a real recording without the mapping, and a bypassed
 * gate writes an imageless dataset), and macOS reshuffles camera indexes on
 * every replug. Identification happens on the MAIN feed grid — this is just the
 * assign buttons, so we don't open a second MJPEG stream per camera to show
 * the operator pictures they are already looking at.
 *
 * A sim rig has fixed, hardcoded cams and passes `cameras: {}` to the
 * recorder, so it renders nothing at all — and `camera_probe` on a sim rig
 * would enumerate the HOST's webcams, which is worse than useless.
 */
export function CameraSetup(props: {
	rig: RigSummary;
	onCommand: (verb: string, args?: Record<string, unknown>) => void;
	busy: boolean;
}) {
	const { rig, onCommand, busy } = props;
	if (rig.backend !== "real") return null;

	const mapping = rig.camMapping ?? { workspace: null, wrist: null };
	// only cam<index> streams participate in mapping (sim cams have fixed names)
	const indexed = rig.cams.filter((c) => /^cam\d+$/.test(c));
	const indexOf = (name: string) =>
		Number.parseInt(name.replace("cam", ""), 10);
	const confirmed = mapping.workspace !== null && mapping.wrist !== null;

	return (
		<div className="flex flex-col gap-2 border-t pt-3">
			<div className="flex flex-wrap items-center gap-3">
				<span className="font-medium text-sm">Cameras</span>
				<span className="font-mono text-xs text-muted-foreground">
					workspace={mapping.workspace ?? "?"} wrist={mapping.wrist ?? "?"}
				</span>
				{!confirmed && (
					<span className="text-xs text-warn">
						attempts are blocked until both are assigned
					</span>
				)}
				<Button
					size="sm"
					variant="outline"
					disabled={busy || rig.record?.active === true}
					onClick={() => onCommand("camera_probe")}
					title="re-enumerate the cameras (needed after a replug)"
				>
					<Eye />
					Probe + preview
				</Button>
			</div>

			{indexed.length === 0 ? (
				<p className="text-xs text-muted-foreground">
					No indexed camera streams yet — Probe + preview to enumerate them.
				</p>
			) : (
				<div className="flex flex-col gap-1">
					{indexed.map((cam) => {
						const idx = indexOf(cam);
						const bright = rig.camBrightness[cam];
						return (
							<div key={cam} className="flex items-center gap-2 text-xs">
								<span className="w-12 font-mono">{cam}</span>
								{bright !== undefined && (
									<span
										className="flex w-14 items-center gap-1 font-mono text-muted-foreground"
										title="mean brightness — aim for 115-131"
									>
										<Sun className="size-3" />
										{bright.toFixed(0)}
									</span>
								)}
								<Button
									size="sm"
									variant={mapping.workspace === idx ? "default" : "outline"}
									disabled={busy}
									onClick={() =>
										onCommand("camera_confirm", {
											workspace: idx,
											wrist: mapping.wrist,
										})
									}
								>
									workspace
								</Button>
								<Button
									size="sm"
									variant={mapping.wrist === idx ? "default" : "outline"}
									disabled={busy}
									onClick={() =>
										onCommand("camera_confirm", {
											workspace: mapping.workspace,
											wrist: idx,
										})
									}
								>
									wrist
								</Button>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}
