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
	devAutoverify?: boolean;
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
	post<{ verified: boolean; identityAttested: boolean | null }>(
		"/api/market/verify",
		payload,
	);

/** Tell the hub about the stake transaction the operator just signed. The
 * hub verifies it against the mirror node — we only ever send a hash. */
export const postStake = (txHash: string) =>
	post<{ ok: true; evmAddress: string; amountHbar: number }>(
		"/api/market/stake",
		{ txHash },
	);

// --- slots ------------------------------------------------------------------

export interface SlotSummary {
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
}

export interface SlotEpisode {
	attemptId: string;
	episodeIndex: number | null;
	taskTitle: string | null;
	claimed: string | null;
	status: string;
	grade: {
		score: number;
		pass: boolean;
		provider: string;
		reason: string;
	} | null;
	/** false = graded with no 0G signature, so it CANNOT have cost a strike */
	attested: boolean | null;
	slotTx: string | null;
	openedAt: number;
	closedAt: number | null;
}

export interface RigSlotInfo {
	rig: string;
	rigId: string;
	state: "free" | "awaiting-start" | "live" | "voided";
	live: SlotSummary | null;
	pending: SlotSummary | null;
	queue: ReadonlyArray<{
		slotId: number;
		operator: string;
		position: number;
		bookedAt: number;
		status: string;
	}>;
	stale: boolean;
	error: string | null;
	you?: { hasToken: boolean; slotId: number | null };
	episodes?: ReadonlyArray<SlotEpisode>;
}

export interface SlotsConfig {
	configured: boolean;
	chainId: number;
	contract: `0x${string}`;
	namespace: string;
	required: boolean;
	faucet: string;
	minPinLength: number;
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

export const unlockSlot = (rig: string, pin: string, clientId: string) =>
	post<{
		ok: true;
		slotId: number;
		startedAt: number;
		endAt: number;
		remainingMs: number;
	}>(`/api/market/slots/${encodeURIComponent(rig)}/unlock`, { pin, clientId });

/** Cache hint after a wallet booking, so the UI doesn't wait out a poll. */
export const noteBooked = (rig: string, txHash: string) =>
	post<RigSlotInfo>(`/api/market/slots/${encodeURIComponent(rig)}/booked`, {
		txHash,
	});
