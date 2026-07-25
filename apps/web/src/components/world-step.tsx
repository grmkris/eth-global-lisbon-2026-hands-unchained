import { useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { type MarketSessionInfo, verifyWorldProof } from "#/market/market-api";

/**
 * Step one, everywhere: prove you're a unique adult human.
 *
 * Lifted out of stake-gate.tsx unchanged so the slot flow and the (dormant)
 * Hedera flow share one implementation. World ID gates EXECUTION RIGHTS OVER
 * PHYSICAL HARDWARE, which is why it stays mandatory even though the stake
 * moved chains — the money stops a liar, but only identity stops a thousand
 * sybils queueing for the same arm.
 *
 * The two steps deliberately live on different devices: World ID shows a QR
 * here and you approve on your phone, then the wallet is back on this machine.
 * Both land in this browser, which is what the hub gates on.
 */
const IDKitRequestWidget = lazy(() =>
	import("@worldcoin/idkit").then((m) => ({ default: m.IDKitRequestWidget })),
);

export function WorldStep({ session }: { session: MarketSessionInfo }) {
	const queryClient = useQueryClient();
	const [open, setOpen] = useState(false);
	const [rpContext, setRpContext] = useState<Record<string, unknown> | null>(
		null,
	);
	const [preset, setPreset] = useState<unknown>(null);
	const world = session.world;

	// rp_context is short-lived — fetch it only when the widget opens
	useEffect(() => {
		if (!open || !world) return;
		void (async () => {
			try {
				const res = await fetch("/api/market/rp-context");
				if (!res.ok) throw new Error("rp-context unavailable");
				setRpContext((await res.json()) as Record<string, unknown>);
				const idkit = await import("@worldcoin/idkit");
				setPreset(
					world.preset === "proof-of-human"
						? idkit.proofOfHuman({})
						: idkit.identityCheck({
								attributes: [{ type: "minimum_age", value: 18 }],
							}),
				);
			} catch (e) {
				toast.error(
					e instanceof Error ? e.message : "verification setup failed",
				);
				setOpen(false);
			}
		})();
	}, [open, world]);

	if (session.verified)
		return (
			<span className="text-sm text-muted-foreground">
				verified{session.nullifier ? ` · ${session.nullifier}` : ""}
			</span>
		);

	if (!world)
		return (
			<span className="text-sm text-muted-foreground">
				World verification isn't configured on this hub.
			</span>
		);

	return (
		<>
			<Button size="sm" onClick={() => setOpen(true)}>
				Verify with World ID
			</Button>
			{open && rpContext !== null && preset !== null && (
				<Suspense fallback={null}>
					<IDKitRequestWidget
						open={open}
						onOpenChange={setOpen}
						app_id={world.appId as `app_${string}`}
						action={world.action}
						// biome-ignore lint/suspicious/noExplicitAny: rp_context/preset shapes come from the server + idkit at runtime
						rp_context={rpContext as any}
						// biome-ignore lint/suspicious/noExplicitAny: see above
						preset={preset as any}
						// biome-ignore lint/suspicious/noExplicitAny: env is a runtime string from the hub
						environment={world.env as any}
						allow_legacy_proofs={false}
						// a simulator has no camera to prove liveness with
						require_user_presence={world.requirePresence === true}
						handleVerify={async (result) => {
							await verifyWorldProof(
								result as unknown as Record<string, unknown>,
							);
						}}
						onSuccess={() => {
							toast.success("verified");
							void queryClient.invalidateQueries();
						}}
						onError={(code) => {
							toast.error(`verification failed: ${code}`);
						}}
					/>
				</Suspense>
			)}
		</>
	);
}
