import { useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { type MarketSessionInfo, verifyWorldProof } from "#/market/market-api";

/**
 * Step one, everywhere: prove you're a unique adult human.
 *
 * World ID gates EXECUTION RIGHTS OVER PHYSICAL HARDWARE, which is why it
 * stays mandatory even though the stake moved chains — money stops a liar,
 * but only identity stops a thousand sybils queueing for the same arm.
 *
 * BOUND TO THE WALLET. The proof carries the operator's address as its
 * signal, so it is cryptographically tied to the address that will stake and
 * be paid. Without that binding a browser cookie was the only link between
 * "a human verified" and "this wallet booked", which meant one nullifier
 * could book from unlimited wallets and a shared browser could lend its
 * humanity to strangers. The address must therefore be known BEFORE the
 * proof is requested — that is why connecting comes first.
 *
 * The two steps still live on different devices: World ID shows a QR here and
 * you approve on your phone, while the wallet stays on this machine. Both
 * land in this browser, which is what the hub gates on.
 */
const IDKitRequestWidget = lazy(() =>
	import("@worldcoin/idkit").then((m) => ({ default: m.IDKitRequestWidget })),
);

export function WorldStep({
	session,
	address,
}: {
	session: MarketSessionInfo;
	/** the connected wallet — the proof is bound to it */
	address: `0x${string}` | null;
}) {
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
				// The signal is what binds this proof to this wallet. IDKit spells
				// it differently per preset: `signal` on proofOfHuman, and
				// `legacy_signal` on identityCheck.
				const signal = address ?? undefined;
				setPreset(
					world.preset === "proof-of-human"
						? idkit.proofOfHuman({ signal })
						: idkit.identityCheck({
								attributes: [{ type: "minimum_age", value: 18 }],
								legacy_signal: signal,
							}),
				);
			} catch (e) {
				toast.error(
					e instanceof Error ? e.message : "verification setup failed",
				);
				setOpen(false);
			}
		})();
	}, [open, world, address]);

	if (session.verified)
		return (
			<span className="text-sm text-muted-foreground">
				verified{session.nullifier ? ` · ${session.nullifier}` : ""}
				{session.boundAddress ? " · bound to your wallet" : ""}
			</span>
		);

	if (address === null)
		return (
			<span className="text-sm text-muted-foreground">
				connect your wallet first — the proof is bound to it
			</span>
		);

	/**
	 * Local bring-up only (MARKET_DEV_AUTOVERIFY=1), and it still binds the
	 * wallet — so the unlock, the ledger and the payout all behave exactly as
	 * they will with a real proof. Never reachable on a deployed hub, because
	 * the hub reports `devAutoverify: false` there.
	 */
	const devSkip = async () => {
		try {
			await verifyWorldProof({ address });
			toast.success("dev session — World ID skipped");
			void queryClient.invalidateQueries();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "dev verify failed");
		}
	};

	if (!world)
		return (
			<div className="flex flex-col gap-2">
				<span className="text-sm text-muted-foreground">
					World verification isn't configured on this hub.
				</span>
				{session.devAutoverify === true && (
					<Button size="sm" variant="outline" onClick={() => void devSkip()}>
						Skip World ID (dev)
					</Button>
				)}
			</div>
		);

	return (
		<>
			<Button size="sm" onClick={() => setOpen(true)}>
				Verify with World ID
			</Button>
			{session.devAutoverify === true && (
				<Button
					size="sm"
					variant="ghost"
					className="ml-2 text-muted-foreground"
					onClick={() => void devSkip()}
					title="MARKET_DEV_AUTOVERIFY=1 — binds this wallet without a World proof"
				>
					Skip (dev)
				</Button>
			)}
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
							await verifyWorldProof({
								...(result as unknown as Record<string, unknown>),
								// the hub records WHICH wallet this human is, and
								// refuses a proof whose signal is someone else's
								address,
							});
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
