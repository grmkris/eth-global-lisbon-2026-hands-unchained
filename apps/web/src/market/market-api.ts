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
	} | null;
	stake?: MarketStakeInfo;
}

export interface MarketLedgerRow {
	id: string;
	rig: string;
	taskId: string | null;
	taskTitle: string | null;
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
	staleTime: 10_000,
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
