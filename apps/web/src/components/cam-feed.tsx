import { RotateCcw, VideoOff } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "#/components/ui/button";
import { Spinner } from "#/components/ui/spinner";

const MAX_AUTO_RETRIES = 5;
const RETRY_DELAY_MS = 2000;

/**
 * MJPEG stream panel with a lifecycle the bare <img> lacks: a connecting
 * placeholder, an error state, and reconnect via cache-busted src (an MJPEG
 * <img> never recovers on its own once the multipart stream drops).
 * The box is literal black on purpose — camera void, not themed surface.
 */
export function CamFeed({
	name,
	src,
	statusLine,
}: {
	name: string;
	src: string;
	statusLine?: ReactNode;
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

	return (
		<div className="rounded border p-2">
			<div className="flex items-center justify-between font-mono text-xs text-muted-foreground">
				<span>{name}</span>
				{statusLine}
			</div>
			<div className="relative mt-2 aspect-[4/3] overflow-hidden rounded bg-black">
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
								<Spinner className="size-5" />
								connecting to stream…
							</>
						) : (
							<>
								<VideoOff className="size-6" />
								stream lost
								<Button variant="outline" size="sm" onClick={retryNow}>
									<RotateCcw />
									retry
								</Button>
							</>
						)}
					</div>
				)}
			</div>
		</div>
	);
}

/** Same-layout panel for when video is deliberately unavailable (real-mode recording). */
export function CamOffAir({ name, note }: { name: string; note: ReactNode }) {
	return (
		<div className="rounded border p-2">
			<div className="font-mono text-xs text-muted-foreground">{name}</div>
			<div className="mt-2 flex aspect-[4/3] flex-col items-center justify-center gap-2 rounded bg-black px-6 text-center text-xs text-white/60">
				<VideoOff className="size-6" />
				{note}
			</div>
		</div>
	);
}
