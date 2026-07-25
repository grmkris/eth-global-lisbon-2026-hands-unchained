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
import { SLOTS, ZG } from "#/market/config";
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
	__zgSlots?: ethers.Contract;
	__zgSlotParams?: SlotParams;
};

export const slotsConfigured = (): boolean => SLOTS.configured;

const contract = (): ethers.Contract | null => {
	if (!SLOTS.configured) return null;
	g.__zgSlots ??= new ethers.Contract(
		SLOTS.address,
		slotMarketAbi as unknown as ethers.InterfaceAbi,
		new ethers.Wallet(
			SLOTS.settlerKey,
			new ethers.JsonRpcProvider(ZG.rpc, undefined, { staticNetwork: true }),
		),
	);
	return g.__zgSlots;
};

export const rigId = (rigName: string): string =>
	rigIdOf(rigName, SLOTS.namespace);

const og = (wei: bigint): number => Number(ethers.formatEther(wei));

/** The raw tuple order is SlotMarket's `slots` public getter — keep in step. */
const toView = (slotId: number, raw: ethers.Result): SlotView => ({
	slotId,
	rigId: raw[0] as string,
	operator: raw[1] as string,
	stakeOg: og(raw[2] as bigint),
	pinHash: raw[3] as string,
	bookedAt: Number(raw[4]),
	startedAt: Number(raw[5]),
	endAt: Number(raw[6]),
	accruedOg: og(raw[7] as bigint),
	passes: Number(raw[8]),
	episodes: Number(raw[9]),
	strikes: Number(raw[10]),
	status: SLOT_STATUS[Number(raw[11])] ?? "none",
});

// --- reads ------------------------------------------------------------------

export const readSlot = async (slotId: number): Promise<SlotView | null> => {
	const c = contract();
	if (c === null || slotId === 0) return null;
	const raw = (await c.slots(slotId)) as ethers.Result;
	const view = toView(slotId, raw);
	return view.status === "none" ? null : view;
};

/** The slot at the head of this rig's queue — booked OR running. */
export const headSlot = async (rigName: string): Promise<SlotView | null> => {
	const c = contract();
	if (c === null) return null;
	const id = Number(await c.currentSlot(rigId(rigName)));
	return id === 0 ? null : readSlot(id);
};

export const queueFor = async (
	rigName: string,
	max = 8,
): Promise<SlotView[]> => {
	const c = contract();
	if (c === null) return [];
	const len = Number(await c.queueLength(rigId(rigName)));
	const ids = await Promise.all(
		Array.from({ length: Math.min(len, max) }, (_, i) =>
			c.queueAt(rigId(rigName), i),
		),
	);
	const slots = await Promise.all(ids.map((id) => readSlot(Number(id))));
	return slots.filter((s): s is SlotView => s !== null);
};

/** When the current head reached the front — the no-show clock, not bookedAt. */
export const headSince = async (rigName: string): Promise<number | null> => {
	const c = contract();
	if (c === null) return null;
	const raw = (await c.rigQueue(rigId(rigName))) as ethers.Result;
	return Number(raw[1]);
};

/** Immutables + the pool. Cached forever except the pool, which moves. */
export const slotParams = async (): Promise<SlotParams | null> => {
	const c = contract();
	if (c === null) return null;
	if (!g.__zgSlotParams) {
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
		g.__zgSlotParams = {
			slotSeconds: Number(dur),
			gradeGraceSeconds: Number(grade),
			noShowGraceSeconds: Number(noShow),
			minStakeOg: og(min as bigint),
			rewardPerEpisodeOg: og(reward as bigint),
			maxStrikes: Number(strikes),
			rewardPoolOg: 0,
			settler: settler as string,
			zgSigner: signer as string,
		};
	}
	const params = g.__zgSlotParams;
	params.rewardPoolOg = og((await c.rewardPool()) as bigint);
	return params;
};

export const owedOg = async (address: string): Promise<number> => {
	const c = contract();
	if (c === null) return 0;
	return og((await c.owed(address)) as bigint);
};

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
export const startSlot = async (slotId: number): Promise<string | null> => {
	const c = contract();
	if (c === null) return null;
	return send(`startSlot ${slotId}`, () => c.startSlot(slotId));
};

export const settleSlot = async (slotId: number): Promise<string | null> => {
	const c = contract();
	if (c === null) return null;
	return send(`settle ${slotId}`, () => c.settle(slotId));
};

/** No-op on chain when nothing is due, so it is safe to call on a timer. */
export const sweepRig = async (rigName: string): Promise<string | null> => {
	const c = contract();
	if (c === null) return null;
	return send(`sweep ${rigName}`, () => c.sweep(rigId(rigName)));
};

export const skipHead = async (rigName: string): Promise<string | null> => {
	const c = contract();
	if (c === null) return null;
	return send(`skipHead ${rigName}`, () => c.skipHead(rigId(rigName)));
};

/** Push a deferred payout so the operator never needs a wallet to be paid. */
export const withdrawFor = async (address: string): Promise<string | null> => {
	const c = contract();
	if (c === null) return null;
	if ((await owedOg(address)) === 0) return null;
	return send(`withdraw ${address}`, () => c.withdraw(address));
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
	row: LedgerRow,
	slotId: number,
): Promise<VerdictResult | null> => {
	const c = contract();
	if (c === null || row.grade === null) return null;

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
