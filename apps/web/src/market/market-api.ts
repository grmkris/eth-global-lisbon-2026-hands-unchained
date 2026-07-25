/**
 * Browser-side market API — mirrors the lib/hub-api.ts idiom (queryOptions +
 * plain fetch) without touching that file. Session rides the pm_session
 * cookie, so no headers are needed anywhere here.
 */
import { queryOptions } from "@tanstack/react-query";

export interface MarketSessionInfo {
	marketMode: boolean;
	verified: boolean;
	nullifier?: string;
	devAutoverify?: boolean;
	world?: { appId: string; action: string; preset: string } | null;
}

export interface MarketLedgerRow {
	id: string;
	rig: string;
	taskId: string | null;
	taskTitle: string | null;
	operator: { nullifier: string | null; hederaAccountId: string | null };
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
		nullifier: string;
		rig: string;
		status: "locked" | "released" | "slashed";
		amountHbar: number;
		lockTxId: string | null;
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

/** Forward an IDKit proof payload to the hub for cloud verification. */
export const verifyWorldProof = async (
	payload: Record<string, unknown>,
): Promise<{ verified: boolean; accountId: string | null }> => {
	const res = await fetch("/api/market/verify", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(payload),
	});
	const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
	if (!res.ok) throw new Error(String(body.error ?? res.statusText));
	return body as { verified: boolean; accountId: string | null };
};
