import { useEffect, useState } from "react";
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
						? ` · ${input.transport} · packet ${input.packets} · ${ageMs ?? "…"} ms ago`
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
