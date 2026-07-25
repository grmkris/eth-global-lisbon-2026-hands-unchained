import { useEffect, useState } from "react";
import { StatusBadge, type StatusTone } from "#/components/status-badge";

/**
 * The slot clock. Rendered from `endAt` — which comes off the chain — and
 * counted down locally, so it keeps ticking correctly with the RPC down and
 * survives a hub redeploy to the second.
 *
 * Never render this from "I unlocked at T + 30 minutes": the block timestamp
 * that started the slot is the truth and drifts from a browser clock.
 */
const TICK_MS = 500;

export const useCountdown = (endAtSeconds: number | null): number => {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (endAtSeconds === null) return;
		const t = setInterval(() => setNow(Date.now()), TICK_MS);
		return () => clearInterval(t);
	}, [endAtSeconds]);
	if (endAtSeconds === null) return 0;
	return Math.max(0, endAtSeconds * 1000 - now);
};

export const formatRemaining = (ms: number): string => {
	const total = Math.ceil(ms / 1000);
	const m = Math.floor(total / 60);
	const s = total % 60;
	return `${m}:${String(s).padStart(2, "0")}`;
};

const toneFor = (ms: number): StatusTone => {
	if (ms <= 60_000) return "danger";
	if (ms <= 5 * 60_000) return "warn";
	return "info";
};

export function SlotTimer({
	endAt,
	label = "left in your slot",
}: {
	endAt: number;
	label?: string;
}) {
	const remaining = useCountdown(endAt);
	return (
		<StatusBadge
			tone={toneFor(remaining)}
			title="your booked 30 minutes — the clock started when you unlocked, not when you paid"
		>
			<span className="font-mono tabular-nums">
				{formatRemaining(remaining)}
			</span>{" "}
			{label}
		</StatusBadge>
	);
}
