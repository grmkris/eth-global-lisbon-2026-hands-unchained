/**
 * The market ledger — in-memory like everything hub-side (pattern:
 * hub/store.ts globalThis stash, HMR-safe). Durable truth is the HCS topic:
 * the worker writes a digest per graded attempt and boot rehydrates stats
 * from the Mirror Node; rows here are a cache, and open rows dying on a
 * redeploy is accepted (attempts die with them).
 */

export type RowStatus =
	| "open" // attempt running, sampler live
	| "closed" // finished (or abandoned), waiting for the grader
	| "graded" // referee verdict in, waiting for settlement
	| "paid" // bonus paid (or fail settled/slashed), waiting for provenance
	| "rejected" // graded fail — settled, no payment
	| "anchored"; // HCS digest submitted (or skipped) — terminal

export interface LedgerRow {
	id: string;
	rig: string;
	taskId: string | null;
	taskTitle: string | null;
	/** the rig's own attempt id, captured from telemetry for cross-reference */
	rigAttemptId: string | null;
	operator: {
		clientId: string;
		nullifier: string | null;
		hederaAccountId: string | null;
	};
	/** what the OPERATOR said at finish; "abandoned" if the lease evaporated */
	claimed: "success" | "discarded" | "abandoned" | null;
	telemetry: {
		durationS: number;
		/** from rig.joints deltas — FREEZES while the recorder owns the bus,
		 * so this is bonus evidence, not load-bearing */
		jointTravelDeg: number;
		/** sum of |commanded input| across the attempt (browser axes or a
		 * leader's joint-target deltas) — the hub relays every packet, so this
		 * cannot freeze; the primary motion evidence */
		commandedMotion: number;
		inputPackets: number;
		gripperCycles: number;
		/** episodes saved by the rig during this attempt; null = recorder
		 * telemetry never appeared (unknown, NOT a proven non-save) */
		episodeSaved: boolean | null;
		samples: number;
	};
	evidence: { frameJpeg: Uint8Array | null; cam: string | null };
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
	status: RowStatus;
	openedAt: number;
	closedAt: number | null;
}

/** One bond per verified human per rig session — locked at first
 * attempt_start, released when they walk away clean, slashed on a false
 * success claim. */
export interface BondState {
	nullifier: string;
	rig: string;
	status: "locked" | "released" | "slashed";
	lockTxId: string | null;
	settleTxId: string | null;
	amountHbar: number;
	lockedAt: number;
	/** last time we saw this operator active on the rig (claim/attempt) */
	lastActiveAt: number;
}

/** Rehydrated-from-HCS aggregates survive redeploys even though rows do not. */
export interface RehydratedStats {
	attempts: number;
	passed: number;
	paidHbar: number;
	operators: Set<string>;
}

interface MarketState {
	rows: Map<string, LedgerRow>;
	/** rig name -> open row id (one live attempt per rig, hub-enforced) */
	openByRig: Map<string, string>;
	/** clientId -> nullifier, learned at gated claim time */
	clientNullifier: Map<string, { nullifier: string; at: number }>;
	/** `${nullifier}|${rig}` -> bond */
	bonds: Map<string, BondState>;
	rehydrated: RehydratedStats;
	seq: number;
}

const g = globalThis as unknown as { __marketState?: MarketState };
g.__marketState ??= {
	rows: new Map(),
	openByRig: new Map(),
	clientNullifier: new Map(),
	bonds: new Map(),
	rehydrated: { attempts: 0, passed: 0, paidHbar: 0, operators: new Set() },
	seq: 0,
};
const state = g.__marketState;

export const noteClient = (clientId: string, nullifier: string): void => {
	state.clientNullifier.set(clientId, { nullifier, at: Date.now() });
};

export const nullifierFor = (clientId: string): string | null =>
	state.clientNullifier.get(clientId)?.nullifier ?? null;

export const openRow = (input: {
	rig: string;
	taskId: string | null;
	clientId: string;
}): LedgerRow => {
	// a re-fired attempt_start while a row is open (task-panel auto-continue)
	// reuses the open row rather than orphaning it
	const existingId = state.openByRig.get(input.rig);
	if (existingId) {
		const existing = state.rows.get(existingId);
		if (existing && existing.status === "open") return existing;
	}
	state.seq += 1;
	const row: LedgerRow = {
		id: `att-${Date.now().toString(36)}-${state.seq}`,
		rig: input.rig,
		taskId: input.taskId,
		taskTitle: null,
		rigAttemptId: null,
		operator: {
			clientId: input.clientId,
			nullifier: nullifierFor(input.clientId),
			hederaAccountId: null,
		},
		claimed: null,
		telemetry: {
			durationS: 0,
			jointTravelDeg: 0,
			commandedMotion: 0,
			inputPackets: 0,
			gripperCycles: 0,
			episodeSaved: null,
			samples: 0,
		},
		evidence: { frameJpeg: null, cam: null },
		grade: null,
		payment: null,
		provenance: null,
		status: "open",
		openedAt: Date.now(),
		closedAt: null,
	};
	state.rows.set(row.id, row);
	state.openByRig.set(input.rig, row.id);
	return row;
};

export const openRowFor = (rig: string): LedgerRow | null => {
	const id = state.openByRig.get(rig);
	if (!id) return null;
	const row = state.rows.get(id);
	return row && row.status === "open" ? row : null;
};

export const closeRow = (
	rig: string,
	claimed: LedgerRow["claimed"],
): LedgerRow | null => {
	const row = openRowFor(rig);
	if (!row) return null;
	row.claimed = claimed;
	row.status = "closed";
	row.closedAt = Date.now();
	state.openByRig.delete(rig);
	return row;
};

export const listRows = (): ReadonlyArray<LedgerRow> =>
	[...state.rows.values()].sort((a, b) => b.openedAt - a.openedAt);

export const getRow = (id: string): LedgerRow | undefined => state.rows.get(id);

const bondKey = (nullifier: string, rig: string): string =>
	`${nullifier}|${rig}`;

export const getBond = (nullifier: string, rig: string): BondState | null =>
	state.bonds.get(bondKey(nullifier, rig)) ?? null;

export const putBond = (bond: BondState): void => {
	state.bonds.set(bondKey(bond.nullifier, bond.rig), bond);
};

export const listBonds = (): ReadonlyArray<BondState> => [
	...state.bonds.values(),
];

export const touchBond = (nullifier: string, rig: string): void => {
	const bond = state.bonds.get(bondKey(nullifier, rig));
	if (bond) bond.lastActiveAt = Date.now();
};

export const rehydratedStats = (): RehydratedStats => state.rehydrated;

export const marketStats = () => {
	const rows = [...state.rows.values()];
	const graded = rows.filter((r) => r.grade !== null);
	const passed = graded.filter((r) => r.grade?.pass === true);
	const paidHbar = rows.reduce(
		(sum, r) => sum + (r.payment?.txId ? r.payment.amountHbar : 0),
		0,
	);
	const operators = new Set(
		rows
			.map((r) => r.operator.nullifier)
			.filter((n): n is string => n !== null),
	);
	for (const op of state.rehydrated.operators) operators.add(op);
	return {
		attempts: rows.length + state.rehydrated.attempts,
		graded: graded.length,
		passed: passed.length + state.rehydrated.passed,
		paidHbar: paidHbar + state.rehydrated.paidHbar,
		operators: operators.size,
		bondsLocked: [...state.bonds.values()].filter((b) => b.status === "locked")
			.length,
	};
};
