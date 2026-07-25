/**
 * Hedera settlement — testnet HBAR is the market's only money.
 *
 * Custody model (stated out loud in the demo): the hub is custodial for the
 * weekend. Every key is DERIVED — HMAC(MARKET_SECRET, nullifier) for
 * operators, HMAC(MARKET_SECRET, "escrow") for the escrow account — and
 * account ids are recovered from the mirror node by EVM-address alias, so
 * the hub keeps ZERO durable state and still survives redeploys.
 *
 * Money flow per session:
 *   bond   operator -> escrow    (locked at first attempt_start)
 *   bonus  treasury -> operator  (per 0G-passed episode — autonomous)
 *   release escrow -> operator   (walk away clean)
 *   slash  escrow  -> treasury   (claimed success, referee said no)
 * Every graded attempt also gets a <=1024-byte HCS digest — the one artifact
 * binding humanId + grade + payout + 0G evidence.
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
import { BONUS_HBAR, HEDERA, MARKET_SECRET } from "#/market/config";
import type { BondState, LedgerRow } from "#/market/store";
import { rehydratedStats } from "#/market/store";

const MIRROR = "https://testnet.mirrornode.hedera.com";

interface HederaState {
	client: Client;
	topicId: string | null;
	escrow: { accountId: string; key: PrivateKey } | null;
	/** nullifier -> account id (cache over the deterministic derivation) */
	accounts: Map<string, string>;
}

const g = globalThis as unknown as { __marketHedera?: HederaState };

/** The portal hands out DER ED25519 ("302e…") or hex ECDSA ("0x…") keys —
 * accept either without making the user care. */
const parseOperatorKey = (raw: string): PrivateKey => {
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
			parseOperatorKey(HEDERA.operatorKey),
		);
		g.__marketHedera = {
			client,
			topicId: HEDERA.topicId || null,
			escrow: null,
			accounts: new Map(),
		};
	}
	return g.__marketHedera;
};

/** Deterministic ECDSA key from the market secret + a label. */
const deriveKey = (label: string): PrivateKey => {
	const seed = createHmac("sha256", MARKET_SECRET).update(label).digest();
	return PrivateKey.fromBytesECDSA(seed);
};

/** Hashscan wants 0.0.x-sss-nnn, the SDK prints 0.0.x@sss.nnn. */
const txIdForLinks = (raw: string): string =>
	raw.replace("@", "-").replace(/\.(\d+)$/, "-$1");

/** Find an account by its EVM-address alias, or create it (1 HBAR seed —
 * NOT more: every creation draws down the portal account and the daily
 * refill only tops back up to 1000). */
const ensureAccount = async (
	label: string,
	initialHbar: number,
): Promise<{ accountId: string; key: PrivateKey }> => {
	const s = state();
	const key = deriveKey(label);
	const evm = key.publicKey.toEvmAddress();
	const found = await fetch(`${MIRROR}/api/v1/accounts/0x${evm}`)
		.then((r) => (r.ok ? r.json() : null))
		.catch(() => null);
	const existing = (found as { account?: string } | null)?.account;
	if (existing) return { accountId: existing, key };

	const receipt = await (
		await new AccountCreateTransaction()
			.setECDSAKeyWithAlias(key)
			.setInitialBalance(new Hbar(initialHbar))
			.execute(s.client)
	).getReceipt(s.client);
	const accountId = receipt.accountId?.toString();
	if (!accountId) throw new Error("account creation returned no id");
	console.error(
		`[market] created hedera account ${accountId} (${label.slice(0, 12)}…)`,
	);
	return { accountId, key };
};

export const ensureOperatorAccount = async (
	nullifier: string,
): Promise<{ accountId: string }> => {
	const s = state();
	const cached = s.accounts.get(nullifier);
	if (cached) return { accountId: cached };
	const { accountId } = await ensureAccount(nullifier, 1);
	s.accounts.set(nullifier, accountId);
	return { accountId };
};

const ensureEscrow = async (): Promise<{
	accountId: string;
	key: PrivateKey;
}> => {
	const s = state();
	if (s.escrow) return s.escrow;
	if (HEDERA.escrowId) {
		s.escrow = { accountId: HEDERA.escrowId, key: deriveKey("escrow") };
		return s.escrow;
	}
	s.escrow = await ensureAccount("escrow", 0);
	console.error(
		`[market] escrow account ${s.escrow.accountId} — set HEDERA_ESCROW_ID to pin it`,
	);
	return s.escrow;
};

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

/** operator -> escrow. The tx fee rides on the treasury (client operator);
 * the derived operator key co-signs the debit. */
export const submitBondLock = async (bond: BondState): Promise<string> => {
	const s = state();
	const { accountId } = await ensureOperatorAccount(bond.nullifier);
	const escrow = await ensureEscrow();
	const key = deriveKey(bond.nullifier);
	const tx = await (
		await new TransferTransaction()
			.addHbarTransfer(accountId, new Hbar(-bond.amountHbar))
			.addHbarTransfer(escrow.accountId, new Hbar(bond.amountHbar))
			.freezeWith(s.client)
			.sign(key)
	).execute(s.client);
	await tx.getReceipt(s.client);
	return txIdForLinks(tx.transactionId.toString());
};

/** treasury -> operator. Submitted by the worker on the referee's verdict —
 * the autonomous agentic payment the track asks for. */
export const submitBonus = async (row: LedgerRow): Promise<string> => {
	const s = state();
	if (!row.operator.nullifier) throw new Error("row has no nullifier");
	const { accountId } = await ensureOperatorAccount(row.operator.nullifier);
	row.operator.hederaAccountId = accountId;
	const tx = await new TransferTransaction()
		.addHbarTransfer(HEDERA.operatorId, new Hbar(-BONUS_HBAR))
		.addHbarTransfer(accountId, new Hbar(BONUS_HBAR))
		.execute(s.client);
	await tx.getReceipt(s.client);
	return txIdForLinks(tx.transactionId.toString());
};

export const settleBond = async (
	bond: BondState,
	outcome: "released" | "slashed",
): Promise<string> => {
	const s = state();
	const escrow = await ensureEscrow();
	const dest =
		outcome === "released"
			? (await ensureOperatorAccount(bond.nullifier)).accountId
			: HEDERA.operatorId;
	const tx = await (
		await new TransferTransaction()
			.addHbarTransfer(escrow.accountId, new Hbar(-bond.amountHbar))
			.addHbarTransfer(dest, new Hbar(bond.amountHbar))
			.freezeWith(s.client)
			.sign(escrow.key)
	).execute(s.client);
	await tx.getReceipt(s.client);
	return txIdForLinks(tx.transactionId.toString());
};

/** One digest per graded attempt. HARD protocol cap: 1024 bytes/message —
 * fields are truncated, never the other way. */
export const submitDigest = async (row: LedgerRow): Promise<number> => {
	const s = state();
	const topicId = await ensureTopic();
	const digest = {
		v: 1,
		a: row.id,
		rig: row.rig,
		task: row.taskId,
		n: row.operator.nullifier?.slice(0, 16) ?? null,
		acct: row.operator.hederaAccountId,
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
				if (d?.v !== 1) continue;
				attempts += 1;
				if (d.p === true) {
					passed += 1;
					if (d.tx) paid += BONUS_HBAR;
				}
				if (typeof d.n === "string") operators.add(d.n);
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
