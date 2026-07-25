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
import { bookSlot, walletAvailable } from "#/market/zg-wallet";

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
	slots: SlotsConfig;
	info: RigSlotInfo | null;
}) {
	const queryClient = useQueryClient();
	const [key, setKey] = useState(() => generateSlotKey());
	const [busy, setBusy] = useState(false);
	const verified = session.verified;
	const stakeOg = slots.params?.minStakeOg ?? 0.05;
	const rewardOg = slots.params?.rewardPerEpisodeOg ?? 0.002;
	const minutes = Math.round((slots.params?.slotSeconds ?? 1800) / 60);

	const pending = info?.pending ?? null;
	const live = info?.live ?? null;
	const needsUnlock = (pending ?? live) !== null;

	const doBook = async () => {
		if (key.trim().length < slots.minPinLength) {
			toast.error(`your key needs at least ${slots.minPinLength} characters`);
			return;
		}
		setBusy(true);
		try {
			const { hash } = await bookSlot({
				rig,
				namespace: slots.namespace,
				pin: key.trim(),
				stakeOg,
				contract: slots.contract,
			});
			toast.info("booking sent — waiting for the network…");
			await noteBooked(rig, hash);
			toast.success(`booked ${minutes} min on ${rig}`, {
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
					then book it for {minutes} minutes with {stakeOg} OG of your own.
					Every episode you record is graded on its own by a referee running in
					a TEE on 0G; each pass pays you {rewardOg} OG. Claim success you
					didn't earn three times and the whole stake is slashed.
				</p>

				<Step n={1} title="Prove you're human" done={verified}>
					<WorldStep session={session} />
				</Step>

				<Step
					n={2}
					title={`Book ${minutes} minutes · ${stakeOg} OG`}
					done={needsUnlock}
				>
					{!verified ? (
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
					) : !walletAvailable() ? (
						<span className="text-muted-foreground text-sm">
							No wallet detected — install MetaMask on this device.
						</span>
					) : (
						<div className="flex flex-col gap-3">
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
								{busy ? "confirming…" : `Book ${minutes} min · ${stakeOg} OG`}
							</Button>
							<a
								className="flex items-center gap-1 text-muted-foreground text-xs underline"
								href={slots.faucet}
								target="_blank"
								rel="noreferrer"
							>
								<Coins className="size-3" />
								need testnet OG? (free faucet)
								<ExternalLink className="size-3" />
							</a>
						</div>
					)}
				</Step>
			</CardContent>
		</Card>
	);
}
