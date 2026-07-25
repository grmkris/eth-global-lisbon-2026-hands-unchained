import { useQueryClient } from "@tanstack/react-query";
import {
	Coins,
	Copy,
	ExternalLink,
	KeyRound,
	ShieldCheck,
	Wallet,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { SlotTimer } from "#/components/slot-timer";
import { StatusBadge } from "#/components/status-badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent } from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { WorldStep } from "#/components/world-step";
import { clientId } from "#/lib/hub-api";
import { generateSlotKey, shortAddress } from "#/market/chain";
import type {
	MarketSessionInfo,
	RigSlotInfo,
	SlotsConfig,
} from "#/market/market-api";
import { noteBooked, unlockSlot } from "#/market/market-api";
import { bookSlot, connect, walletAvailable } from "#/market/zg-wallet";

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
			<div className="flex items-center gap-2 font-medium text-sm">
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

/**
 * Type the key you chose when you booked. This is also the multi-device entry
 * point — a second laptop sees only this — and the redeploy-recovery path,
 * because the hub's memory of who holds what dies with the process but the
 * commitment on chain does not.
 *
 * Unlocking is what STARTS the clock: the hub relays `startSlot` for you, so
 * there is no second wallet popup and a slot you booked but never walked up to
 * costs you nothing.
 */
export function SlotUnlock({
	rig,
	slotId,
	mine,
}: {
	rig: string;
	slotId: number;
	mine: boolean;
}) {
	const queryClient = useQueryClient();
	const [pin, setPin] = useState("");
	const [busy, setBusy] = useState(false);

	const submit = async () => {
		setBusy(true);
		try {
			const res = await unlockSlot(rig, pin.trim(), clientId);
			toast.success("slot unlocked — your 30 minutes start now", {
				description: `slot #${res.slotId}`,
			});
			setPin("");
			void queryClient.invalidateQueries({ queryKey: ["market"] });
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "unlock failed");
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="flex flex-col gap-2">
			<Label htmlFor="slot-key" className="text-muted-foreground">
				{mine
					? "Your slot key"
					: "Someone has this rig booked. If it's you, enter your key."}
			</Label>
			<div className="flex gap-2">
				<Input
					id="slot-key"
					value={pin}
					onChange={(e) => setPin(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && pin.trim()) void submit();
					}}
					placeholder="the key you chose when booking"
					className="max-w-xs font-mono"
					autoComplete="off"
				/>
				<Button
					size="sm"
					onClick={() => void submit()}
					disabled={busy || pin.trim().length === 0}
				>
					<KeyRound />
					{busy ? "unlocking…" : "Unlock & start"}
				</Button>
			</div>
			<p className="text-muted-foreground text-xs">
				slot #{slotId} · the clock starts when you unlock, not when you paid
			</p>
		</div>
	);
}

/**
 * The gate between watching and driving: prove you're human, then book the arm
 * for thirty minutes with your own OG.
 */
export function SlotGate({
	rig,
	session,
	slots,
	info,
}: {
	rig: string;
	session: MarketSessionInfo;
	/** null when this hub has no slot market wired. The gate still renders —
	 * it must, or a blocked operator sees an error with nothing to click,
	 * which is exactly what used to happen. */
	slots: SlotsConfig | null;
	info: RigSlotInfo | null;
}) {
	const queryClient = useQueryClient();
	const [key, setKey] = useState(() => generateSlotKey());
	const [busy, setBusy] = useState(false);
	// Held here, not inside a step: the address is what the World proof is
	// signed against AND what books the slot, so both steps need it.
	const [address, setAddress] = useState<`0x${string}` | null>(null);
	// Which chain holds the money. Rules are identical either side — same
	// contract, same escrow, same three strikes — so this is a currency choice,
	// not a product choice.
	const [chainKey, setChainKey] = useState(() => slots?.chains[0]?.key ?? "0g");
	const chosen =
		slots?.chains.find((c) => c.key === chainKey) ?? slots?.chains[0] ?? null;
	const verified = session.verified;
	const stakeOg = chosen?.params?.minStakeOg ?? 0;
	const rewardOg = chosen?.params?.rewardPerEpisodeOg ?? 0;
	const token = chosen?.token ?? "OG";
	const minutes = Math.round((chosen?.params?.slotSeconds ?? 1800) / 60);

	const pending = info?.pending ?? null;
	const live = info?.live ?? null;
	const needsUnlock = (pending ?? live) !== null;

	const doConnect = async () => {
		setBusy(true);
		try {
			setAddress(await connect());
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "could not connect");
		} finally {
			setBusy(false);
		}
	};

	const doBook = async () => {
		if (slots === null) {
			toast.error("booking is not configured on this hub");
			return;
		}
		if (key.trim().length < slots.minPinLength) {
			toast.error(`your key needs at least ${slots.minPinLength} characters`);
			return;
		}
		if (chosen === null) {
			toast.error("no chain is configured on this hub");
			return;
		}
		setBusy(true);
		try {
			const { hash } = await bookSlot({
				rig,
				namespace: slots.namespace,
				pin: key.trim(),
				stakeOg,
				contract: chosen.contract,
				chainKey: chosen.key,
			});
			toast.info("booking sent — waiting for the network…");
			await noteBooked(rig, hash);
			toast.success(`booked ${minutes} min on ${rig} (${chosen.label})`, {
				description: "now unlock with your key to start the clock",
			});
			void queryClient.invalidateQueries({ queryKey: ["market"] });
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "booking failed");
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
				<p className="text-muted-foreground text-sm">
					This is a real robot arm. Prove you're a unique adult human (18+),
					then book it for {minutes} minutes with {stakeOg} {token} of your own.
					Every episode you record is graded on its own by a referee running in
					a TEE on 0G; each pass pays you {rewardOg} {token}. Claim success you
					didn't earn three times and the whole stake is slashed.
				</p>

				{/* Wallet FIRST: the address is the identity everything else hangs
				    off — the World proof is signed against it, the stake comes from
				    it, and the payout goes back to it. */}
				<Step n={1} title="Connect your wallet" done={address !== null}>
					{address !== null ? (
						<span className="flex items-center gap-2 text-sm">
							<StatusBadge tone="success">connected</StatusBadge>
							<span className="font-mono text-muted-foreground">
								{shortAddress(address)}
							</span>
						</span>
					) : !walletAvailable() ? (
						<span className="text-muted-foreground text-sm">
							No wallet detected — install MetaMask on this device.
						</span>
					) : (
						<Button size="sm" onClick={() => void doConnect()} disabled={busy}>
							<Wallet />
							{busy ? "connecting…" : "Connect wallet"}
						</Button>
					)}
				</Step>

				<Step n={2} title="Prove you're human" done={verified}>
					<WorldStep session={session} address={address} />
				</Step>

				<Step
					n={3}
					title={`Book ${minutes} minutes · ${stakeOg} OG`}
					done={needsUnlock}
				>
					{slots === null ? (
						<span className="text-muted-foreground text-sm">
							Booking isn't configured on this hub yet — ask whoever deployed it
							to set ZG_SLOT_MARKET_ADDRESS.
						</span>
					) : !verified ? (
						<span className="text-muted-foreground text-sm">verify first</span>
					) : live !== null ? (
						<div className="flex flex-col gap-2">
							<span className="flex items-center gap-2 text-sm">
								<StatusBadge tone="warn">in use</StatusBadge>
								<span className="font-mono text-muted-foreground">
									{shortAddress(live.operator)}
								</span>
								<SlotTimer endAt={live.endAt} label="left" />
							</span>
							<SlotUnlock rig={rig} slotId={live.slotId} mine={false} />
						</div>
					) : pending !== null ? (
						<SlotUnlock rig={rig} slotId={pending.slotId} mine={true} />
					) : (
						<div className="flex flex-col gap-3">
							{slots !== null && slots.chains.length > 1 && (
								<div className="flex flex-col gap-1.5">
									<Label className="text-muted-foreground">
										Where your stake sits — same rules either way
									</Label>
									<div className="flex flex-wrap gap-2">
										{slots.chains.map((c) => (
											<Button
												key={c.key}
												size="sm"
												variant={c.key === chainKey ? "default" : "outline"}
												onClick={() => setChainKey(c.key)}
											>
												{c.label} · {c.params?.minStakeOg ?? "?"} {c.token}
											</Button>
										))}
									</div>
									<p className="text-muted-foreground text-xs">
										{chosen?.liveSigner
											? "This contract reads the referee's identity live from 0G's own registry — no pinned constant to trust."
											: "0G's registry isn't readable from here, so the referee's address is pinned at deploy — one constant, auditable in a single call."}
									</p>
								</div>
							)}
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="new-key" className="text-muted-foreground">
									Your slot key — you'll type this to take control
								</Label>
								<div className="flex gap-2">
									<Input
										id="new-key"
										value={key}
										onChange={(e) => setKey(e.target.value)}
										className="max-w-xs font-mono"
										autoComplete="off"
									/>
									<Button
										size="sm"
										variant="outline"
										onClick={() => {
											void navigator.clipboard?.writeText(key);
											toast.success("key copied");
										}}
									>
										<Copy />
									</Button>
								</div>
								{/* The threat model, in front of the person who bears it. */}
								<p className="text-muted-foreground text-xs">
									Hashed on chain when you book. Anyone who has it can drive
									your slot — and lose your stake. Keep the generated one unless
									you have a reason not to.
								</p>
							</div>
							<Button size="sm" onClick={() => void doBook()} disabled={busy}>
								<Wallet />
								{busy
									? "confirming…"
									: `Book ${minutes} min · ${stakeOg} ${token}`}
							</Button>
							<a
								className="flex items-center gap-1 text-muted-foreground text-xs underline"
								href={chosen?.faucet ?? "https://faucet.0g.ai"}
								target="_blank"
								rel="noreferrer"
							>
								<Coins className="size-3" />
								need testnet {token}? (free faucet)
								<ExternalLink className="size-3" />
							</a>
						</div>
					)}
				</Step>
			</CardContent>
		</Card>
	);
}
