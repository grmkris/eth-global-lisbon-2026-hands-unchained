import { formatRemaining, useCountdown } from "#/components/slot-timer";
import { StatusBadge } from "#/components/status-badge";
import type { RigSlotInfo } from "#/market/market-api";

/**
 * Whether this arm is yours to take, in one chip. Shared vocabulary between
 * the lobby and the drive page so "LIVE 12:40" means the same thing in both.
 */
export function SlotBadge({ info }: { info: RigSlotInfo | undefined }) {
	const remaining = useCountdown(info?.live?.endAt ?? null);
	if (!info) return null;

	const waiting = info.queue.filter((q) => q.status === "booked").length;

	if (info.live !== null)
		return (
			<span className="flex items-center gap-1.5">
				<StatusBadge tone="warn" title="booked — the arm is someone else's">
					busy{" "}
					<span className="font-mono tabular-nums">
						{formatRemaining(remaining)}
					</span>
				</StatusBadge>
				{waiting > 1 && (
					<StatusBadge tone="neutral">{waiting - 1} queued</StatusBadge>
				)}
			</span>
		);

	if (info.pending !== null)
		return (
			<StatusBadge tone="info" title="booked, waiting for its key">
				reserved
			</StatusBadge>
		);

	if (info.state === "voided")
		return <StatusBadge tone="danger">slot voided</StatusBadge>;

	return <StatusBadge tone="success">free</StatusBadge>;
}
