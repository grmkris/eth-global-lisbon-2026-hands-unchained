/**
 * 0G Router grader — OpenAI-compatible fallback (key from pc.testnet.0g.ai,
 * prepaid on-chain deposit, batched settlement). Weaker per-call artifact
 * than the Direct SDK (no TEE signature check on our side) — say so in the
 * demo rather than overclaiming.
 */
import { createHash } from "node:crypto";
import { ZG } from "#/market/config";
import type { Grade } from "#/market/grader/index";
import { gradingPrompt, parseVerdict } from "#/market/grader/prompt";
import type { LedgerRow } from "#/market/store";

const sha256 = (s: string): string =>
	createHash("sha256").update(s).digest("hex");

const pickModel = async (): Promise<string> => {
	if (ZG.routerModel) return ZG.routerModel;
	const res = await fetch(`${ZG.routerUrl}/models`, {
		headers: { authorization: `Bearer ${ZG.routerKey}` },
	});
	if (!res.ok) throw new Error(`router /models ${res.status}`);
	const body = (await res.json()) as { data?: Array<{ id: string }> };
	const id = body.data?.[0]?.id;
	if (!id) throw new Error("router lists no models — set ZG_ROUTER_MODEL");
	return id;
};

export const gradeZgRouter = async (row: LedgerRow): Promise<Grade> => {
	if (!ZG.routerKey) throw new Error("ZG_ROUTER_KEY unset");
	const model = await pickModel();
	const prompt = gradingPrompt(row);
	const requestBody = JSON.stringify({
		model,
		messages: [{ role: "user", content: prompt }],
		temperature: 0,
	});
	const res = await fetch(`${ZG.routerUrl}/chat/completions`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${ZG.routerKey}`,
		},
		body: requestBody,
	});
	const responseText = await res.text();
	if (!res.ok)
		throw new Error(`0g router ${res.status}: ${responseText.slice(0, 300)}`);
	const completion = JSON.parse(responseText) as {
		id?: string;
		choices?: Array<{ message?: { content?: string } }>;
	};
	const verdict = parseVerdict(completion.choices?.[0]?.message?.content ?? "");
	return {
		...verdict,
		provider: "0g-router",
		proof: {
			chatID: completion.id ?? "",
			model,
			routerUrl: ZG.routerUrl,
			teeVerified: null,
			requestHash: sha256(requestBody),
			responseHash: sha256(responseText),
			ts: Date.now(),
		},
	};
};
