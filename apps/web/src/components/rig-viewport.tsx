import type { ReactNode } from "react";
import { useState } from "react";
import { CamFeed, CamOffAir } from "#/components/cam-feed";
import { cn } from "#/lib/utils";

/**
 * How tall the live feed is allowed to be. Everything about the cockpit's
 * proportions falls out of this one number: the frame is width-driven at 4:3,
 * so the cap is expressed as the max-WIDTH that height implies (an
 * `aspect-[4/3]` box with a max-HEIGHT would just letterbox instead of
 * shrinking), and drive.$rig.tsx sizes the whole two-column grid from the same
 * expression so the camera fills its column exactly instead of floating in a
 * gutter. 56vh leaves room for the control rail beneath it, so camera +
 * controls fit one screen and the column can be sticky.
 */
export const CAM_MAX_W = "max-w-[calc(56vh*4/3)]";

/**
 * The thing you actually drive by.
 *
 * Two design rules, both load-bearing:
 *
 * 1. ONE camera is dominant, the rest are tiles you click to promote. A 50/50
 *    grid gave the workspace cam — the one you steer with — half the width, at
 *    the same size as a wrist view you only glance at.
 * 2. Every cam renders EXACTLY ONCE. These are MJPEG streams; a second <img>
 *    on the same URL is a second live connection off the rig's uplink, so a
 *    thumbnail strip that mirrors the big feed would double the bandwidth of
 *    the one thing that must not stutter. Promoting a tile therefore moves the
 *    feed between subtrees and remounts it — CamFeed's connecting placeholder
 *    covers the ~1s gap, and it only happens on an explicit click.
 *
 * `children` is the bar that sits flush under the frame: the control rail
 * normally, the attempt recorder while an episode is being written. It lives
 * inside the viewport so that what you press is never a scroll away from what
 * you are watching.
 */
export function RigViewport({
	rig,
	cams,
	camAgeMs,
	online,
	recording = false,
	children,
}: {
	rig: string;
	cams: ReadonlyArray<string>;
	camAgeMs: Record<string, number> | undefined;
	online: boolean;
	/** an episode is being written right now */
	recording?: boolean;
	children?: ReactNode;
}) {
	const [picked, setPicked] = useState<string | null>(null);

	// cams come from the rig's own advertisement — never a hardcoded list
	const list = cams.length > 0 ? cams : ["camera"];
	// `camMapping` holds device INDEXES, not names, so it cannot answer "which
	// one is the workspace view". The name is what the owner actually typed.
	const primary =
		(picked !== null && list.includes(picked) ? picked : null) ??
		list.find((c) => c.includes("workspace")) ??
		list[0];
	const rest = list.filter((c) => c !== primary);

	const srcFor = (cam: string) =>
		`/api/hub/cams/${encodeURIComponent(rig)}/${encodeURIComponent(cam)}`;
	const isLive = (cam: string) => online && cams.includes(cam);

	return (
		// The frame itself reports the one state you must not miss. Your eyes are
		// already on the feed while an episode records — so the feed is what turns
		// red, rather than a badge somewhere else on the page competing for a look.
		<div
			className={cn(
				"rounded-lg border bg-card transition-colors",
				recording && "border-destructive ring-1 ring-destructive",
			)}
		>
			{/* The filmstrip is VERTICAL, beside the feed — not under it. Height is
			    the scarce axis here (the control rail has to stay above the fold on a
			    900px laptop) and width is the spare one, so the secondary cameras pay
			    in the currency there is more of. */}
			<div className="flex justify-center gap-2 p-2">
				<div className={cn("min-w-0 flex-1", CAM_MAX_W)}>
					{isLive(primary) ? (
						<CamFeed
							overlay
							key={primary}
							name={primary}
							src={srcFor(primary)}
							statusLine={
								camAgeMs?.[primary] !== undefined ? (
									<span>{camAgeMs[primary]} ms</span>
								) : null
							}
						/>
					) : (
						<CamOffAir
							overlay
							key={primary}
							name={primary}
							note="no frames from this rig yet"
						/>
					)}
				</div>

				{rest.length > 0 && (
					<div className="flex w-24 shrink-0 flex-col gap-2">
						{rest.map((cam) => (
							<button
								key={cam}
								type="button"
								onClick={() => setPicked(cam)}
								title={`show ${cam} full size`}
								aria-label={`show ${cam} full size`}
								className="rounded outline-none ring-offset-2 ring-offset-card transition hover:opacity-80 hover:ring-1 hover:ring-border focus-visible:ring-2 focus-visible:ring-ring"
							>
								{isLive(cam) ? (
									<CamFeed compact name={cam} src={srcFor(cam)} />
								) : (
									<CamOffAir compact name={cam} note="off air" />
								)}
							</button>
						))}
					</div>
				)}
			</div>

			{children && <div className="border-t p-3">{children}</div>}
		</div>
	);
}
