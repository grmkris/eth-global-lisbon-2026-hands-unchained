/**
 * The SlotMarket client — every read and every settler write, in one place.
 *
 * Shape borrowed wholesale from market/tee-bridge.ts: a lazily built
 * ethers.Contract cached on globalThis, and every entry point degrading to
 * `null` rather than throwing when the market is unconfigured. So a hub with no
 * ZG_SLOT_MARKET_ADDRESS behaves exactly as it did before slots existed, and no
 * call site needs a guard.
 *
 * The settler key signs `startSlot` (relaying a verified PIN unlock so the
 * operator gets no second wallet popup) and every verdict. It cannot forge a
 * verdict — the contract checks 0G's enclave signature itself — and it cannot
 * profit from voiding anyone, because a slashed stake goes to the reward pool
 * rather than the treasury. What it CAN do is withhold, which is a liveness
 * assumption and not a custody one: `settle`, `cancel`, `skipHead` and
 * `withdraw` all work without it.
 */
import { ethers } from "ethers";
import { slotMarketAbi } from "#/market/abi/slot-market";
import { rigIdOf } from "#/market/chain";
import { SLOTS, type SlotChain } from "#/market/config";
import type { LedgerRow } from "#/market/store";
import { attestationParts } from "#/market/tee-bridge";

/** Mirrors SlotMarket.Status. Index IS the on-chain value — do not reorder. */
export const SLOT_STATUS = [
	"none",
	"booked",
	"running",
	"settled",
	"voided",
	"skipped",
	"cancelled",
] as const;

export type SlotStatus = (typeof SLOT_STATUS)[number];

export interface SlotView {
	/** which chain holds this slot's money — "0g" | "hedera" */
	chainKey: string;
	slotId: number;
	rigId: string;
	operator: string;
	/** OG, not wei — nothing above this layer should have to know */
	stakeOg: number;
	pinHash: string;
	bookedAt: number;
	/** 0 until the PIN unlock relays startSlot; this is when the clock starts */
	startedAt: number;
	endAt: number;
	accruedOg: number;
	passes: number;
	episodes: number;
	strikes: number;
	status: SlotStatus;
}

export interface SlotParams {
	slotSeconds: number;
	gradeGraceSeconds: number;
	noShowGraceSeconds: number;
	minStakeOg: number;
	rewardPerEpisodeOg: number;
	maxStrikes: number;
	rewardPoolOg: number;
	settler: string;
	zgSigner: string;
}

const g = globalThis as unknown as {
	__zgSlots?: Map<string, ethers.Contract>;
	__zgSlotParams?: Map<string, SlotParams>;
};
g.__zgSlots ??= new Map();
g.__zgSlotParams ??= new Map();

export const slotsConfigured = (): boolean => SLOTS.configured;

const contract = (chain: SlotChain): ethers.Contract => {
	const cached = g.__zgSlots?.get(chain.key);
	if (cached) return cached;
	const made = new ethers.Contract(
		chain.address,
		slotMarketAbi as unknown as ethers.InterfaceAbi,
		new ethers.Wallet(
			chain.settlerKey,
			new ethers.JsonRpcProvider(chain.rpc, undefined, { staticNetwork: true }),
		),
	);
	g.__zgSlots?.set(chain.key, made);
	return made;
};

export const rigId = (rigName: string): string =>
	rigIdOf(rigName, SLOTS.namespace);

/**
 * Contract amount -> human number. The decimals are PER CHAIN: 0G is a normal
 * 1e18 EVM, Hedera's speaks tinybar at 1e8. Using formatEther on a Hedera
 * value silently divides by ten billion too much.
 */
const amount = (raw: bigint, chain: SlotChain): number =>
	Number(ethers.formatUnits(raw, chain.valueDecimals));

/** The raw tuple order is SlotMarket's `slots` public getter — keep in step. */
const toView = (
	slotId: number,
	raw: ethers.Result,
	chain: SlotChain,
): SlotView => ({
	chainKey: chain.key,
	slotId,
	rigId: raw[0] as string,
	operator: raw[1] as string,
	stakeOg: amount(raw[2] as bigint, chain),
	pinHash: raw[3] as string,
	bookedAt: Number(raw[4]),
	startedAt: Number(raw[5]),
	endAt: Number(raw[6]),
	accruedOg: amount(raw[7] as bigint, chain),
	passes: Number(raw[8]),
	episodes: Number(raw[9]),
	strikes: Number(raw[10]),
	status: SLOT_STATUS[Number(raw[11])] ?? "none",
});

// --- reads ------------------------------------------------------------------

export const readSlot = async (
	chain: SlotChain,
	slotId: number,
): Promise<SlotView | null> => {
	if (slotId === 0) return null;
	const raw = (await contract(chain).slots(slotId)) as ethers.Result;
	const view = toView(slotId, raw, chain);
	return view.status === "none" ? null : view;
};

/** The slot at the head of this rig's queue — booked OR running. */
export const headSlot = async (
	chain: SlotChain,
	rigName: string,
): Promise<SlotView | null> => {
	const id = Number(await contract(chain).currentSlot(rigId(rigName)));
	return id === 0 ? null : readSlot(chain, id);
};

export const queueFor = async (
	chain: SlotChain,
	rigName: string,
	max = 8,
): Promise<SlotView[]> => {
	const c = contract(chain);
	const len = Number(await c.queueLength(rigId(rigName)));
	const ids = await Promise.all(
		Array.from({ length: Math.min(len, max) }, (_, i) =>
			c.queueAt(rigId(rigName), i),
		),
	);
	const slots = await Promise.all(ids.map((id) => readSlot(chain, Number(id))));
	return slots.filter((s): s is SlotView => s !== null);
};

/** When the current head reached the front — the no-show clock, not bookedAt. */
export const headSince = async (
	chain: SlotChain,
	rigName: string,
): Promise<number | null> => {
	const raw = (await contract(chain).rigQueue(rigId(rigName))) as ethers.Result;
	return Number(raw[1]);
};

/** Immutables + the pool. Cached forever except the pool, which moves. */
export const slotParams = async (
	chain: SlotChain,
): Promise<SlotParams | null> => {
	const c = contract(chain);
	if (!g.__zgSlotParams?.has(chain.key)) {
		const [dur, grade, noShow, min, reward, strikes, settler, signer] =
			await Promise.all([
				c.slotDuration(),
				c.gradeGrace(),
				c.noShowGrace(),
				c.minStake(),
				c.rewardPerEpisode(),
				c.MAX_STRIKES(),
				c.settler(),
				c.zgSigner(),
			]);
		g.__zgSlotParams?.set(chain.key, {
			slotSeconds: Number(dur),
			gradeGraceSeconds: Number(grade),
			noShowGraceSeconds: Number(noShow),
			minStakeOg: amount(min as bigint, chain),
			rewardPerEpisodeOg: amount(reward as bigint, chain),
			maxStrikes: Number(strikes),
			rewardPoolOg: 0,
			settler: settler as string,
			zgSigner: signer as string,
		});
	}
	const params = g.__zgSlotParams?.get(chain.key);
	if (!params) return null;
	params.rewardPoolOg = amount((await c.rewardPool()) as bigint, chain);
	return params;
};

export const owedOg = async (
	chain: SlotChain,
	address: string,
): Promise<number> =>
	amount((await contract(chain).owed(address)) as bigint, chain);

// --- settler writes ---------------------------------------------------------

/** Every write funnels through here so one outage story covers all of them. */
const send = async (
	label: string,
	fn: () => Promise<ethers.ContractTransactionResponse>,
): Promise<string | null> => {
	if (!SLOTS.configured) return null;
	try {
		const tx = await fn();
		await tx.wait();
		console.error(`[slots] ${label}: ${tx.hash}`);
		return tx.hash;
	} catch (e) {
		console.error(`[slots] ${label} failed:`, e);
		return null;
	}
};

/**
 * THE CLOCK STARTS HERE. Relayed by the hub the moment a PIN unlock verifies,
 * so the operator signs exactly one transaction in the whole flow (the booking).
 * Reverts `slot not bookable` if it already started, which the unlock handler
 * treats as success — that is the redeploy-recovery path.
 */
export const startSlot = async (
	chain: SlotChain,
	slotId: number,
): Promise<string | null> =>
	send(`startSlot ${slotId} on ${chain.key}`, () =>
		contract(chain).startSlot(slotId),
	);

export const settleSlot = async (
	chain: SlotChain,
	slotId: number,
): Promise<string | null> =>
	send(`settle ${slotId} on ${chain.key}`, () =>
		contract(chain).settle(slotId),
	);

/** No-op on chain when nothing is due, so it is safe to call on a timer. */
export const sweepRig = async (
	chain: SlotChain,
	rigName: string,
): Promise<string | null> =>
	send(`sweep ${rigName} on ${chain.key}`, () =>
		contract(chain).sweep(rigId(rigName)),
	);

export const skipHead = async (
	chain: SlotChain,
	rigName: string,
): Promise<string | null> =>
	send(`skipHead ${rigName} on ${chain.key}`, () =>
		contract(chain).skipHead(rigId(rigName)),
	);

/** Push a deferred payout so the operator never needs a wallet to be paid. */
export const withdrawFor = async (
	chain: SlotChain,
	address: string,
): Promise<string | null> => {
	if ((await owedOg(chain, address)) === 0) return null;
	return send(`withdraw ${address} on ${chain.key}`, () =>
		contract(chain).withdraw(address),
	);
};

export interface VerdictResult {
	txHash: string;
	attested: boolean;
}

/**
 * One graded episode onto the slot.
 *
 * `attestationParts` returns null for every grader except 0G Compute —
 * precheck, local, local(episode) and the local fallback all carry no proof,
 * and grade() degrades to local on any 0G error BY DESIGN. That is why the
 * contract has two entry points, and why an unattested verdict can pay but can
 * never strike: without the enclave's signature the hub may be lenient, never
 * punitive.
 */
export const recordEpisodeOnSlot = async (
	chain: SlotChain,
	row: LedgerRow,
	slotId: number,
): Promise<VerdictResult | null> => {
	if (row.grade === null) return null;
	const c = contract(chain);

	const episodeId = ethers.id(row.id);
	const score = Math.max(0, Math.min(65535, Math.round(row.grade.score)));
	const pass = row.grade.pass;
	const claimedSuccess = row.claimed === "success";
	const storageRoot = row.provenance?.zgRoot?.startsWith("0x")
		? row.provenance.zgRoot
		: ethers.ZeroHash;

	const parts = attestationParts(row);
	if (parts === null) {
		const txHash = await send(`verdict(unattested) ${row.id}`, () =>
			c.recordEpisodeUnattested(
				slotId,
				episodeId,
				score,
				pass,
				claimedSuccess,
				storageRoot,
			),
		);
		return txHash === null ? null : { txHash, attested: false };
	}

	// Free dry run first: a bad signature reverts `not signed by 0G TEE`, and
	// there is no reason to pay gas to discover that.
	const responseBytes = ethers.toUtf8Bytes(parts.responseBody);
	const ok = (await c
		.verifyAttestation(
			parts.requestHashHex,
			responseBytes,
			parts.tlsFingerprintHex,
			parts.signature,
		)
		.catch(() => false)) as boolean;
	if (!ok) {
		console.error(
			`[slots] attestation for ${row.id} does not verify — recording unattested`,
		);
		const txHash = await send(`verdict(unverifiable) ${row.id}`, () =>
			c.recordEpisodeUnattested(
				slotId,
				episodeId,
				score,
				pass,
				claimedSuccess,
				storageRoot,
			),
		);
		return txHash === null ? null : { txHash, attested: false };
	}

	const txHash = await send(`verdict ${row.id}`, () =>
		c.recordEpisode(
			slotId,
			episodeId,
			score,
			pass,
			claimedSuccess,
			storageRoot,
			parts.requestHashHex,
			responseBytes,
			parts.tlsFingerprintHex,
			parts.signature,
			{ gasLimit: 1_500_000 },
		),
	);
	return txHash === null ? null : { txHash, attested: true };
};
