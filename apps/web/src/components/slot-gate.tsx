import { useQueryClient } from "@tanstack/react-query";
import {
	Coins,
	ExternalLink,
	KeyRound,
	Loader2,
	Undo2,
	Wallet,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { SlotTimer } from "#/components/slot-timer";
import { StatusBadge } from "#/components/status-badge";
import { Button } from "#/components/ui/button";
import { Label } from "#/components/ui/label";
import { WorldStep } from "#/components/world-step";
import { clientId } from "#/lib/hub-api";
import type { Requirement } from "#/lib/use-start-requirements";
import { shortAddress } from "#/market/chain";
import type {
	MarketSessionInfo,
	RigSlotInfo,
	SlotsConfig,
} from "#/market/market-api";
import { noteBooked, noteSettled, unlockSlot } from "#/market/market-api";
import { useWallet } from "#/market/use-wallet";
import { bookSlot, cancelSlot } from "#/market/zg-wallet";

/**
 * One line of "what stands between you and starting this task".
 *
 * Three states, three weights: a requirement you have met is a ✓ receipt, the
 * first one you have not is the only one that gets its remedy rendered under
 * it, and anything after that is dimmed — solving them in order is the only
 * order that works, so offering the fourth fix while the second is unmet is
 * just noise.
 *
 * This is the shape the old three-step numbered wizard was reaching for. It is
 * no longer a wizard: staking and verifying are two rows of a checklist that
 * also contains "the arm is connected" and "pick how you'll drive".
 */
function RequirementRow({
	req,
	active,
	showRemedy,
	children,
}: {
	req: Requirement;
	/** the first unmet one — normally the only row that renders a remedy */
	active: boolean;
	/** `source` overrides that: switching keyboard ↔ leader is something you do
	 * repeatedly inside a slot, so its control survives being satisfied */
	showRemedy: boolean;
	children?: React.ReactNode;
}) {
	return (
		<div className="flex items-start gap-2 text-sm">
			<span
				className={req.met ? "text-success" : "text-muted-foreground"}
				aria-hidden="true"
			>
				{req.met ? "✓" : "○"}
			</span>
			<div className="flex min-w-0 flex-1 flex-col gap-2">
				<span
					className={
						req.met
							? "text-muted-foreground"
							: active
								? "font-medium"
								: "text-muted-foreground/60"
					}
				>
					{req.label}
				</span>
				{showRemedy && children}
			</div>
		</div>
	);
}

/** Requirements nobody can act on from here still deserve a sentence saying
 * whose job it is, rather than a checkbox that just sits there unticked.
 * `source` is absent on purpose — it has a real control now, not a pointer. */
const POINTER: Partial<Record<Requirement["key"], string>> = {
	online: "the rig has to reconnect to the hub — nothing to do here",
	armConnected: "connect it from the chips below",
	cameras: "the rig owner assigns workspace/wrist in the Rig owner panel",
	lease: "someone else is driving; picking a source takes over",
};

/**
 * THE FALLBACK, not the happy path.
 *
 * Staking now starts the slot in the same breath (see `doBook`), so on a free
 * rig nobody ever sees this button. It exists for the four cases where the
 * clock genuinely cannot have started yet:
 *
 *  - you queued behind someone and have just been promoted to the head;
 *  - a second laptop, which holds no slot token of its own;
 *  - the hub restarted mid-slot — its memory of who holds what died with the
 *    process, but the chain's did not;
 *  - the relay failed after your booking landed, so the money is committed and
 *    the arm is not open.
 *
 * All four are "the arm is yours, take it", which is why the button says so.
 * It used to say "type the key you chose when you booked" — there has been no
 * key since the wallet became the key.
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
					? `slot #${slotId} · your 30 minutes start when you press this`
					: `slot #${slotId} is held by another wallet — if that wallet is yours, this opens it`}
			</p>
		</div>
	);
}

/**
 * Staking is TWO chain writes behind one button, and collapsing them without
 * saying so would be a downgrade: six to twenty seconds of an unchanging
 * spinner is indistinguishable from a hang. So each wait gets named.
 *
 * `signing` is waiting for a HUMAN (the wallet modal is open and their
 * attention is there, not here); `staking` and `opening` are waiting for two
 * different CHAINS of causation. Naming them separately is what makes a stall
 * diagnosable — "stuck staking" and "stuck opening" are different problems with
 * different fixes.
 *
 * Same pattern as `stageOf` in slot-panel.tsx, deliberately: one named stage at
 * a time, a spinner, muted text.
 */
type BookPhase = "idle" | "signing" | "staking" | "opening";

/** Short enough for a button; the sentence underneath carries the detail.
 * `idle` is absent on purpose — the caller's own label wins there, because it
 * differs between taking a free rig and joining a queue. */
const PHASE_LABEL: Partial<Record<BookPhase, string>> = {
	signing: "confirm in your wallet…",
	staking: "staking…",
	opening: "opening the arm…",
};

/**
 * The gate between watching and driving: prove you're human, then stake and
 * start driving.
 */
export function StartRequirements({
	rig,
	session,
	slots,
	info,
	requirements,
	sourcePicker,
}: {
	rig: string;
	/** null on a hub with MARKET_MODE off. The `verified` and `staked` rows are
	 * auto-met there so neither remedy renders, but this panel must still mount:
	 * it hosts the source picker, which every hub needs. */
	session: MarketSessionInfo | null;
	/** null when this hub has no slot market wired. It still renders — it must,
	 * or a blocked operator sees an error with nothing to click, which is
	 * exactly what used to happen. */
	slots: SlotsConfig | null;
	info: RigSlotInfo | null;
	/** everything between this operator and one recorded episode, in order */
	requirements: ReadonlyArray<Requirement>;
	/** the remedy for `pick how you'll drive`. Injected rather than imported, so
	 * this file still knows nothing about teleop — same layering as TaskPanel's
	 * `renderRequirements`. */
	sourcePicker?: React.ReactNode;
}) {
	const queryClient = useQueryClient();
	const [busy, setBusy] = useState(false);
	const [phase, setPhase] = useState<BookPhase>("idle");
	const inFlight = busy || phase !== "idle";
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
	 * connected-but-not-yet-verified case.
	 *
	 * The injected half now lives in `useWallet` because the nav shows it too —
	 * two copies of "which account is this" would drift the moment someone
	 * switched accounts in MetaMask.
	 */
	const wallet = useWallet();
	const walletAddress = wallet.address;
	const bound = (session?.boundAddress ?? null) as `0x${string}` | null;
	const address = bound ?? walletAddress;
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
	const verified = session?.verified === true;
	const stakeOg = chosen?.params?.minStakeOg ?? 0;
	const token = chosen?.token ?? "OG";
	const minutes = Math.round((chosen?.params?.slotSeconds ?? 1800) / 60);

	const pending = info?.pending ?? null;
	const live = info?.live ?? null;

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
		setPhase("signing");
		try {
			const { hash, account } = await bookSlot({
				rig,
				namespace: slots.namespace,
				stakeOg,
				contract: chosen.contract,
				chainKey: chosen.key,
				// approved in the wallet; now we are waiting on the chain instead
				onSigned: () => setPhase("staking"),
			});
			// bookSlot waits for the receipt, so the queue below is already real
			const dto = await noteBooked(rig, hash);

			/**
			 * STAKING IS TAKING, when there is nothing to wait for.
			 *
			 * You paid to drive. If the rig was free you are the head the instant
			 * the transaction mines, so asking you to then press "Take control"
			 * is asking you to re-confirm a decision you already made with money.
			 * The hub relays `startSlot` here with its own key — that is why no
			 * second wallet popup appears.
			 *
			 * Only when the rig was FREE. Behind a live slot you are queued, and
			 * a clock started now would bill you for someone else's thirty
			 * minutes; you press it yourself once you are promoted.
			 */
			const iAmTheHead =
				dto.pending !== null &&
				dto.pending.operator.toLowerCase() === account.toLowerCase();

			if (!iAmTheHead) {
				toast.success(`booked ${minutes} min on ${rig} (${chosen.label})`, {
					description:
						"you're in the queue — take control when the arm reaches you",
				});
				return;
			}

			setPhase("opening");
			try {
				await unlockSlot(rig, clientId);
				toast.success(`the arm is yours for ${minutes} minutes`, {
					description: `${stakeOg} ${token} staked on ${chosen.label} — drive whenever you're ready`,
				});
			} catch (relayError) {
				// The money IS committed. This must never read as "booking
				// failed" — say what happened and leave the fallback button,
				// which renders on its own because `pending` is now set.
				console.error("[slots] relay after booking failed:", relayError);
				toast.warning("you're booked — but the arm didn't open", {
					description: "press Take control to start your 30 minutes",
				});
			}
		} catch (e) {
			const message = e instanceof Error ? e.message : "booking failed";
			// Dismissing your own wallet prompt is a decision, not a fault; a red
			// error for a deliberate act is noise.
			if (/user rejected|denied transaction/i.test(message))
				toast.info("booking cancelled");
			else toast.error(message);
		} finally {
			setPhase("idle");
			void queryClient.invalidateQueries({ queryKey: ["market"] });
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
			<Button size="sm" onClick={() => void doBook()} disabled={inFlight}>
				{phase === "idle" ? <Wallet /> : <Loader2 className="animate-spin" />}
				{PHASE_LABEL[phase] ?? label}
			</Button>
			{/* The detail line REPLACES the faucet link while a transaction is in
			    flight: the faucet is advice for a booking that hasn't started,
			    and it comes back the moment the phase returns to idle — which is
			    also exactly when a failure would make it relevant again. */}
			{phase === "idle" ? (
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
			) : (
				<p className="text-muted-foreground text-xs">
					{phase === "signing"
						? `Your wallet is asking you to approve ${stakeOg} ${token}.`
						: phase === "staking"
							? `${stakeOg} ${token} → SlotMarket on ${chosen?.label ?? "chain"}. One signature, ever.`
							: // Answers the question people ask at precisely this
								// moment: why isn't MetaMask popping up again?
								"Starting your 30 minutes — the hub pays this transaction, not you."}
				</p>
			)}
		</div>
	);

	/**
	 * The remedy for the `staked` requirement. Body unchanged from when this was
	 * step 3 of a wizard — the live/queue/pending/book branches and the
	 * two-writes-one-button narration are load-bearing and stay exactly as they
	 * were; only where they render has moved.
	 */
	const stakeRemedy = (
		<>
			{slots === null ? (
				<span className="text-muted-foreground text-sm">
					Booking isn't configured on this hub yet — ask whoever deployed it to
					set ZG_SLOT_MARKET_ADDRESS.
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
								only starts when you take control, and a head that never shows
								up is skipped automatically.
							</p>
						</div>
					) : (
						/* Booking while someone else drives — a FIFO queue the
								   contract always supported and nothing ever offered. */
						bookBlock(`Join the queue · ${stakeOg} ${token}`)
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
						disabled={inFlight || pending.contract === null}
					>
						<Undo2 />
						Cancel booking · full refund
					</Button>
				</div>
			) : (
				bookBlock(`Stake ${stakeOg} ${token} & start`)
			)}
		</>
	);

	/**
	 * The remedy for `verified`. WorldStep already renders its own one-line
	 * "verified · World ID … · bound to your wallet" when it is satisfied, so the
	 * met row carries that instead of a bare label.
	 *
	 * Connecting lives HERE rather than above the list, because it is not a
	 * requirement of its own — it is a precondition of this one. The World proof
	 * is signed against the address, so without a wallet WorldStep can only say
	 * "connect first", and the button that does it belongs in the same place as
	 * that sentence. Once connected it vanishes: the nav badge shows the address.
	 */
	const verifiedRemedy = (
		<>
			{address === null &&
				(!wallet.available ? (
					<span className="text-muted-foreground text-sm">
						No wallet detected — install MetaMask on this device.
					</span>
				) : (
					<Button
						size="sm"
						className="self-start"
						onClick={() => wallet.connect(chainKey)}
						disabled={wallet.connecting}
					>
						<Wallet />
						{wallet.connecting ? "connecting…" : "Connect wallet"}
					</Button>
				))}
			{session !== null && <WorldStep session={session} address={address} />}
		</>
	);

	// the first unmet requirement is the only one that gets a remedy: they have
	// to be solved in order, so offering the fourth fix while the second is open
	// is noise
	const firstUnmet = requirements.find((r) => !r.met) ?? null;

	return (
		<div className="flex flex-col gap-3 border-t pt-3">
			<div className="text-muted-foreground text-xs">
				to start this you need:
			</div>

			{/* Lifted OUT of the wallet step, which no longer renders in the state
			    that produces this: connected, but on a different account than the
			    World proof was signed against. Silence here means a stake that
			    succeeds and an arm that never opens. */}
			{mismatch && (
				<p className="text-warn text-xs">
					Your wallet is on {shortAddress(walletAddress ?? "")} but you proved
					World ID on {shortAddress(bound ?? "")}. Switch back to that account,
					or verify again on this one — the arm only opens for the wallet that
					staked.
				</p>
			)}

			{requirements.map((req) => (
				<RequirementRow
					key={req.key}
					req={req}
					active={firstUnmet?.key === req.key}
					// the source chips outlive being satisfied — everything else is a
					// fix you only need while it is still broken
					showRemedy={firstUnmet?.key === req.key || req.key === "source"}
				>
					{req.key === "verified" ? (
						verifiedRemedy
					) : req.key === "staked" ? (
						stakeRemedy
					) : req.key === "source" ? (
						sourcePicker
					) : POINTER[req.key] ? (
						<span className="text-muted-foreground text-xs">
							{POINTER[req.key]}
						</span>
					) : null}
				</RequirementRow>
			))}
		</div>
	);
}

/**
 * The terms, as facts rather than a paragraph — the price of everything in the
 * worklist, so it sits in that card's header rather than inside one task's
 * requirements. What you are deciding with is four numbers; the mechanism (a
 * TEE referee on 0G) is not a thing anyone weighs at the turnstile.
 *
 * The slashing clause stays on screen. It is the risk being accepted, and it
 * does not go behind a fold or a click.
 */
export function SlotTerms({ slots }: { slots: SlotsConfig | null }) {
	const c = slots?.chains[0];
	if (!c) return null;
	return (
		<p className="font-mono text-muted-foreground text-xs">
			{c.params?.minStakeOg ?? 0} {c.token} ·{" "}
			{Math.round((c.params?.slotSeconds ?? 1800) / 60)} min · +
			{c.params?.rewardPerEpisodeOg ?? 0} {c.token} per pass ·{" "}
			{c.params?.maxStrikes ?? 3} false claims → stake slashed
		</p>
	);
}
