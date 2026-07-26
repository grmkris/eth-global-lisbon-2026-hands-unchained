import { useQuery } from "@tanstack/react-query";
import { Wallet } from "lucide-react";
import { Button } from "#/components/ui/button";
import { shortAddress } from "#/market/chain";
import { marketSessionQuery } from "#/market/market-api";
import { useWallet } from "#/market/use-wallet";

/**
 * Wallet identity in the nav, next to the hub's health dot — the same class of
 * thing: a persistent readout of what this browser is connected to.
 *
 * It lived only inside the drive page's gate, which meant the address vanished
 * the moment the gate was satisfied. That is backwards: once you have money on
 * an arm is exactly when you want to see which account is holding it.
 *
 * Mono + a dot, not a branded pill: this is chrome, and the design system
 * reserves color for state. The dot is green only when the wallet is the one
 * World ID was proved against — an address that cannot unlock a slot should
 * not look like an address that can.
 */
export function WalletBadge() {
	const { address, available, connecting, connect } = useWallet();
	const market = useQuery(marketSessionQuery);

	// nothing to connect to and nothing to pay for — stay out of the nav
	if (!available && market.data?.marketMode !== true) return null;

	if (address === null)
		return (
			<Button
				size="xs"
				variant="outline"
				disabled={connecting || !available}
				title={
					available
						? "connect the wallet that stakes and gets paid"
						: "no wallet detected — install MetaMask on this device"
				}
				onClick={() => connect()}
			>
				<Wallet />
				{connecting
					? "connecting…"
					: available
						? "Connect wallet"
						: "No wallet"}
			</Button>
		);

	const bound = (market.data?.boundAddress ?? null) as string | null;
	const verified =
		bound !== null && bound.toLowerCase() === address.toLowerCase();
	// connected on a different account than the one World ID signed — a booking
	// would succeed here and the unlock would then 403
	const mismatch = bound !== null && !verified;

	return (
		<span
			className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground"
			title={
				mismatch
					? `World ID was proved on ${shortAddress(bound)} — switch back to that account to unlock a slot`
					: verified
						? "verified wallet — this is the account that books, stakes and gets paid"
						: "connected wallet"
			}
		>
			<span
				className={
					mismatch
						? "size-2 rounded-full bg-warn"
						: verified
							? "size-2 rounded-full bg-success"
							: "size-2 rounded-full bg-muted-foreground/40"
				}
			/>
			{shortAddress(address)}
		</span>
	);
}
