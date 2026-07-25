import { useQueryClient } from "@tanstack/react-query";
import {
	Coins,
	ExternalLink,
	KeyRound,
	ShieldCheck,
	Undo2,
	Wallet,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { SlotTimer } from "#/components/slot-timer";
import { StatusBadge } from "#/components/status-badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent } from "#/components/ui/card";
import { Label } from "#/components/ui/label";
import { WorldStep } from "#/components/world-step";
import { clientId } from "#/lib/hub-api";
import { shortAddress } from "#/market/chain";
import type {
	MarketSessionInfo,
	RigSlotInfo,
	SlotsConfig,
} from "#/market/market-api";
import { noteBooked, noteSettled, unlockSlot } from "#/market/market-api";
import {
	bookSlot,
	cancelSlot,
	connect,
	currentAddress,
	walletAvailable,
} from "#/market/zg-wallet";

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
	const [busy, setBusy] = useState(false);

	const submit = async () => {
		setBusy(true);
		try {
			const res = await unlockSlot(rig, clientId);
			toast.success("slot unlocked — your 30 minutes start now", {
				description: `slot #${res.slotId}`,
			});
			void queryClient.invalidateQueries({ queryKey: ["market"] });
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "unlock failed");
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="flex flex-col gap-2">
			<Button size="sm" onClick={() => void submit()} disabled={busy}>
				<KeyRound />
				{busy ? "unlocking…" : mine ? "Take control & start" : "This is mine"}
			</Button>
			<p className="text-muted-foreground text-xs">
				{mine
					? `slot #${slotId} · the clock starts when you take control, not when you paid`
					: `slot #${slotId} is held by another wallet — if that wallet is yours, this opens it`}
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
	const [busy, setBusy] = useState(false);
	/**
	 * THE ADDRESS SURVIVES A REFRESH — three sources, most authoritative first.
	 *
	 * Held here, not inside a step: it is what the World proof is signed against
	 * AND what books the slot, so both steps need it.
	 *
	 * Reloading used to reset this to null while the session cookie kept step 2
	 * ticked, so the card rendered an unchecked "connect your wallet" above a
	 * checked "you're verified" — self-contradictory, and the reason it looked
	 * like state was leaking between browsers.
	 *
	 * `session.boundAddress` wins because it is the address World actually
	 * signed against and the only one the hub will accept at unlock; the
	 * injected wallet's current account is a fallback for the
	 * connected-but-not-yet-verified case. Deliberately NOT localStorage: a
	 * stale address there would outlive both the wallet's authorisation and the
	 * World binding, and start lying rather than merely forgetting.
	 */
	const [walletAddress, setWalletAddress] = useState<`0x${string}` | null>(
		null,
	);
	const bound = (session.boundAddress ?? null) as `0x${string}` | null;
	const address = bound ?? walletAddress;
	/** eth_accounts, which reports an ALREADY-authorised account and never
	 * prompts — so a refresh costs the operator no popup. */
	useEffect(() => {
		void currentAddress()
			.then(setWalletAddress)
			.catch(() => {});
	}, []);
	/** They reconnected on a different account than the one they verified with.
	 * Silence here means a booking that succeeds and an unlock that 403s. */
	const mismatch =
		bound !== null &&
		walletAddress !== null &&
		bound.toLowerCase() !== walletAddress.toLowerCase();
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

	/**
	 * Your own place in the line, when the arm is someone else's.
	 *
	 * Booking used to be offered ONLY on a free rig, so the single most common
	 * situation — walking up to a rig somebody is already driving — had no way
	 * to put money down at all. The contract has always taken the booking (it is
	 * an append-only queue); nothing asked for it.
	 */
	const myQueued =
		address === null
			? null
			: (info?.queue.find(
					(q) =>
						q.status === "booked" &&
						q.operator.toLowerCase() === address.toLowerCase(),
				) ?? null);
	/**
	 * How long until the arm is yours.
	 *
	 * `position` is the index in the on-chain queue and position 0 is the HEAD,
	 * i.e. whoever is driving right now — so the number of people you actually
	 * wait for is `position - 1` full slots, plus what is left of the live one.
	 * Counting `position` slots would quote a 30-minute wait to the person who
	 * is next.
	 */
	const waitMinutes = (position: number): number =>
		Math.round(
			(Math.max(0, position - 1) *
				(chosen?.params?.slotSeconds ?? 1800) *
				1000 +
				(live?.remainingMs ?? 0)) /
				60_000,
		);

	const doConnect = async () => {
		setBusy(true);
		try {
			setWalletAddress(await connect(chainKey));
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "could not connect");
		} finally {
			setBusy(false);
		}
	};

	const doCancel = async () => {
		if (pending === null || pending.contract === null) return;
		setBusy(true);
		try {
			const hash = await cancelSlot(
				pending.contract,
				pending.slotId,
				pending.chain,
			);
			await noteSettled(rig, pending.slotId, hash, "cancel");
			toast.success("booking cancelled — your stake is on its way back");
			void queryClient.invalidateQueries({ queryKey: ["market"] });
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "cancel failed");
		} finally {
			setBusy(false);
		}
	};

	const doBook = async () => {
		if (slots === null) {
			toast.error("booking is not configured on this hub");
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
				stakeOg,
				contract: chosen.contract,
				chainKey: chosen.key,
			});
			toast.info("booking sent — waiting for the network…");
			await noteBooked(rig, hash);
			toast.success(`booked ${minutes} min on ${rig} (${chosen.label})`, {
				description:
					live !== null
						? "you're in the queue — the clock starts when you take control"
						: "take control when you're ready — that starts the clock, not this",
			});
			void queryClient.invalidateQueries({ queryKey: ["market"] });
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "booking failed");
		} finally {
			setBusy(false);
		}
	};

	/** One booking transaction, two places it belongs: a free rig, and joining
	 * the line behind a live one. Same call, same stake, different sentence. */
	const bookBlock = (label: string) => (
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
			<Button size="sm" onClick={() => void doBook()} disabled={busy}>
				<Wallet />
				{busy ? "confirming…" : label}
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
	);

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
						<div className="flex flex-col gap-1.5">
							<span className="flex items-center gap-2 text-sm">
								<StatusBadge tone="success">
									{bound !== null ? "verified wallet" : "connected"}
								</StatusBadge>
								<span className="font-mono text-muted-foreground">
									{shortAddress(address)}
								</span>
							</span>
							{mismatch && (
								<span className="text-warn text-xs">
									Your wallet is on {shortAddress(walletAddress ?? "")} but you
									proved World ID on {shortAddress(bound ?? "")}. Switch back to
									that account, or verify again on this one — the arm only opens
									for the wallet that booked it.
								</span>
							)}
						</div>
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

				{/* done = verified AND bound. A session with no address passes every
				    gate up to the unlock and then fails there, so ticking this on
				    `verified` alone sends people to a 409 with a green check. */}
				<Step
					n={2}
					title="Prove you're human"
					done={verified && bound !== null}
				>
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
						<div className="flex flex-col gap-3">
							<span className="flex items-center gap-2 text-sm">
								<StatusBadge tone="warn">in use</StatusBadge>
								<span className="font-mono text-muted-foreground">
									{shortAddress(live.operator)}
								</span>
								<SlotTimer endAt={live.endAt} label="left" />
							</span>
							{myQueued !== null ? (
								<div className="flex flex-col gap-1">
									<span className="flex items-center gap-2 text-sm">
										<StatusBadge tone="info">
											{myQueued.position <= 1
												? "you're next"
												: `${myQueued.position - 1} ahead of you`}
										</StatusBadge>
										<span className="text-muted-foreground">
											yours in about {waitMinutes(myQueued.position)} min
										</span>
									</span>
									<p className="text-muted-foreground text-xs">
										Your stake is already down. Nothing to watch for — the clock
										only starts when you take control, and a head that never
										shows up is skipped automatically.
									</p>
								</div>
							) : (
								/* Booking while someone else drives — a FIFO queue the
								   contract always supported and nothing ever offered. */
								bookBlock("Join the queue")
							)}
							<SlotUnlock rig={rig} slotId={live.slotId} mine={false} />
						</div>
					) : pending !== null ? (
						<div className="flex flex-col gap-2">
							<SlotUnlock rig={rig} slotId={pending.slotId} mine={true} />
							{/* The 409 on a cross-chain double-booking already tells the
							    operator to "cancel for a refund" — this is the thing it
							    was telling them to press. */}
							<Button
								size="sm"
								variant="ghost"
								className="self-start text-muted-foreground"
								onClick={() => void doCancel()}
								disabled={busy || pending.contract === null}
							>
								<Undo2 />
								Cancel booking · full refund
							</Button>
						</div>
					) : (
						bookBlock(`Book ${minutes} min · ${stakeOg} ${token}`)
					)}
				</Step>
			</CardContent>
		</Card>
	);
}
