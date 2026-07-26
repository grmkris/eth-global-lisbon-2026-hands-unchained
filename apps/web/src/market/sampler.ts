/**
 * Telemetry sampler — 5 Hz read-only reads of the hub's own rig state while a
 * ledger row is open. This is what makes grading possible without trusting
 * the operator: duration, motion, gripper activity and whether the rig
 * actually SAVED an episode all come from hub-observed state, not from the
 * operator's claim.
 *
 * Two hub realities shape this file (both verified against the sim rig):
 * - `rig.joints` FREEZES while the recorder owns the robot bus — and every
 *   attempt is a recording. So motion evidence comes primarily from the
 *   INPUT PLANE (`rig.input`: browser axes or a leader's joint targets),
 *   which the hub relays and which cannot freeze.
 * - The episode save lands ~1-2s AFTER attempt_finish, so sampling continues
 *   through a grace window after the row closes (worker delays grading).
 */
import { getRig } from "#/hub/store";
import type { LedgerRow } from "#/market/store";

const SAMPLE_MS = 200;

interface SamplerState {
	timer: ReturnType<typeof setInterval>;
	lastJoints: Record<string, number> | null;
	/** odometer readings at attempt start — everything is a delta from here */
	odoAtOpen: { packets: number; motion: number; gripperFlips: number } | null;
	jointGripper: {
		extreme: number | null;
		direction: 1 | -1 | 0;
		reversals: number;
	};
	savedAtOpen: number | null;
}

const g = globalThis as unknown as {
	__marketSamplers?: Map<string, SamplerState>;
};
g.__marketSamplers ??= new Map();
const samplers = g.__marketSamplers;

const GRIPPER_HYSTERESIS_DEG = 8;

export const startSampler = (row: LedgerRow): void => {
	stopSampler(row.id);
	const rig = getRig(row.rig);
	const state: SamplerState = {
		timer: setInterval(() => sample(row, state), SAMPLE_MS),
		lastJoints: null,
		odoAtOpen: rig
			? {
					packets: rig.inputOdo.packets,
					motion: rig.inputOdo.motion,
					gripperFlips: rig.inputOdo.gripperFlips,
				}
			: null,
		jointGripper: { extreme: null, direction: 0, reversals: 0 },
		savedAtOpen: rig?.record?.saved ?? null,
	};
	samplers.set(row.id, state);
};

export const stopSampler = (rowId: string): void => {
	const state = samplers.get(rowId);
	if (!state) return;
	clearInterval(state.timer);
	samplers.delete(rowId);
};

const sample = (row: LedgerRow, state: SamplerState): void => {
	// keep watching through "closed" (grace window: the episode save and the
	// final frame land after attempt_finish); anything later stops us
	if (row.status !== "open" && row.status !== "closed") {
		stopSampler(row.id);
		return;
	}
	const rig = getRig(row.rig);
	if (!rig) return;

	// the recorded episode's own numbers, once the rig has read them back
	const ep = rig.attempt?.lastEpisode;
	if (ep && row.telemetry.episode === null)
		row.telemetry.episode = {
			episodeIndex: ep.episodeIndex,
			frames: ep.frames,
			durationS: ep.durationS,
			jointPathDeg: ep.jointPathDeg,
			maxJointRangeDeg: ep.maxJointRangeDeg,
			gripperCycles: ep.gripperCycles,
			stillFraction: ep.stillFraction,
		};

	// episode saved: the recorder count moved past its value at open. Valid
	// during the grace window too — that is the window it moves in.
	// The recorder's `saved` counter is PER RECORD SESSION: recorder.py resets
	// it to 0 on every attempt and leaves it at 1 when the session ends. So
	// snapshotting it at attempt_start and waiting for growth works exactly
	// once — from the second attempt on, the baseline is a stale 1, the new
	// session counts 0->1, the delta never fires, and an honest operator is
	// told they saved nothing. Watch the counter RISE within this attempt
	// instead of comparing against whatever the last one left behind.
	const saved = rig.record?.saved;
	if (saved !== undefined && saved !== null) {
		// a fresh session starting (counter dropped) rebases us
		if (state.savedAtOpen === null || saved < state.savedAtOpen)
			state.savedAtOpen = saved;
		if (saved > state.savedAtOpen) row.telemetry.episodeSaved = true;
		else if (row.telemetry.episodeSaved !== true)
			row.telemetry.episodeSaved = false;
	}

	if (row.status !== "open") return; // grace window: only watch for the save

	row.telemetry.samples += 1;
	row.telemetry.durationS = (Date.now() - row.openedAt) / 1000;

	if (row.rigAttemptId === null && rig.attempt?.attemptId)
		row.rigAttemptId = rig.attempt.attemptId;
	if (row.taskTitle === null && rig.attempt?.taskTitle)
		row.taskTitle = rig.attempt.taskTitle;
	// the live source, captured while the attempt runs (record.source wins —
	// the recorder owns the arm during an attempt)
	row.source = rig.record?.source ?? rig.source ?? row.source;

	// --- motion evidence, from the hub's monotonic input odometer.
	// NOT from rig.input: that is a consume-once mailbox the /link tick nulls
	// every ~50ms, so polling it races the rig and mostly reads null — which
	// is exactly how an honest operator once got graded as a fraud.
	state.odoAtOpen ??= {
		packets: rig.inputOdo.packets,
		motion: rig.inputOdo.motion,
		gripperFlips: rig.inputOdo.gripperFlips,
	};
	row.telemetry.inputPackets = rig.inputOdo.packets - state.odoAtOpen.packets;
	row.telemetry.commandedMotion = rig.inputOdo.motion - state.odoAtOpen.motion;
	const flips = rig.inputOdo.gripperFlips - state.odoAtOpen.gripperFlips;

	// joints-based travel still accumulates for the windows where the driver
	// reports them live (pre/post record on some backends) — bonus, not load-
	// bearing
	const joints = rig.joints;
	if (state.lastJoints !== null)
		for (const [name, pos] of Object.entries(joints)) {
			const prev = state.lastJoints[name];
			if (prev !== undefined)
				row.telemetry.jointTravelDeg += Math.abs(pos - prev);
			if (name.toLowerCase().includes("gripper")) trackJointGripper(state, pos);
		}
	state.lastJoints = { ...joints };

	row.telemetry.gripperCycles = Math.max(
		flips > 0 ? Math.floor((flips + 1) / 2) : 0,
		state.jointGripper.reversals > 0
			? Math.floor((state.jointGripper.reversals + 1) / 2)
			: 0,
	);

	// evidence: keep the freshest workspace frame — a close-time-only snapshot
	// can miss (real-backend attempts freeze the cam feed while recording)
	const cam = pickCam(rig.frames, rig.camMapping);
	if (cam) {
		const frame = rig.frames.get(cam);
		if (frame) {
			row.evidence.frameJpeg = frame.data;
			row.evidence.cam = cam;
		}
	}
};

const trackJointGripper = (state: SamplerState, pos: number): void => {
	const jg = state.jointGripper;
	if (jg.extreme === null) {
		jg.extreme = pos;
		return;
	}
	const delta = pos - jg.extreme;
	if (Math.abs(delta) >= GRIPPER_HYSTERESIS_DEG) {
		const direction = delta > 0 ? 1 : -1;
		if (jg.direction !== 0 && direction !== jg.direction) jg.reversals += 1;
		jg.direction = direction;
		jg.extreme = pos;
	} else if (jg.direction === 1 ? pos > jg.extreme : pos < jg.extreme) {
		jg.extreme = pos;
	}
};

/** Which camera becomes the human-audit evidence image on /market.
 *
 * The name test only ever matches a SIM rig (`workspace_cam`); a real rig's
 * cameras are `cam0..camN`, so this used to fall through to the map's insertion
 * order — whichever camera pushed first after the rig registered, including a
 * Mac's built-in camera that has since stopped streaming. The rig already tells
 * us which index it calls the workspace, so ask that first, and make the last
 * resort the FRESHEST frame rather than the oldest-inserted one. */
const pickCam = (
	frames: Map<string, { data: Uint8Array; at: number }>,
	mapping: { workspace: number | null; wrist: number | null } | null,
): string | null => {
	if (frames.size === 0) return null;
	if (mapping?.workspace !== null && mapping?.workspace !== undefined) {
		const mapped = `cam${mapping.workspace}`;
		if (frames.has(mapped)) return mapped;
	}
	for (const name of frames.keys())
		if (name.toLowerCase().includes("workspace")) return name;
	let freshest: string | null = null;
	let at = -1;
	for (const [name, frame] of frames)
		if (frame.at > at) {
			at = frame.at;
			freshest = name;
		}
	return freshest;
};
