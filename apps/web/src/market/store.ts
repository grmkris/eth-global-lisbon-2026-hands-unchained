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
	/** how they drove: keys/phone/remote travel through the hub, so we can
	 * measure them; a rig-local leader arm or a scripted run never touches
	 * the network, so zero observed input is expected, not suspicious */
	source: string | null;
	operator: {
		clientId: string;
		nullifier: string | null;
		/** the operator's own wallet — where the payout lands */
		evmAddress: string | null;
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
		/** Hedera tx where a contract ecrecovered 0G's TEE signature */
		teeTxHash: string | null;
	} | null;
	status: RowStatus;
	openedAt: number;
	closedAt: number | null;
}

/** A stake the operator posted from their OWN wallet, covering one graded
 * attempt. Settles on the referee's verdict — returned with a bonus, or
 * slashed — after which they must stake again to attempt again. */
export interface BondState {
	nullifier: string;
	/** the wallet that actually paid; the payout goes back here */
	evmAddress: string;
	/** the operator's own EVM transaction — proof they staked, not us */
	stakeTxHash: string;
	status: "locked" | "released" | "slashed";
	settleTxId: string | null;
	amountHbar: number;
	lockedAt: number;
	/** last time this operator did anything — drives the idle refund */
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
	/** nullifier -> the ONE open stake (one stake covers one graded attempt) */
	bonds: Map<string, BondState>;
	/** stake tx hashes already consumed — a hash must not fund two bonds */
	usedStakes: Set<string>;
	/** nullifier -> lifetime HBAR earned (bonuses only, not refunds) */
	earnings: Map<string, number>;
	rehydrated: RehydratedStats;
	seq: number;
}

const g = globalThis as unknown as { __marketState?: MarketState };
g.__marketState ??= {
	rows: new Map(),
	openByRig: new Map(),
	clientNullifier: new Map(),
	bonds: new Map(),
	usedStakes: new Set(),
	earnings: new Map(),
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
	evmAddress?: string | null;
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
		source: null,
		operator: {
			clientId: input.clientId,
			nullifier: nullifierFor(input.clientId),
			evmAddress: input.evmAddress ?? null,
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

/** The operator's current open stake, if any. One stake covers one graded
 * attempt; settlement clears it and they must stake again. */
export const getBond = (nullifier: string): BondState | null => {
	const bond = state.bonds.get(nullifier);
	return bond && bond.status === "locked" ? bond : null;
};

export const putBond = (bond: BondState): void => {
	state.bonds.set(bond.nullifier, bond);
	state.usedStakes.add(bond.stakeTxHash.toLowerCase());
};

/** A stake transaction may fund exactly one bond — otherwise one payment
 * could be replayed into unlimited attempts. */
export const stakeAlreadyUsed = (txHash: string): boolean =>
	state.usedStakes.has(txHash.toLowerCase());

export const listBonds = (): ReadonlyArray<BondState> => [
	...state.bonds.values(),
];

export const addEarnings = (nullifier: string, hbar: number): void => {
	state.earnings.set(nullifier, (state.earnings.get(nullifier) ?? 0) + hbar);
};

export const earningsFor = (nullifier: string): number =>
	state.earnings.get(nullifier) ?? 0;

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
			.map((r) => r.operator.evmAddress ?? r.operator.nullifier)
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
