import { useQueryClient } from "@tanstack/react-query";
import {
	Check,
	CheckCircle2,
	ExternalLink,
	Loader2,
	ShieldAlert,
	TriangleAlert,
	Wallet,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
	formatRemaining,
	SlotTimer,
	useCountdown,
} from "#/components/slot-timer";
import { StatusBadge, type StatusTone } from "#/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { Button } from "#/components/ui/button";
import { Card, CardContent } from "#/components/ui/card";
import {
	explorerAddressFor,
	explorerTxFor,
	shortAddress,
	tokenFor,
} from "#/market/chain";
import type {
	RigSlotInfo,
	SlotEpisode,
	SlotSummary,
} from "#/market/market-api";
import { noteSettled } from "#/market/market-api";
import { endEarlySlot, settleSelf } from "#/market/zg-wallet";

/**
 * The operator's own ledger for this slot: what each episode did to their
 * money and their strike count, as it happens.
 *
 * Deliberately NOT the same thing as TaskPanel. That one owns the DATASET —
 * "episode 13 of 20 for this task, 20s each", which is cumulative across every
 * operator forever. This owns the MONEY — one person's last thirty minutes.
 * Different questions, different keys; neither belongs inside the other.
 */

const gradeTone = (ep: SlotEpisode): StatusTone => {
	if (ep.grade === null) return "neutral";
	return ep.grade.pass ? "success" : "danger";
};

/** A strike is the specific thing that costs money: an episode the operator
 * CLAIMED was a success, that a TEE-ATTESTED referee failed. Anything else —
 * an honest discard, a local grade with no signature — cannot strike. */
const isStrike = (ep: SlotEpisode): boolean =>
	ep.attested === true && ep.grade?.pass === false && ep.claimed === "success";

/**
 * Where this episode is, in words.
 *
 * The stages were always in the DTO; this panel used to collapse them into one
 * "referee deliberating…" spinner covering everything from finish to anchored.
 * That single line spans a ~60-second round trip through 0G plus two chain
 * writes, and an unchanging spinner for a minute is indistinguishable from a
 * hang — which is exactly how it was reported. Null means there is nothing in
 * flight and the verdict is the whole story.
 */
const stageOf = (ep: SlotEpisode): string | null => {
	if (ep.claimed === "slot_expired") return null;
	switch (ep.status) {
		case "open":
			return null; // the ● REC badge says it better
		case "closed":
			return ep.measured
				? "0G referee deliberating…"
				: "reading your episode off the rig…";
		case "graded":
			return "posting the verdict on chain…";
		case "paid":
		case "rejected":
			return "anchoring the evidence…";
		default:
			return null; // anchored — done
	}
};

function EpisodeRow({ ep, index }: { ep: SlotEpisode; index: number }) {
	const stage = stageOf(ep);
	return (
		<div className="flex flex-col gap-1 border-b py-2 text-sm last:border-b-0">
			<div className="flex flex-wrap items-center gap-2">
				<span className="w-8 font-mono text-muted-foreground text-xs">
					#{ep.episodeIndex ?? index + 1}
				</span>
				<span className="min-w-0 flex-1 truncate">
					{ep.taskTitle ?? "attempt"}
				</span>

				{ep.claimed === "slot_expired" ? (
					<StatusBadge
						tone="neutral"
						title="your slot ended mid-recording — this was not graded and is not a strike"
					>
						cut off by the clock
					</StatusBadge>
				) : ep.status === "open" ? (
					<StatusBadge tone="danger">● REC</StatusBadge>
				) : (
					<>
						{/* The verdict appears the moment it exists, and the stage line
						    keeps running beside it until the money has actually moved —
						    they answer different questions. */}
						{ep.grade !== null && (
							<StatusBadge tone={gradeTone(ep)}>
								{ep.grade.pass ? "pass" : "fail"} {ep.grade.score}
							</StatusBadge>
						)}
						{ep.attested === true ? (
							<StatusBadge
								tone="success"
								title="graded inside 0G's TEE and the signature was verified on chain"
							>
								0G TEE ✓
							</StatusBadge>
						) : ep.attested === false ? (
							<StatusBadge
								tone="neutral"
								title="0G was unreachable, so the hub graded this locally. An unattested grade can pay you but can never cost you a strike."
							>
								local grade
							</StatusBadge>
						) : null}
						{isStrike(ep) && (
							<StatusBadge
								tone="danger"
								title="claimed success, referee failed it"
							>
								strike
							</StatusBadge>
						)}
						{stage !== null && (
							<span className="flex items-center gap-1.5 text-muted-foreground">
								<Loader2 className="size-3 animate-spin" />
								<span className="text-xs">{stage}</span>
							</span>
						)}
					</>
				)}

				{ep.slotTx && (
					<a
						className="text-muted-foreground text-xs underline"
						href={explorerTxFor(ep.slotChain, ep.slotTx)}
						target="_blank"
						rel="noreferrer"
						title="the verdict, on chain"
					>
						<ExternalLink className="inline size-3" />
					</a>
				)}
			</div>

			{/* The referee's own words, promoted out of a title= tooltip nobody
			    hovers. This is the only place an operator learns WHY. */}
			{ep.grade?.reason && (
				<p className="pl-8 text-muted-foreground text-xs">
					{ep.grade.reason}
					<span className="ml-1 opacity-70">— {ep.grade.provider}</span>
				</p>
			)}

			{/* The 0G artifact itself. A badge saying "TEE ✓" asks to be believed;
			    an inference id and a response hash can be checked. */}
			{ep.zg !== null && ep.zg.chatID !== null && (
				<p className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-8 font-mono text-[11px] text-muted-foreground">
					<span title="the 0G Compute inference this verdict came from">
						chat {ep.zg.chatID.slice(0, 18)}…
					</span>
					{ep.zg.model && <span>{ep.zg.model}</span>}
					{ep.zg.teeVerified === true && (
						<span
							className="text-success"
							title="the SDK checked the enclave's signature over this response"
						>
							sig ✓
						</span>
					)}
					{ep.teeTxHash && (
						<a
							className="underline"
							href={explorerTxFor("hedera", ep.teeTxHash)}
							target="_blank"
							rel="noreferrer"
							title="a Hedera contract ecrecovered this same signature"
						>
							ecrecover on Hedera
						</a>
					)}
				</p>
			)}
		</div>
	);
}

/** stake + everything earned — what actually lands back in the wallet. */
const totalOut = (slot: SlotSummary): number => slot.stakeOg + slot.creditsOg;

/** The grading window, counted down. Not SlotTimer: that badge is captioned
 * "your booked 30 minutes", which this is not. */
function SettlingNote({ claimableAt }: { claimableAt: number }) {
	const remaining = useCountdown(Math.round(claimableAt / 1000));
	return (
		<p className="flex items-center gap-1.5 text-muted-foreground text-sm">
			<Loader2 className="size-3 animate-spin" />
			settling — holding{" "}
			<span className="font-mono tabular-nums">
				{formatRemaining(remaining)}
			</span>{" "}
			open for any verdict still in flight
		</p>
	);
}

export function SlotPanel({
	info,
	maxStrikes,
	/** seconds after `endAt` before anyone but the hub may settle. From the
	 * contract via /slots; the fallback matches the deploy default. */
	gradeGraceSeconds = 150,
	/** false = every active task on this arm has hit its quota, so there is
	 * literally nothing left to record. */
	workLeft = true,
}: {
	info: RigSlotInfo;
	maxStrikes: number;
	gradeGraceSeconds?: number;
	workLeft?: boolean;
}) {
	const queryClient = useQueryClient();
	const [busy, setBusy] = useState(false);
	const slot = info.live;
	const ended = info.ended;
	const episodes = info.episodes ?? [];

	const doEndEarly = async () => {
		if (slot === null || slot.contract === null) return;
		setBusy(true);
		try {
			const hash = await endEarlySlot(slot.contract, slot.slotId, slot.chain);
			await noteSettled(info.rig, slot.slotId, hash, "end-early");
			toast.success("slot ended — settling your stake and earnings", {
				description: "verdicts already in flight still land and still pay",
			});
			void queryClient.invalidateQueries({ queryKey: ["market"] });
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "could not end the slot");
		} finally {
			setBusy(false);
		}
	};

	const doSettle = async () => {
		if (ended === null || ended.contract === null) return;
		setBusy(true);
		try {
			const hash = await settleSelf(ended.contract, ended.slotId, ended.chain);
			await noteSettled(info.rig, ended.slotId, hash, "settle");
			toast.success(
				"settled — your stake and earnings are back in your wallet",
			);
			void queryClient.invalidateQueries({ queryKey: ["market"] });
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "settle failed");
		} finally {
			setBusy(false);
		}
	};

	if (info.state === "voided")
		return (
			<Alert className="border-danger/50 text-danger [&>svg]:text-danger">
				<ShieldAlert />
				<AlertTitle>Slot ended — {maxStrikes} strikes</AlertTitle>
				<AlertDescription>
					Your stake was slashed and went back into the reward pool. Episodes
					you were paid for are unaffected — you keep those. Book another slot
					to keep driving.
				</AlertDescription>
			</Alert>
		);

	/**
	 * The slot is over and the money has not moved yet.
	 *
	 * The hub settles for you within seconds, so this is normally a blink. It
	 * matters when the hub is down — `settle` is permissionless once the grading
	 * window closes, so the stake is never hostage to our uptime. That is the
	 * part of the design worth being able to demonstrate rather than assert.
	 */
	if (slot === null && (ended !== null || info.you?.payout != null)) {
		// `you.payout` is the fallback for the window after settle, when the slot
		// has left the on-chain queue and is no longer in the rig DTO at all.
		const payout = ended?.payout ?? info.you?.payout ?? null;
		const claimableAt = ((ended?.endAt ?? 0) + gradeGraceSeconds) * 1000;
		const claimable = ended !== null && Date.now() >= claimableAt;
		return (
			<Card>
				<CardContent className="flex flex-col gap-3">
					<div className="flex flex-wrap items-center gap-3 text-sm">
						<StatusBadge tone="neutral">slot over</StatusBadge>
						{ended !== null && (
							<span className="text-muted-foreground">
								{ended.passes}/{ended.episodes} passed ·{" "}
								{payout?.settleTx ? "returned" : "returning"}{" "}
								<span className="font-mono text-foreground tabular-nums">
									{totalOut(ended).toFixed(3)}
								</span>{" "}
								({ended.stakeOg} stake + {ended.creditsOg.toFixed(3)} earned)
							</span>
						)}
					</div>

					{payout?.settleTx ? (
						<div className="flex flex-wrap items-center gap-2 text-sm">
							<Check className="size-4 text-success" />
							<span>
								Paid to your wallet
								{payout.by === "self" ? " — by you" : ""}.
							</span>
							<a
								className="inline-flex items-center gap-1 text-muted-foreground text-xs underline"
								href={explorerTxFor(payout.chainKey, payout.settleTx)}
								target="_blank"
								rel="noreferrer"
							>
								settle tx <ExternalLink className="size-3" />
							</a>
							{payout.withdrawTx && (
								<a
									className="inline-flex items-center gap-1 text-muted-foreground text-xs underline"
									href={explorerTxFor(payout.chainKey, payout.withdrawTx)}
									target="_blank"
									rel="noreferrer"
									title="the transfer failed on settle, so the amount was pushed separately"
								>
									withdraw tx <ExternalLink className="size-3" />
								</a>
							)}
						</div>
					) : claimable && ended !== null ? (
						<div className="flex flex-col gap-2">
							<Button
								size="sm"
								onClick={() => void doSettle()}
								disabled={busy || ended.contract === null}
							>
								<Wallet />
								{busy
									? "claiming…"
									: `Claim ${totalOut(ended).toFixed(3)} to my wallet`}
							</Button>
							<p className="text-muted-foreground text-xs">
								The hub normally does this for you. `settle` is permissionless
								once the grading window closes, so your money is never waiting
								on our uptime — anyone can move it, and it can only go to you.
							</p>
						</div>
					) : ended !== null ? (
						<SettlingNote claimableAt={claimableAt} />
					) : null}

					{episodes.length > 0 && (
						<div className="flex flex-col">
							{episodes.map((ep, i) => (
								<EpisodeRow key={ep.attemptId} ep={ep} index={i} />
							))}
						</div>
					)}
				</CardContent>
			</Card>
		);
	}

	if (slot === null) return null;

	const strikesLeft = maxStrikes - slot.strikes;

	return (
		<Card>
			<CardContent className="flex flex-col gap-3">
				<div className="flex flex-wrap items-center gap-3 text-sm">
					<SlotTimer endAt={slot.endAt} />
					<a
						className="font-mono text-muted-foreground text-xs underline"
						href={explorerAddressFor(slot.chain, slot.operator)}
						target="_blank"
						rel="noreferrer"
					>
						{shortAddress(slot.operator)}
					</a>
					<StatusBadge tone="info">
						{slot.stakeOg} {tokenFor(slot.chain)} staked
					</StatusBadge>
					<span className="text-muted-foreground">
						earned{" "}
						<span className="font-mono text-foreground tabular-nums">
							{slot.creditsOg.toFixed(3)} {tokenFor(slot.chain)}
						</span>
					</span>
					{slot.strikes > 0 && (
						<StatusBadge
							tone={slot.strikes >= maxStrikes - 1 ? "danger" : "warn"}
							title="a strike is an episode you claimed as a success that a TEE-attested referee failed"
						>
							⚠ {slot.strikes}/{maxStrikes}
						</StatusBadge>
					)}
					{/* Leaving early is not a forfeit: endEarly only pulls the deadline
					    forward, so the stake and every credit still settle normally and
					    a verdict already in flight still lands. Without this the only
					    way out was to idle out the clock. */}
					<Button
						size="sm"
						variant="ghost"
						className="ml-auto text-muted-foreground"
						onClick={() => void doEndEarly()}
						disabled={busy || slot.contract === null}
					>
						<Check />
						{busy ? "ending…" : "I'm finished — end my slot"}
					</Button>
				</div>

				{/* Nothing left to record, and the clock still running. Sitting it out
				    pays nothing and holds the arm away from the queue, so say so and
				    make leaving the obvious move — the stake and everything earned
				    come straight back. */}
				{!workLeft && (
					<Alert>
						<CheckCircle2 />
						<AlertTitle>Every task on this arm is done</AlertTitle>
						<AlertDescription className="flex flex-col items-start gap-2">
							<span>
								There is nothing left to record. End your slot now and{" "}
								{totalOut(slot).toFixed(3)} comes back to your wallet — waiting
								out the clock earns nothing and holds the arm from whoever is
								next.
							</span>
							<Button
								size="sm"
								onClick={() => void doEndEarly()}
								disabled={busy || slot.contract === null}
							>
								<Check />
								{busy ? "ending…" : "End my slot & get paid"}
							</Button>
						</AlertDescription>
					</Alert>
				)}

				{/* The pedagogy has to land BEFORE the third strike, not after it. */}
				{strikesLeft === 1 && (
					<Alert className="border-warn/50 text-warn [&>svg]:text-warn">
						<TriangleAlert />
						<AlertTitle>One more and the slot ends</AlertTitle>
						<AlertDescription>
							Another failed success claim slashes your whole {slot.stakeOg}{" "}
							{tokenFor(slot.chain)} stake. When an attempt doesn't work, press
							Discard — a discard is free and never counts against you.
						</AlertDescription>
					</Alert>
				)}

				{episodes.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						No episodes yet. Each one you record is graded on its own, and the
						verdict lands here about a minute later.
					</p>
				) : (
					<div className="flex flex-col">
						{episodes.map((ep, i) => (
							<EpisodeRow key={ep.attemptId} ep={ep} index={i} />
						))}
					</div>
				)}
			</CardContent>
		</Card>
	);
}
