/**
 * 0G Compute grader — the Direct SDK path. The proof artifact persisted on
 * every grade ({chatID from the ZG-Res-Key header, provider, model,
 * teeVerified from processResponse, request/response hashes}) IS the track's
 * "proof inference runs on 0G Compute" evidence.
 *
 * Wording discipline: teeVerified means "TEE-attested signature over the
 * response checked out" — never claim "proof the model ran".
 *
 * Funding preconditions (booth tokens): ~3 OG for the ledger + 1 OG locked
 * per acknowledged provider. init() surfaces exactly what is missing.
 */
import { createHash } from "node:crypto";
import { createZGComputeNetworkBroker } from "@0gfoundation/0g-compute-ts-sdk";
import { ethers } from "ethers";
import { ZG } from "#/market/config";
import type { Grade } from "#/market/grader/index";
import { gradingPrompt, parseVerdict } from "#/market/grader/prompt";
import type { LedgerRow } from "#/market/store";

type Broker = Awaited<ReturnType<typeof createZGComputeNetworkBroker>>;

interface ZgState {
	broker: Broker;
	acknowledged: Set<string>;
}

const g = globalThis as unknown as { __marketZg?: Promise<ZgState> };

const sha256 = (s: string): string =>
	createHash("sha256").update(s).digest("hex");

const init = async (): Promise<ZgState> => {
	if (!ZG.privateKey) throw new Error("ZG_PRIVATE_KEY unset");
	if (!ZG.provider)
		throw new Error("ZG_PROVIDER unset (booth-blessed address)");
	const wallet = new ethers.Wallet(
		ZG.privateKey,
		new ethers.JsonRpcProvider(ZG.rpc),
	);
	const broker = await createZGComputeNetworkBroker(wallet);
	try {
		const ledger = await broker.ledger.getLedger();
		console.error(
			`[market] 0g ledger ok (${JSON.stringify(ledger.totalBalance ?? "?")})`,
		);
	} catch (getLedgerErr) {
		// getLedger also throws on transient RPC flakes; addLedger on an
		// existing ledger reverts. Whatever happened, what matters is whether
		// a ledger exists AFTERWARDS — recheck instead of parsing errors.
		console.error(
			`[market] 0g getLedger failed (${(getLedgerErr as Error)?.message?.slice(0, 120)}) — trying addLedger(3)…`,
		);
		try {
			await broker.ledger.addLedger(3);
		} catch (addErr) {
			console.error(
				`[market] 0g addLedger failed (${(addErr as Error)?.message?.slice(0, 120)}) — rechecking ledger…`,
			);
			await broker.ledger.getLedger(); // throws only if truly no ledger
			console.error("[market] 0g ledger exists after all — continuing");
		}
	}
	return { broker, acknowledged: new Set<string>() };
};

const ensureZg = (): Promise<ZgState> => {
	g.__marketZg ??= init().catch((e) => {
		g.__marketZg = undefined; // failed init must not be sticky
		throw e;
	});
	return g.__marketZg;
};

export const gradeZg = async (row: LedgerRow): Promise<Grade> => {
	const { broker, acknowledged } = await ensureZg();
	if (!acknowledged.has(ZG.provider)) {
		// idempotent server-side; locks 1 OG on first ack
		await broker.inference.acknowledgeProviderSigner(ZG.provider);
		acknowledged.add(ZG.provider);
	}

	const { endpoint, model } = await broker.inference.getServiceMetadata(
		ZG.provider,
	);
	const prompt = gradingPrompt(row);
	const headers = await broker.inference.getRequestHeaders(ZG.provider, prompt);
	const requestBody = JSON.stringify({
		model,
		messages: [{ role: "user", content: prompt }],
		temperature: 0,
	});
	const res = await fetch(`${endpoint}/chat/completions`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(headers as unknown as Record<string, string>),
		},
		body: requestBody,
	});
	const responseText = await res.text();
	if (!res.ok)
		throw new Error(`0g provider ${res.status}: ${responseText.slice(0, 300)}`);
	const completion = JSON.parse(responseText) as {
		id?: string;
		choices?: Array<{ message?: { content?: string } }>;
	};
	const content = completion.choices?.[0]?.message?.content ?? "";
	const chatID = res.headers.get("ZG-Res-Key") ?? completion.id ?? "";

	// TEE-attested signature check. boolean|null — null (no chatID) means
	// "unverified", which is a weaker artifact, not a failure.
	let teeVerified: boolean | null = null;
	try {
		teeVerified = await broker.inference.processResponse(
			ZG.provider,
			chatID || undefined,
			content,
		);
	} catch (e) {
		console.error(
			"[market] processResponse failed (continuing unverified):",
			e,
		);
	}

	const verdict = parseVerdict(content);
	return {
		...verdict,
		provider: "0g-compute",
		proof: {
			chatID,
			providerAddress: ZG.provider,
			model,
			teeVerified,
			requestHash: sha256(requestBody),
			responseHash: sha256(responseText),
			ts: Date.now(),
		},
	};
};
