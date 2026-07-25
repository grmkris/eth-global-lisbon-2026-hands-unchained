import { useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { Card, CardContent } from "#/components/ui/card";
import { type MarketSessionInfo, verifyWorldProof } from "#/market/market-api";

/**
 * The human gate, shown in place of the drive controls when the market is on
 * and this browser holds no verified session (pattern: hub-token-gate.tsx).
 *
 * Flow: fetch a backend-signed rp_context -> IDKitRequestWidget (World App
 * scans/deep-links) -> handleVerify forwards the proof to /api/market/verify
 * (cloud verify, session cookie minted) -> queries invalidate -> the drive
 * buttons appear. Preset comes from the server (WORLD_PRESET): Identity
 * Check (18+, liveness) or plain Proof of Human as fallback.
 */
const IDKitRequestWidget = lazy(() =>
	import("@worldcoin/idkit").then((m) => ({ default: m.IDKitRequestWidget })),
);

export function VerifyGate({ session }: { session: MarketSessionInfo }) {
	const queryClient = useQueryClient();
	const [open, setOpen] = useState(false);
	const [rpContext, setRpContext] = useState<Record<string, unknown> | null>(
		null,
	);
	const [preset, setPreset] = useState<unknown>(null);

	const world = session.world;

	// rp_context is short-lived — fetch it lazily when the user opens the gate
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

	return (
		<Card className="mx-auto w-full max-w-md">
			<CardContent className="flex flex-col gap-4">
				<div className="flex items-center gap-2 font-medium">
					<ShieldCheck className="size-4 text-muted-foreground" />
					Humans only — verify to drive
				</div>
				<p className="text-sm text-muted-foreground">
					This is a real robot. Driving it requires proof you're a unique adult
					human — verified with World ID, live at the controls. We learn a
					one-way identifier and "over 18": nothing else.
				</p>
				{world ? (
					<>
						<Button onClick={() => setOpen(true)}>Verify with World ID</Button>
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
									allow_legacy_proofs={false}
									require_user_presence={true}
									handleVerify={async (result) => {
										await verifyWorldProof(
											result as unknown as Record<string, unknown>,
										);
									}}
									onSuccess={() => {
										toast.success("verified — you can drive now");
										void queryClient.invalidateQueries();
									}}
									onError={(code) => {
										toast.error(`verification failed: ${code}`);
									}}
								/>
							</Suspense>
						)}
					</>
				) : (
					<p className="text-sm text-muted-foreground">
						World verification isn't configured on this hub yet
						{session.devAutoverify ? " — dev auto-verify is on" : ""}.
					</p>
				)}
			</CardContent>
		</Card>
	);
}
