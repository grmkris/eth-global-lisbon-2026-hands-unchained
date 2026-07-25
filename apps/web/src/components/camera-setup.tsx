import { Camera, Eye, EyeOff, Sun } from "lucide-react";
import { CamFeed } from "#/components/cam-feed";
import { Button } from "#/components/ui/button";
import { Card, CardContent } from "#/components/ui/card";
import { ownerKeyStore, type RigSummary } from "#/lib/hub-api";

/**
 * Owner camera setup, entirely over the hub pipe: probe previews everything
 * (streams appear as cam<index> in telemetry, frames flow automatically),
 * the owner identifies workspace vs wrist visually, confirm persists the
 * mapping rig-side (.data/rig.json — the record preflight reads it).
 */
export function CameraSetup(props: {
	rig: RigSummary;
	onCommand: (verb: string, args?: Record<string, unknown>) => void;
	busy: boolean;
}) {
	const { rig, onCommand, busy } = props;
	const key = ownerKeyStore.get(rig.name);
	const mapping = rig.camMapping ?? { workspace: null, wrist: null };
	// only cam<index> streams participate in mapping (sim cams have fixed names)
	const indexed = rig.cams.filter((c) => /^cam\d+$/.test(c));
	const indexOf = (name: string) =>
		Number.parseInt(name.replace("cam", ""), 10);
	const brightnessOf = (name: string) => rig.camBrightness[name];

	return (
		<Card>
			<CardContent className="flex flex-col gap-3">
				<div className="flex flex-wrap items-center gap-3">
					<div className="flex items-center gap-2 font-medium">
						<Camera className="size-4 text-muted-foreground" />
						Camera setup
					</div>
					<Button
						size="sm"
						variant="outline"
						disabled={!key || busy}
						onClick={() => onCommand("camera_probe")}
					>
						<Eye />
						Probe + preview all
					</Button>
					<Button
						size="sm"
						variant="ghost"
						disabled={!key || busy}
						onClick={() => onCommand("camera_preview_stop")}
					>
						<EyeOff />
						Stop previews
					</Button>
					<span className="font-mono text-xs text-muted-foreground">
						mapping: workspace={mapping.workspace ?? "?"} wrist=
						{mapping.wrist ?? "?"}
					</span>
				</div>

				{indexed.length > 0 && (
					<div className="grid grid-cols-1 gap-3 md:grid-cols-3">
						{indexed.map((cam) => {
							const idx = indexOf(cam);
							const bright = brightnessOf(cam);
							return (
								<div key={cam} className="flex flex-col gap-1">
									<CamFeed
										name={cam}
										src={`/api/hub/cams/${encodeURIComponent(rig.name)}/${encodeURIComponent(cam)}`}
									/>
									<div className="flex items-center gap-2 text-xs">
										{bright !== undefined && (
											<span className="flex items-center gap-1 font-mono text-muted-foreground">
												<Sun className="size-3" />
												{bright.toFixed(0)}
											</span>
										)}
										<Button
											size="sm"
											variant={
												mapping.workspace === idx ? "default" : "outline"
											}
											disabled={!key || busy}
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
											disabled={!key || busy}
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
								</div>
							);
						})}
					</div>
				)}
				{!key && (
					<p className="text-xs text-muted-foreground">
						Enter the owner key below to manage cameras.
					</p>
				)}
			</CardContent>
		</Card>
	);
}
