/**
 * Hedera settlement — testnet HBAR is the market's only money.
 *
 * NON-CUSTODIAL: the operator stakes from their own MetaMask wallet and is
 * paid back to that same address. The hub holds exactly two keys — the
 * treasury (its own funds, pays bonuses) and the escrow (holds stakes in
 * flight) — and never touches an operator key, because there isn't one.
 *
 * Money flow per graded attempt:
 *   stake   operator's wallet -> escrow    (an EVM transfer THEY sign; we only verify it)
 *   pass    escrow + treasury -> operator  (one atomic tx: stake back + bonus)
 *   fail    escrow            -> treasury  (stake slashed after a false success claim)
 * Plus a <=1024-byte HCS digest per graded attempt — the artifact binding
 * the World nullifier, the 0G verdict and the Hedera payout.
 */
import { createHmac } from "node:crypto";
import {
	AccountCreateTransaction,
	AccountId,
	Client,
	Hbar,
	PrivateKey,
	TopicCreateTransaction,
	TopicMessageSubmitTransaction,
	TransferTransaction,
} from "@hashgraph/sdk";
import { BONUS_HBAR, HEDERA, HEDERA_EVM, MARKET_SECRET } from "#/market/config";
import type { BondState, LedgerRow } from "#/market/store";
import { rehydratedStats } from "#/market/store";

const MIRROR = HEDERA_EVM.mirror;

interface HederaState {
	client: Client;
	topicId: string | null;
	escrow: { accountId: string; key: PrivateKey } | null;
}

const g = globalThis as unknown as { __marketHedera?: HederaState };

/** The portal hands out DER ED25519 ("302e…") or hex ECDSA ("0x…") keys —
 * accept either without making the user care. */
const parseKey = (raw: string): PrivateKey => {
	const s = raw.trim();
	if (s.startsWith("0x")) return PrivateKey.fromStringECDSA(s);
	try {
		return PrivateKey.fromStringDer(s);
	} catch {
		return PrivateKey.fromStringECDSA(s);
	}
};

const state = (): HederaState => {
	if (!g.__marketHedera) {
		if (!HEDERA.configured) throw new Error("HEDERA_OPERATOR_ID/KEY unset");
		const client = Client.forTestnet().setOperator(
			AccountId.fromString(HEDERA.operatorId),
			parseKey(HEDERA.operatorKey),
		);
		g.__marketHedera = {
			client,
			topicId: HEDERA.topicId || null,
			escrow: null,
		};
	}
	return g.__marketHedera;
};

/** Hashscan wants 0.0.x-sss-nnn, the SDK prints 0.0.x@sss.nnn. */
const txIdForLinks = (raw: string): string =>
	raw.replace("@", "-").replace(/\.(\d+)$/, "-$1");

/** LEGACY: the escrow account was originally created with a key derived from
 * MARKET_SECRET. Prefer the explicit HEDERA_ESCROW_KEY; this exists so the
 * existing escrow account keeps working until that env var is set (run
 * scripts/smoke-stake.ts to print the value to pin). */
const legacyEscrowKey = (): PrivateKey =>
	PrivateKey.fromBytesECDSA(
		createHmac("sha256", MARKET_SECRET).update("escrow").digest(),
	);

export const escrowKey = (): PrivateKey =>
	HEDERA.escrowKey ? parseKey(HEDERA.escrowKey) : legacyEscrowKey();

export const ensureEscrow = async (): Promise<{
	accountId: string;
	key: PrivateKey;
	evmAddress: string;
}> => {
	const s = state();
	const key = escrowKey();
	const evmAddress = `0x${key.publicKey.toEvmAddress()}`;
	if (s.escrow)
		return { accountId: s.escrow.accountId, key: s.escrow.key, evmAddress };

	if (HEDERA.escrowId) {
		s.escrow = { accountId: HEDERA.escrowId, key };
		return { accountId: HEDERA.escrowId, key, evmAddress };
	}
	// look it up by alias before creating — the account may already exist
	const found = (await fetch(`${MIRROR}/api/v1/accounts/${evmAddress}`)
		.then((r) => (r.ok ? r.json() : null))
		.catch(() => null)) as { account?: string } | null;
	if (found?.account) {
		s.escrow = { accountId: found.account, key };
		return { accountId: found.account, key, evmAddress };
	}
	const receipt = await (
		await new AccountCreateTransaction()
			.setECDSAKeyWithAlias(key)
			.setInitialBalance(new Hbar(0))
			.execute(s.client)
	).getReceipt(s.client);
	const accountId = receipt.accountId?.toString();
	if (!accountId) throw new Error("escrow creation returned no id");
	s.escrow = { accountId, key };
	console.error(
		`[market] created escrow ${accountId} (${evmAddress}) — pin HEDERA_ESCROW_ID`,
	);
	return { accountId, key, evmAddress };
};

export const escrowEvmAddress = (): string =>
	`0x${escrowKey().publicKey.toEvmAddress()}`;

export const ensureTopic = async (): Promise<string> => {
	const s = state();
	if (s.topicId) return s.topicId;
	const receipt = await (
		await new TopicCreateTransaction()
			.setTopicMemo("proof-of-hands attempt provenance")
			.execute(s.client)
	).getReceipt(s.client);
	const topicId = receipt.topicId?.toString();
	if (!topicId) throw new Error("topic creation returned no id");
	s.topicId = topicId;
	console.error(
		`[market] created HCS topic ${topicId} — set HCS_TOPIC_ID to pin it`,
	);
	return topicId;
};

// --- the stake (operator -> escrow, signed by THEM) ------------------------

export interface StakeProof {
	from: string; // operator's EVM address, canonical
	amountHbar: number;
}

const TINYBAR = 100_000_000;

/**
 * Hedera reports a sender in one of two shapes: the account's real
 * keccak-derived alias (what the user sees in MetaMask), or a "long-zero"
 * address that is just the account number hex-padded. Both spend correctly,
 * but only the alias is recognisable to the person who staked — so resolve
 * through the mirror node and prefer the alias.
 */
const canonicalEvmAddress = async (address: string): Promise<string> => {
	const looksLongZero = /^0x0{24}/i.test(address);
	if (!looksLongZero) return address.toLowerCase();
	const acct = (await fetch(`${MIRROR}/api/v1/accounts/${address}`)
		.then((r) => (r.ok ? r.json() : null))
		.catch(() => null)) as { evm_address?: string } | null;
	const alias = acct?.evm_address;
	return alias && !/^0x0{24}/i.test(alias)
		? alias.toLowerCase()
		: address.toLowerCase();
};

/**
 * Confirm an EVM transaction really staked to our escrow. Two traps this
 * navigates: the mirror node lags MetaMask by ~3s (so "not found" is
 * PENDING, never failure), and for ETHEREUMTRANSACTION the transaction
 * payer is the RELAY's account — the sender must come from `.from`, never
 * from `transaction_id`.
 */
export const verifyStakeTx = async (
	txHash: string,
	minHbar: number,
): Promise<StakeProof> => {
	const escrow = await ensureEscrow();
	const want = escrow.evmAddress.toLowerCase();
	const deadline = Date.now() + 15_000;
	let lastError = "not found";

	while (Date.now() < deadline) {
		const res = await fetch(
			`${MIRROR}/api/v1/contracts/results/${encodeURIComponent(txHash)}`,
		).catch(() => null);
		if (res?.ok) {
			const body = (await res.json()) as {
				from?: string;
				to?: string;
				amount?: number;
				result?: string;
			};
			if (body.result && body.result !== "SUCCESS")
				throw new Error(`stake transaction failed on-chain: ${body.result}`);
			if ((body.to ?? "").toLowerCase() !== want)
				throw new Error("that transaction did not pay the escrow");
			// mirror reports tinybar; MetaMask spoke wei — never mix them
			const amountHbar = (body.amount ?? 0) / TINYBAR;
			if (amountHbar + 1e-9 < minHbar)
				throw new Error(`stake too small: ${amountHbar} ℏ, need ${minHbar} ℏ`);
			if (!body.from) throw new Error("stake transaction has no sender");
			return { from: await canonicalEvmAddress(body.from), amountHbar };
		}
		lastError = `mirror node ${res?.status ?? "unreachable"}`;
		await new Promise((r) => setTimeout(r, 1_500));
	}
	throw new Error(`stake not visible yet (${lastError}) — try again`);
};

// --- settlement (escrow/treasury -> the operator's own wallet) -------------

/**
 * PASS: one atomic multi-party transfer returning the stake AND paying the
 * bonus, so a single Hashscan link tells the whole story.
 * FAIL after claiming success: the stake moves to the treasury instead.
 * Targets the operator's EVM address directly — no account-id lookup needed
 * (HIP-583); `setMaxTransactionFee` is raised because the default 2 ℏ is too
 * low when the transfer also has to auto-create the destination.
 */
/** treasury -> the operator's own wallet. The per-episode micropayment;
 * the stake itself stays in escrow until they finish. */
export const payBonusTo = async (evmAddress: string): Promise<string> => {
	const s = state();
	const tx = await new TransferTransaction()
		.addHbarTransfer(HEDERA.operatorId, new Hbar(-BONUS_HBAR))
		.addHbarTransfer(
			AccountId.fromEvmAddress(0, 0, evmAddress),
			new Hbar(BONUS_HBAR),
		)
		.setMaxTransactionFee(new Hbar(5))
		.execute(s.client);
	await tx.getReceipt(s.client);
	return txIdForLinks(tx.transactionId.toString());
};

export const settleToOperator = async (
	bond: BondState,
	outcome: "released" | "slashed",
	opts: { bonus?: boolean } = {},
): Promise<string> => {
	const s = state();
	const escrow = await ensureEscrow();
	const tx = new TransferTransaction().setMaxTransactionFee(new Hbar(5));

	if (outcome === "slashed") {
		tx.addHbarTransfer(escrow.accountId, new Hbar(-bond.amountHbar));
		tx.addHbarTransfer(HEDERA.operatorId, new Hbar(bond.amountHbar));
	} else {
		if (!bond.evmAddress) throw new Error("bond has no operator address");
		// honest discard gets the stake back but no bonus — only graded work pays
		const bonus = opts.bonus === false ? 0 : BONUS_HBAR;
		const to = AccountId.fromEvmAddress(0, 0, bond.evmAddress);
		tx.addHbarTransfer(escrow.accountId, new Hbar(-bond.amountHbar));
		if (bonus > 0) tx.addHbarTransfer(HEDERA.operatorId, new Hbar(-bonus));
		tx.addHbarTransfer(to, new Hbar(bond.amountHbar + bonus));
	}

	const submitted = await (
		await tx.freezeWith(s.client).sign(escrow.key)
	).execute(s.client);
	await submitted.getReceipt(s.client);
	return txIdForLinks(submitted.transactionId.toString());
};

/** One digest per graded attempt. HARD protocol cap: 1024 bytes/message —
 * fields are truncated, never the other way. */
export const submitDigest = async (row: LedgerRow): Promise<number> => {
	const s = state();
	const topicId = await ensureTopic();
	const digest = {
		v: 2,
		a: row.id,
		rig: row.rig,
		task: row.taskId,
		n: row.operator.nullifier?.slice(0, 16) ?? null,
		w: row.operator.evmAddress ?? null,
		claimed: row.claimed,
		s: row.grade?.score ?? null,
		p: row.grade?.pass ?? null,
		gp: row.grade?.provider ?? null,
		tx: row.payment?.txId ?? null,
		zg: (row.grade?.proof?.chatID as string | undefined)?.slice(0, 24) ?? null,
		tee: (row.grade?.proof?.teeVerified as boolean | undefined) ?? null,
		root: row.provenance?.zgRoot?.slice(0, 24) ?? null,
	};
	const message = JSON.stringify(digest);
	if (Buffer.byteLength(message) > 1024)
		throw new Error(`digest over 1024 bytes: ${Buffer.byteLength(message)}`);
	const tx = await new TopicMessageSubmitTransaction()
		.setTopicId(topicId)
		.setMessage(message)
		.execute(s.client);
	const receipt = await tx.getReceipt(s.client);
	return receipt.topicSequenceNumber?.toNumber() ?? 0;
};

/** Boot: replay the topic from the mirror node so the dashboard's totals
 * survive redeploys (rows don't — they are cache, HCS is the ledger). */
export const rehydrateFromMirror = async (): Promise<void> => {
	if (!HEDERA.topicId) return; // fresh topic every boot -> nothing to replay
	const stats = rehydratedStats();
	let url = `${MIRROR}/api/v1/topics/${HEDERA.topicId}/messages?limit=100&order=asc`;
	let attempts = 0;
	let passed = 0;
	let paid = 0;
	const operators = new Set<string>();
	for (let page = 0; page < 50 && url; page++) {
		const res = await fetch(url);
		if (!res.ok) break;
		const body = (await res.json()) as {
			messages: Array<{ message: string }>;
			links?: { next: string | null };
		};
		for (const m of body.messages) {
			try {
				const d = JSON.parse(Buffer.from(m.message, "base64").toString("utf8"));
				if (d?.v !== 1 && d?.v !== 2) continue;
				attempts += 1;
				if (d.p === true) {
					passed += 1;
					if (d.tx) paid += BONUS_HBAR;
				}
				const who = d.w ?? d.n;
				if (typeof who === "string") operators.add(who);
			} catch {
				// foreign message on the topic — ignore
			}
		}
		url = body.links?.next ? `${MIRROR}${body.links.next}` : "";
	}
	stats.attempts = attempts;
	stats.passed = passed;
	stats.paidHbar = paid;
	stats.operators = operators;
	if (attempts > 0)
		console.error(
			`[market] rehydrated ${attempts} attempts (${passed} passed, ${paid} ℏ paid) from HCS`,
		);
};
