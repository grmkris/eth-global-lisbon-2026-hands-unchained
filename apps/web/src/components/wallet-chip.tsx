import { Coins, Loader2 } from "lucide-react";
import { StatusBadge, type StatusTone } from "#/components/status-badge";
import type { MarketSessionInfo } from "#/market/market-api";
import { explorerTx, shortAddress } from "#/market/wallet";

/**
 * The operator's money and the fate of their last attempt, always on screen
 * while they drive. Without this the whole payment layer is invisible to the
 * person it pays: they finish an attempt and cannot tell whether a referee
 * is deliberating, they were paid, or their stake was taken.
 */

/** The grading pipeline in human words. `anchored` is terminal, so the
 * verdict — not the status — decides what it says. */
const attemptLabel = (
	a: NonNullable<MarketSessionInfo["lastAttempt"]>,
): { text: string; tone: StatusTone; busy: boolean } => {
	if (a.status === "open")
		return { text: "attempt running", tone: "info", busy: false };
	if (a.status === "closed")
		return { text: "waiting for the referee…", tone: "info", busy: true };
	if (a.status === "graded")
		return { text: "settling…", tone: "info", busy: true };
	if (a.pass === true)
		return {
			text: `passed ${a.score ?? ""} — paid`,
			tone: "success",
			busy: false,
		};
	if (a.claimed === "success")
		return {
			text: `failed ${a.score ?? ""} — stake slashed`,
			tone: "danger",
			busy: false,
		};
	return {
		text: `not counted (${a.claimed ?? "discarded"})`,
		tone: "warn",
		busy: false,
	};
};

export function WalletChip({ session }: { session: MarketSessionInfo }) {
	const stake = session.stake;
	if (!session.verified || !stake) return null;
	const bond = stake.bond;
	const earned = stake.earnedHbar ?? 0;
	const last = session.lastAttempt;
	const label = last ? attemptLabel(last) : null;

	return (
		<div className="flex flex-wrap items-center gap-3 text-sm">
			<span className="flex items-center gap-1.5 text-muted-foreground">
				<Coins className="size-4" />
				{bond ? (
					<a
						className="font-mono underline"
						href={explorerTx(bond.stakeTxHash)}
						target="_blank"
						rel="noreferrer"
					>
						{shortAddress(bond.evmAddress)}
					</a>
				) : (
					<span className="font-mono">no wallet staked</span>
				)}
			</span>
			{bond ? (
				<StatusBadge
					tone="info"
					title="stays staked while you work; returned when you finish, slashed if you claim work you didn't do"
				>
					{bond.amountHbar} ℏ staked
				</StatusBadge>
			) : (
				<StatusBadge tone="warn">stake to drive</StatusBadge>
			)}
			<span className="text-muted-foreground">
				earned{" "}
				<span className="font-mono tabular-nums text-foreground">
					{earned.toFixed(1)} ℏ
				</span>
			</span>
			{last && label && (
				<span
					className="flex items-center gap-1.5"
					title={last.reason ?? undefined}
				>
					{label.busy && <Loader2 className="size-3 animate-spin" />}
					<StatusBadge tone={label.tone}>{label.text}</StatusBadge>
					{last.payoutTx && (
						<a
							className="text-xs underline"
							href={`https://hashscan.io/testnet/transaction/${last.payoutTx}`}
							target="_blank"
							rel="noreferrer"
						>
							payout
						</a>
					)}
					{last.teeTxHash && (
						<a
							className="text-xs underline"
							href={explorerTx(last.teeTxHash)}
							target="_blank"
							rel="noreferrer"
							title="Hedera contract verified 0G's TEE signature over this grade"
						>
							0G TEE ✓
						</a>
					)}
				</span>
			)}
		</div>
	);
}
