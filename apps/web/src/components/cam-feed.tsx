import { RotateCcw, VideoOff } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "#/components/ui/button";
import { Spinner } from "#/components/ui/spinner";
import { cn } from "#/lib/utils";

const MAX_AUTO_RETRIES = 5;
const RETRY_DELAY_MS = 2000;

/**
 * MJPEG stream panel with a lifecycle the bare <img> lacks: a connecting
 * placeholder, an error state, and reconnect via cache-busted src (an MJPEG
 * <img> never recovers on its own once the multipart stream drops).
 * The box is literal black on purpose — camera void, not themed surface.
 *
 * Two chrome-free forms, both used by the drive cockpit:
 * - `compact` — the filmstrip thumbnail. Name overlays the frame and the manual
 *   retry disappears (a tile is itself a button, and nesting one inside it is
 *   invalid HTML; the 5 auto retries still run either way).
 * - `overlay` — the primary feed. Same frame, but the name and status ride on
 *   it as a slate instead of sitting in a row above it.
 */
export function CamFeed({
	name,
	src,
	statusLine,
	compact = false,
	overlay = false,
	className,
}: {
	name: string;
	src: string;
	statusLine?: ReactNode;
	compact?: boolean;
	overlay?: boolean;
	className?: string;
}) {
	const [state, setState] = useState<"connecting" | "live" | "error">(
		"connecting",
	);
	const [bust, setBust] = useState(0);
	const retries = useRef(0);

	useEffect(() => {
		if (state !== "error" || retries.current >= MAX_AUTO_RETRIES) return;
		const t = setTimeout(() => {
			retries.current += 1;
			setState("connecting");
			setBust((b) => b + 1);
		}, RETRY_DELAY_MS);
		return () => clearTimeout(t);
	}, [state]);

	// some browsers never fire load on multipart streams — don't let the
	// overlay mask a working feed
	useEffect(() => {
		if (state !== "connecting") return;
		const t = setTimeout(() => setState("live"), 3000);
		return () => clearTimeout(t);
	}, [state]);

	const retryNow = () => {
		retries.current = 0;
		setState("connecting");
		setBust((b) => b + 1);
	};

	const bare = compact || overlay;

	return (
		<div className={cn(!bare && "rounded border p-2", className)}>
			{!bare && (
				<div className="flex items-center justify-between font-mono text-xs text-muted-foreground">
					<span>{name}</span>
					{statusLine}
				</div>
			)}
			<div
				className={cn(
					"relative aspect-[4/3] overflow-hidden rounded bg-black",
					!bare && "mt-2",
				)}
			>
				<img
					key={bust}
					src={`${src}${src.includes("?") ? "&" : "?"}t=${bust}`}
					alt={name}
					className="size-full object-contain"
					onLoad={() => {
						retries.current = 0;
						setState("live");
					}}
					onError={() => setState("error")}
				/>
				{state !== "live" && (
					<div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black text-xs text-white/60">
						{state === "connecting" ? (
							<>
								<Spinner className={compact ? "size-4" : "size-5"} />
								{!compact && "connecting to stream…"}
							</>
						) : (
							<>
								<VideoOff className={compact ? "size-4" : "size-6"} />
								{!compact && (
									<>
										stream lost
										<Button variant="outline" size="sm" onClick={retryNow}>
											<RotateCcw />
											retry
										</Button>
									</>
								)}
							</>
						)}
					</div>
				)}
				{/* Labels last, so they stay legible over the connecting/lost overlay.
				    On the primary feed the slate rides ON the frame rather than in a
				    row above it: it costs no height, it lines the video up with the
				    filmstrip beside it, and a camera name over black reads as an
				    instrument rather than a caption. */}
				{overlay && (
					<div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between gap-2 bg-gradient-to-b from-black/80 to-transparent px-3 pt-2 pb-6 font-mono text-xs text-white/70">
						<span className="truncate">{name}</span>
						{statusLine}
					</div>
				)}
				{compact && (
					<div className="absolute inset-x-0 bottom-0 truncate bg-black/60 px-1.5 py-0.5 font-mono text-[10px] text-white/70">
						{name}
					</div>
				)}
			</div>
		</div>
	);
}

/** Same-layout panel for when video is deliberately unavailable (real-mode recording). */
export function CamOffAir({
	name,
	note,
	compact = false,
	overlay = false,
	className,
}: {
	name: string;
	note: ReactNode;
	compact?: boolean;
	overlay?: boolean;
	className?: string;
}) {
	const bare = compact || overlay;
	return (
		<div className={cn(!bare && "rounded border p-2", className)}>
			{!bare && (
				<div className="font-mono text-xs text-muted-foreground">{name}</div>
			)}
			<div
				className={cn(
					"relative flex aspect-[4/3] flex-col items-center justify-center gap-2 rounded bg-black text-center text-xs text-white/60",
					compact ? "px-1" : bare ? "px-6" : "mt-2 px-6",
				)}
			>
				<VideoOff className={compact ? "size-4" : "size-6"} />
				{!compact && note}
				{overlay && (
					<div className="pointer-events-none absolute inset-x-0 top-0 bg-gradient-to-b from-black/80 to-transparent px-3 pt-2 pb-6 text-left font-mono text-xs text-white/70">
						{name}
					</div>
				)}
				{compact && (
					<div className="absolute inset-x-0 bottom-0 truncate bg-black/60 px-1.5 py-0.5 font-mono text-[10px] text-white/70">
						{name}
					</div>
				)}
			</div>
		</div>
	);
}
