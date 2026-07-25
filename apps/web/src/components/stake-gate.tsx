import { useQueryClient } from "@tanstack/react-query";
import { Coins, ExternalLink, ShieldCheck, Wallet } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { toast } from "sonner";
import { StatusBadge } from "#/components/status-badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent } from "#/components/ui/card";
import {
	type MarketSessionInfo,
	postStake,
	verifyWorldProof,
} from "#/market/market-api";
import {
	connect,
	explorerTx,
	sendStake,
	shortAddress,
	walletAvailable,
} from "#/market/wallet";

/**
 * The gate between watching and driving, in two steps: prove you're a human,
 * then put your own money behind the attempt. Shown in place of the drive
 * controls until both are done (pattern: hub-token-gate.tsx).
 *
 * The two steps deliberately live on different devices: World ID shows a QR
 * here and you approve on your phone, then the wallet is back on this
 * machine. Both land in this browser, which is what the hub gates on.
 */
const IDKitRequestWidget = lazy(() =>
	import("@worldcoin/idkit").then((m) => ({ default: m.IDKitRequestWidget })),
);

function Step({
	n,
	title,
	done,
	children,
}: {
	n: number;
	title: string;
	done: boolean;
	children: React.ReactNode;
}) {
	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center gap-2 text-sm font-medium">
				<span
					className={`flex size-5 items-center justify-center rounded-full text-xs ${
						done
							? "bg-success/15 text-success"
							: "bg-muted text-muted-foreground"
					}`}
				>
					{done ? "✓" : n}
				</span>
				{title}
			</div>
			<div className="pl-7">{children}</div>
		</div>
	);
}

export function StakeGate({ session }: { session: MarketSessionInfo }) {
	const queryClient = useQueryClient();
	const [open, setOpen] = useState(false);
	const [rpContext, setRpContext] = useState<Record<string, unknown> | null>(
		null,
	);
	const [preset, setPreset] = useState<unknown>(null);
	const [address, setAddress] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const world = session.world;
	const stake = session.stake;
	const verified = session.verified;
	const bonded = stake?.bond != null;

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

	const doStake = async () => {
		if (!stake?.escrowEvmAddress) {
			toast.error("this hub has no escrow configured");
			return;
		}
		setBusy(true);
		try {
			const from = address ?? (await connect());
			setAddress(from);
			const hash = await sendStake(stake.escrowEvmAddress, stake.bondHbar);
			toast.info("stake sent — waiting for the network…");
			await postStake(hash);
			toast.success(`staked ${stake.bondHbar} ℏ — you can drive now`, {
				description: explorerTx(hash),
			});
			void queryClient.invalidateQueries({ queryKey: ["market"] });
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "stake failed");
		} finally {
			setBusy(false);
		}
	};

	return (
		<Card className="mx-auto w-full max-w-lg">
			<CardContent className="flex flex-col gap-5">
				<div className="flex items-center gap-2 font-medium">
					<ShieldCheck className="size-4 text-muted-foreground" />
					Verified humans only — with skin in the game
				</div>
				<p className="text-sm text-muted-foreground">
					This is a real robot arm. To drive it you prove you're a unique adult
					human, then stake {stake?.bondHbar ?? 0.5} ℏ of your own HBAR. Do the
					task well and a TEE referee returns your stake plus{" "}
					{stake?.bonusHbar ?? 0.5} ℏ. Claim success you didn't earn and the
					stake is slashed.
				</p>

				<Step n={1} title="Prove you're human" done={verified}>
					{verified ? (
						<span className="text-sm text-muted-foreground">
							verified{session.nullifier ? ` · ${session.nullifier}` : ""}
						</span>
					) : world ? (
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
										require_user_presence={true}
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
					) : (
						<span className="text-sm text-muted-foreground">
							World verification isn't configured on this hub.
						</span>
					)}
				</Step>

				<Step
					n={2}
					title={`Stake ${stake?.bondHbar ?? 0.5} ℏ from your wallet`}
					done={bonded}
				>
					{bonded ? (
						<span className="flex items-center gap-2 text-sm text-muted-foreground">
							<StatusBadge tone="success">staked</StatusBadge>
							<span className="font-mono">
								{shortAddress(stake?.bond?.evmAddress ?? "")}
							</span>
						</span>
					) : !verified ? (
						<span className="text-sm text-muted-foreground">verify first</span>
					) : !walletAvailable() ? (
						<span className="text-sm text-muted-foreground">
							No wallet detected — install MetaMask on this device.
						</span>
					) : (
						<div className="flex flex-col gap-2">
							<Button size="sm" onClick={doStake} disabled={busy}>
								<Wallet />
								{busy
									? "confirming…"
									: address
										? `Stake ${stake?.bondHbar} ℏ`
										: "Connect wallet & stake"}
							</Button>
							<a
								className="flex items-center gap-1 text-xs text-muted-foreground underline"
								href={stake?.faucet ?? "https://portal.hedera.com/faucet"}
								target="_blank"
								rel="noreferrer"
							>
								<Coins className="size-3" />
								need testnet HBAR? (free faucet, no login)
								<ExternalLink className="size-3" />
							</a>
						</div>
					)}
				</Step>
			</CardContent>
		</Card>
	);
}
