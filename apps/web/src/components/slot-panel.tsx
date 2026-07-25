import {
	ExternalLink,
	Loader2,
	ShieldAlert,
	TriangleAlert,
} from "lucide-react";
import { SlotTimer } from "#/components/slot-timer";
import { StatusBadge, type StatusTone } from "#/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { Card, CardContent } from "#/components/ui/card";
import { explorerAddress, explorerTx, shortAddress } from "#/market/chain";
import type { RigSlotInfo, SlotEpisode } from "#/market/market-api";

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

function EpisodeRow({ ep, index }: { ep: SlotEpisode; index: number }) {
	const grading = ep.grade === null && ep.status !== "open";
	return (
		<div className="flex flex-wrap items-center gap-2 border-b py-2 text-sm last:border-b-0">
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
			) : grading ? (
				<span className="flex items-center gap-1.5 text-muted-foreground">
					<Loader2 className="size-3 animate-spin" />
					<span className="text-xs">referee deliberating…</span>
				</span>
			) : (
				<>
					<StatusBadge tone={gradeTone(ep)} title={ep.grade?.reason}>
						{ep.grade?.pass ? "pass" : "fail"} {ep.grade?.score}
					</StatusBadge>
					{/* Why a failure did or didn't hurt: the operator's answer, not
					    decoration. Only an attested fail can take money. */}
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
				</>
			)}

			{ep.slotTx && (
				<a
					className="text-muted-foreground text-xs underline"
					href={explorerTx(ep.slotTx)}
					target="_blank"
					rel="noreferrer"
					title="the verdict, on 0G"
				>
					<ExternalLink className="inline size-3" />
				</a>
			)}
		</div>
	);
}

export function SlotPanel({
	info,
	maxStrikes,
}: {
	info: RigSlotInfo;
	maxStrikes: number;
}) {
	const slot = info.live;
	const episodes = info.episodes ?? [];

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

	if (slot === null) return null;

	const strikesLeft = maxStrikes - slot.strikes;

	return (
		<Card>
			<CardContent className="flex flex-col gap-3">
				<div className="flex flex-wrap items-center gap-3 text-sm">
					<SlotTimer endAt={slot.endAt} />
					<a
						className="font-mono text-muted-foreground text-xs underline"
						href={explorerAddress(slot.operator)}
						target="_blank"
						rel="noreferrer"
					>
						{shortAddress(slot.operator)}
					</a>
					<StatusBadge tone="info">{slot.stakeOg} OG staked</StatusBadge>
					<span className="text-muted-foreground">
						earned{" "}
						<span className="font-mono text-foreground tabular-nums">
							{slot.creditsOg.toFixed(3)} OG
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
				</div>

				{/* The pedagogy has to land BEFORE the third strike, not after it. */}
				{strikesLeft === 1 && (
					<Alert className="border-warn/50 text-warn [&>svg]:text-warn">
						<TriangleAlert />
						<AlertTitle>One more and the slot ends</AlertTitle>
						<AlertDescription>
							Another failed success claim slashes your whole {slot.stakeOg} OG
							stake. When an attempt doesn't work, press Discard — a discard is
							free and never counts against you.
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
