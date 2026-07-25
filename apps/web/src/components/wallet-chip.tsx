import { Coins } from "lucide-react";
import { StatusBadge } from "#/components/status-badge";
import type { MarketSessionInfo } from "#/market/market-api";
import { explorerTx, shortAddress } from "#/market/wallet";

/**
 * The operator's money, always on screen while they drive. Without this the
 * whole payment layer is invisible to the person it pays: they verify, work
 * and get paid while seeing nothing but a robot.
 */
export function WalletChip({ session }: { session: MarketSessionInfo }) {
	const stake = session.stake;
	if (!session.verified || !stake) return null;
	const bond = stake.bond;
	const earned = stake.earnedHbar ?? 0;

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
					title="returned with a bonus if the referee passes your work"
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
		</div>
	);
}
