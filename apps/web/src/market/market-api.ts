/**
 * Browser-side market API — mirrors the lib/hub-api.ts idiom (queryOptions +
 * plain fetch) without touching that file. Session rides the pm_session
 * cookie, so no headers are needed anywhere here.
 */
import { queryOptions } from "@tanstack/react-query";

export interface MarketBond {
	evmAddress: string;
	amountHbar: number;
	stakeTxHash: string;
	lockedAt: number;
}

export interface MarketStakeInfo {
	bondHbar: number;
	bonusHbar: number;
	chainId: number;
	faucet: string;
	escrowEvmAddress: string | null;
	/** the operator's currently posted stake, null until they stake */
	bond?: MarketBond | null;
	earnedHbar?: number;
}

export interface MarketSessionInfo {
	marketMode: boolean;
	verified: boolean;
	nullifier?: string;
	/** the wallet this human's World proof was signed against */
	boundAddress?: string | null;
	world?: {
		appId: string;
		action: string;
		preset: string;
		env: string;
		requirePresence?: boolean;
	} | null;
	stake?: MarketStakeInfo;
	lastAttempt?: {
		id: string;
		status: string;
		claimed: string | null;
		score: number | null;
		pass: boolean | null;
		gradeProvider: string | null;
		reason: string | null;
		payoutTx: string | null;
		teeTxHash: string | null;
	} | null;
}

export interface MarketLedgerRow {
	id: string;
	rig: string;
	taskId: string | null;
	taskTitle: string | null;
	source: string | null;
	operator: { nullifier: string | null; evmAddress: string | null };
	claimed: "success" | "discarded" | "abandoned" | null;
	telemetry: {
		durationS: number;
		jointTravelDeg: number;
		commandedMotion: number;
		inputPackets: number;
		gripperCycles: number;
		episodeSaved: boolean | null;
		samples: number;
		episode: {
			frames: number;
			durationS: number;
			jointPathDeg: number;
			maxJointRangeDeg: number;
			gripperCycles: number;
			stillFraction: number;
		} | null;
	};
	hasEvidence: boolean;
	grade: {
		score: number;
		pass: boolean;
		provider: string;
		reason: string;
		proof: Record<string, unknown> | null;
	} | null;
	payment: {
		kind: "bonus" | "none";
		txId: string | null;
		amountHbar: number;
	} | null;
	provenance: {
		hcsSeq: number | null;
		zgRoot: string | null;
		registryTx: string | null;
		teeTxHash: string | null;
	} | null;
	status: string;
	openedAt: number;
	closedAt: number | null;
}

export interface MarketStats {
	attempts: number;
	graded: number;
	passed: number;
	paidHbar: number;
	operators: number;
	bondsLocked: number;
	bonds: ReadonlyArray<{
		evmAddress: string;
		status: "locked" | "released" | "slashed";
		amountHbar: number;
		stakeTxHash: string;
		settleTxId: string | null;
	}>;
}

const get = async <T>(path: string): Promise<T> => {
	const res = await fetch(path);
	if (!res.ok) throw new Error(`market unreachable (${res.status})`);
	return res.json() as Promise<T>;
};

export const marketSessionQuery = queryOptions({
	queryKey: ["market", "session"],
	queryFn: () => get<MarketSessionInfo>("/api/market/session"),
	// grading and settlement take tens of seconds and the operator is
	// watching this line to find out what happened — poll rather than cache
	refetchInterval: 3_000,
});

export const marketLedgerQuery = queryOptions({
	queryKey: ["market", "ledger"],
	queryFn: () => get<ReadonlyArray<MarketLedgerRow>>("/api/market/ledger"),
	refetchInterval: 2_000,
});

/** Per task on one rig: episodes the referee passed, and how many it failed.
 * Null when the hub has no market layer, in which case the recorder's own
 * count is the only truth there is and the UI says nothing extra. */
export interface TaskProgress {
	tasks: Record<string, { passed: number; failed: number }>;
}

export const taskProgressQuery = (rig: string) =>
	queryOptions({
		queryKey: ["market", "progress", rig],
		queryFn: () =>
			get<TaskProgress>(
				`/api/market/progress?rig=${encodeURIComponent(rig)}`,
			).catch(() => ({ tasks: {} }) as TaskProgress),
		refetchInterval: 5_000,
	});

export const marketStatsQuery = queryOptions({
	queryKey: ["market", "stats"],
	queryFn: () => get<MarketStats>("/api/market/stats"),
	refetchInterval: 2_000,
});

const post = async <T>(
	path: string,
	body: Record<string, unknown>,
): Promise<T> => {
	const res = await fetch(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
	if (!res.ok) throw new Error(String(json.error ?? res.statusText));
	return json as T;
};

/** Forward an IDKit proof payload to the hub for cloud verification. */
export const verifyWorldProof = (payload: Record<string, unknown>) =>
	post<{
		verified: boolean;
		identityAttested: boolean | null;
		boundAddress: string | null;
	}>("/api/market/verify", payload);

/** Tell the hub about the stake transaction the operator just signed. The
 * hub verifies it against the mirror node — we only ever send a hash. */
export const postStake = (txHash: string) =>
	post<{ ok: true; evmAddress: string; amountHbar: number }>(
		"/api/market/stake",
		{ txHash },
	);

// --- slots ------------------------------------------------------------------

/** What paid, once something did. `by` distinguishes the hub settling for you
 * from you settling yourself — the second is the interesting one. */
export interface SlotPayout {
	chainKey: string;
	settleTx: string | null;
	withdrawTx: string | null;
	by: "hub" | "self";
	at: number;
}

export interface SlotSummary {
	/** which chain holds this slot's money */
	chain: string;
	/** the SlotMarket on that chain — enough to sign endEarly/cancel/settle */
	contract: `0x${string}` | null;
	slotId: number;
	operator: string;
	stakeOg: number;
	startedAt: number;
	endAt: number;
	remainingMs: number;
	episodes: number;
	passes: number;
	strikes: number;
	creditsOg: number;
	status: string;
	payout: SlotPayout | null;
}

export interface SlotEpisode {
	attemptId: string;
	episodeIndex: number | null;
	taskTitle: string | null;
	claimed: string | null;
	/** open | closed | graded | paid | rejected | anchored — the stage the row
	 * is at, which is what the panel narrates */
	status: string;
	/** the rig has read the recorded episode back off disk */
	measured: boolean;
	grade: {
		score: number;
		pass: boolean;
		provider: string;
		reason: string;
	} | null;
	/** the 0G inference this verdict came from, when there was one */
	zg: {
		chatID: string | null;
		model: string | null;
		teeVerified: boolean | null;
		responseHash: string | null;
	} | null;
	/** false = graded with no 0G signature, so it CANNOT have cost a strike */
	attested: boolean | null;
	slotTx: string | null;
	slotChain: string | null;
	teeTxHash: string | null;
	zgRoot: string | null;
	openedAt: number;
	closedAt: number | null;
}

export interface RigSlotInfo {
	rig: string;
	rigId: string;
	state: "free" | "awaiting-start" | "live" | "voided";
	live: SlotSummary | null;
	pending: SlotSummary | null;
	/** ran its full clock (or was ended early) and still holds money */
	ended: SlotSummary | null;
	queue: ReadonlyArray<{
		chain: string;
		slotId: number;
		operator: string;
		position: number;
		bookedAt: number;
		status: string;
	}>;
	stale: boolean;
	error: string | null;
	you?: {
		/** holds a token for the LIVE slot — what the drive gate keys off */
		hasToken: boolean;
		slotId: number | null;
		/** the slot this browser owns, running OR finished; null for a spectator */
		mine?: number | null;
		/** the payout receipt — outlives the slot leaving the on-chain queue */
		payout?: SlotPayout | null;
		/** deferred payout waiting in the contract, claimable by anyone */
		owedOg?: number;
	};
	episodes?: ReadonlyArray<SlotEpisode>;
}

export interface SlotChainInfo {
	key: string;
	chainId: number;
	label: string;
	token: string;
	contract: `0x${string}`;
	faucet: string;
	/** the contract reads 0G's registry itself, rather than a pinned constant */
	liveSigner: boolean;
	params: {
		slotSeconds: number;
		gradeGraceSeconds: number;
		noShowGraceSeconds: number;
		minStakeOg: number;
		rewardPerEpisodeOg: number;
		maxStrikes: number;
		rewardPoolOg: number;
		settler: string;
		zgSigner: string;
	} | null;
}

export interface SlotsConfig {
	configured: boolean;
	namespace: string;
	required: boolean;
	/** every chain the operator may put money on; same rules, different token */
	chains: ReadonlyArray<SlotChainInfo>;
	rigs: ReadonlyArray<RigSlotInfo>;
}

/** 501 when the hub has no slot contract — that is a normal answer, not an
 * error, so it resolves rather than throwing and the UI just hides slots. */
export const slotsQuery = queryOptions({
	queryKey: ["market", "slots"],
	queryFn: async (): Promise<SlotsConfig | null> => {
		const res = await fetch("/api/market/slots");
		if (res.status === 501) return null;
		if (!res.ok) throw new Error(`slots unreachable (${res.status})`);
		return res.json() as Promise<SlotsConfig>;
	},
	refetchInterval: 5_000,
});

export const rigSlotQuery = (rig: string) =>
	queryOptions({
		queryKey: ["market", "slots", rig],
		queryFn: async (): Promise<RigSlotInfo | null> => {
			const res = await fetch(`/api/market/slots/${encodeURIComponent(rig)}`);
			if (res.status === 501) return null;
			if (!res.ok) throw new Error(`slot unreachable (${res.status})`);
			return res.json() as Promise<RigSlotInfo>;
		},
		// the countdown is client-side; this poll only has to catch strikes,
		// verdicts landing and the slot ending
		refetchInterval: 3_000,
	});

export const unlockSlot = (rig: string, clientId: string) =>
	post<{
		ok: true;
		slotId: number;
		startedAt: number;
		endAt: number;
		remainingMs: number;
	}>(`/api/market/slots/${encodeURIComponent(rig)}/unlock`, { clientId });

/** Cache hint after a wallet booking, so the UI doesn't wait out a poll. */
export const noteBooked = (rig: string, txHash: string) =>
	post<RigSlotInfo>(`/api/market/slots/${encodeURIComponent(rig)}/booked`, {
		txHash,
	});

/**
 * Same, for the calls the operator makes with their own wallet.
 *
 * `kind` matters: only `settle` and `cancel` actually move money, so only they
 * leave a payout receipt. `end-early` just pulls the deadline forward — filing
 * its hash as the payout would point "paid to your wallet" at a transaction
 * that paid nobody, and would then block the real settle hash from landing.
 */
export const noteSettled = (
	rig: string,
	slotId: number,
	txHash: string,
	kind: "settle" | "cancel" | "end-early",
) =>
	post<RigSlotInfo>(`/api/market/slots/${encodeURIComponent(rig)}/settled`, {
		slotId,
		txHash,
		kind,
	});
