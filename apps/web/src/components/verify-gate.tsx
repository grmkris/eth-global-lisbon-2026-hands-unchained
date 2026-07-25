import { useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { Button } from "#/components/ui/button";
import { Card, CardContent } from "#/components/ui/card";
import type { MarketSessionInfo } from "#/market/market-api";

/**
 * The human gate, shown in place of the drive controls when the market is on
 * and this browser holds no verified session (pattern: hub-token-gate.tsx).
 * M4 mounts the IDKit widget here; until then the card explains the deny
 * path, and in dev the session auto-mints on the next query anyway.
 */
export function VerifyGate({ session }: { session: MarketSessionInfo }) {
	const queryClient = useQueryClient();

	return (
		<Card className="mx-auto w-full max-w-md">
			<CardContent className="flex flex-col gap-4">
				<div className="flex items-center gap-2 font-medium">
					<ShieldCheck className="size-4 text-muted-foreground" />
					Humans only — verify to drive
				</div>
				<p className="text-sm text-muted-foreground">
					This robot is driven by verified humans. Prove you're a unique person
					(18+) with World ID — takes under a minute, and we learn nothing about
					you beyond that.
				</p>
				{session.world ? (
					// M4: replace with the IDKitRequestWidget flow (identityCheck
					// preset: minimum_age 18 + require_user_presence)
					<Button disabled>World ID verification coming online…</Button>
				) : (
					<p className="text-sm text-muted-foreground">
						Verification isn't configured on this hub yet
						{session.devAutoverify ? " — dev auto-verify is on" : ""}.
					</p>
				)}
				<Button
					variant="outline"
					onClick={() =>
						void queryClient.invalidateQueries({ queryKey: ["market"] })
					}
				>
					I've verified — refresh
				</Button>
			</CardContent>
		</Card>
	);
}
