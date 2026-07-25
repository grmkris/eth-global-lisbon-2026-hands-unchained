import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { ArmPanel } from "#/components/arm-panel";
import { CamFeed } from "#/components/cam-feed";
import { ErrorNote } from "#/components/error-note";
import { PageHeader } from "#/components/page-header";
import { StatusBadge } from "#/components/status-badge";
import { Button } from "#/components/ui/button";
import { Spinner } from "#/components/ui/spinner";
import { apiErrorMessage } from "#/lib/errors";
import {
	cameraStatusQuery,
	confirmCameras,
	probeCameras,
	startPreview,
	stopPreview,
} from "#/lib/queries";

export const Route = createFileRoute("/robot")({ component: RobotPage });

function RobotPage() {
	const status = useQuery(cameraStatusQuery);
	const queryClient = useQueryClient();
	const [probed, setProbed] =
		useState<ReadonlyArray<{ index: number; width: number; height: number }>>();
	const [workspace, setWorkspace] = useState<number | null>(null);
	const [wrist, setWrist] = useState<number | null>(null);

	const probe = useMutation({
		mutationFn: probeCameras,
		onSuccess: (cams) => setProbed(cams),
	});
	const preview = useMutation({
		mutationFn: (indexes: ReadonlyArray<number>) => startPreview(indexes),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ["cameras"] }),
	});
	const stop = useMutation({
		mutationFn: stopPreview,
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ["cameras"] }),
	});
	const confirm = useMutation({
		mutationFn: () => confirmCameras({ workspace, wrist }),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["cameras"] });
			toast.success("mapping saved to rig");
		},
		onError: (e) => toast.error(apiErrorMessage(e)),
	});

	const s = status.data;
	const previewing = s?.previewing ?? [];
	const band = s?.brightnessBand ?? { min: 115, max: 131 };

	return (
		<div>
			<PageHeader
				title="Robot"
				description="macOS shuffles camera indexes on replug: verify every session."
			/>

			<ArmPanel />

			<div className="mt-4 flex gap-2">
				<Button
					variant="outline"
					disabled={probe.isPending}
					onClick={() => probe.mutate()}
				>
					{probe.isPending && <Spinner />}
					{probe.isPending ? "probing…" : "Probe cameras"}
				</Button>
				{probed && probed.length > 0 && (
					<Button
						disabled={preview.isPending}
						onClick={() => preview.mutate(probed.map((c) => c.index))}
					>
						{preview.isPending && <Spinner />}
						Start previews
					</Button>
				)}
				{previewing.length > 0 && (
					<Button variant="outline" onClick={() => stop.mutate()}>
						Stop previews
					</Button>
				)}
			</div>

			{probe.isError && (
				<div className="mt-3">
					<ErrorNote error={probe.error} />
				</div>
			)}
			{probed && probed.length === 0 && (
				<p className="mt-2 text-sm text-warn">
					no cameras found — are they plugged in / not held by another app?
				</p>
			)}

			{previewing.length > 0 && (
				<div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
					{previewing.map((name) => {
						const index = Number.parseInt(name.replace("cam", ""), 10);
						const bright = s?.brightness[name];
						const inBand =
							bright !== undefined && bright >= band.min && bright <= band.max;
						return (
							<div key={name} className="flex flex-col gap-2">
								<CamFeed
									name={`${name}${s?.mapping.workspace === index ? " · workspace ✓" : ""}${s?.mapping.wrist === index ? " · wrist ✓" : ""}`}
									src={`/api/cams/${name}`}
									statusLine={
										bright !== undefined && (
											<StatusBadge tone={inBand ? "success" : "warn"}>
												brightness {bright}{" "}
												{inBand ? "✓" : `(band ${band.min}–${band.max})`}
											</StatusBadge>
										)
									}
								/>
								<div className="flex gap-2">
									<Button
										variant={workspace === index ? "default" : "outline"}
										size="sm"
										onClick={() => setWorkspace(index)}
									>
										this is workspace
									</Button>
									<Button
										variant={wrist === index ? "default" : "outline"}
										size="sm"
										onClick={() => setWrist(index)}
									>
										this is wrist
									</Button>
								</div>
							</div>
						);
					})}
				</div>
			)}

			{previewing.length > 0 && (
				<Button
					className="mt-4"
					disabled={
						workspace === null ||
						wrist === null ||
						workspace === wrist ||
						confirm.isPending
					}
					onClick={() => confirm.mutate()}
				>
					{confirm.isPending && <Spinner />}
					Confirm mapping (workspace=cam{workspace ?? "?"} wrist=cam
					{wrist ?? "?"})
				</Button>
			)}
		</div>
	);
}
