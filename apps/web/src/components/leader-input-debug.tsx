import { useEffect, useRef, useState } from "react";
import { StatusBadge } from "#/components/status-badge";
import type { LeaderInputDebug } from "#/lib/hub-api";

interface Props {
	leader: string | null;
	input: LeaderInputDebug | null;
}

/** Live proof of what the hub is accepting from a rig's bound remote leader. */
export function LeaderInputDebugPanel({ leader, input }: Props) {
	const [ageMs, setAgeMs] = useState<number | null>(input?.ageMs ?? null);
	const hubAgeMs = input?.ageMs;
	const packetCount = input?.packets;

	useEffect(() => {
		if (hubAgeMs === undefined || packetCount === undefined) {
			setAgeMs(null);
			return;
		}
		const observedAt = performance.now();
		setAgeMs(hubAgeMs);
		const timer = setInterval(
			() => setAgeMs(Math.round(hubAgeMs + performance.now() - observedAt)),
			250,
		);
		return () => clearInterval(timer);
	}, [hubAgeMs, packetCount]);

	// packets/s derived from the hub's monotonic packet counter, sampled on
	// each rigQuery tick over a ~5s window (the counter resets on rebind)
	const rateSamples = useRef<Array<{ t: number; packets: number }>>([]);
	const [rate, setRate] = useState<number | null>(null);
	useEffect(() => {
		const ring = rateSamples.current;
		if (packetCount === undefined) {
			ring.length = 0;
			setRate(null);
			return;
		}
		const now = performance.now();
		if (ring.length > 0 && packetCount < ring[ring.length - 1].packets)
			ring.length = 0; // counter reset — fresh window
		ring.push({ t: now, packets: packetCount });
		while (ring.length > 0 && now - ring[0].t > 5_000) ring.shift();
		const dt = now - ring[0].t;
		setRate(dt > 1_000 ? ((packetCount - ring[0].packets) * 1000) / dt : null);
	}, [packetCount]);

	const receiving = ageMs !== null && ageMs < 1_000;
	const source = leader ?? input?.leader ?? null;

	return (
		<div className="rounded-md border bg-muted/30 p-3 text-sm">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="font-medium">Leader input debug</div>
				<StatusBadge tone={receiving ? "success" : "neutral"}>
					{receiving
						? "receiving"
						: source
							? input
								? "stale"
								: "waiting for input"
							: "no remote leader"}
				</StatusBadge>
			</div>

			{source ? (
				<div className="mt-2 font-mono text-xs text-muted-foreground">
					{source}
					{input
						? ` · ${input.transport} · packet ${input.packets}` +
							(receiving && rate !== null
								? ` · ${rate.toFixed(0)} pkt/s`
								: "") +
							` · ${ageMs ?? "…"} ms ago`
						: " · no authorized packets received"}
				</div>
			) : (
				<p className="mt-2 text-xs text-muted-foreground">
					Select a remote leader for this rig to inspect its input.
				</p>
			)}

			{input && (
				<>
					{input.dropped && (
						<p className="mt-2 text-xs text-warn">
							The hub received this packet, but injected impairment dropped it.
						</p>
					)}
					<pre className="mt-2 max-h-64 overflow-auto rounded bg-background p-3 font-mono text-xs">
						{JSON.stringify(input.joints, null, 2)}
					</pre>
				</>
			)}
		</div>
	);
}
