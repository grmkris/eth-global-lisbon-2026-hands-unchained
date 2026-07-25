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
/** an input packet older than this is "no input right now" */
const INPUT_FRESH_MS = 600;

interface SamplerState {
	timer: ReturnType<typeof setInterval>;
	lastJoints: Record<string, number> | null;
	lastInputJoints: Record<string, number> | null;
	lastInputAt: number;
	gripperSign: 1 | -1 | 0;
	gripperFlips: number;
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
		lastInputJoints: null,
		lastInputAt: 0,
		gripperSign: 0,
		gripperFlips: 0,
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

	// episode saved: the recorder count moved past its value at open. Valid
	// during the grace window too — that is the window it moves in.
	const saved = rig.record?.saved;
	if (saved !== undefined && saved !== null) {
		if (state.savedAtOpen === null) state.savedAtOpen = saved;
		else if (saved > state.savedAtOpen) row.telemetry.episodeSaved = true;
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

	// --- motion evidence, input plane first (joints freeze while recording) —
	const input = rig.input;
	const inputFresh = input !== null && Date.now() - input.at < INPUT_FRESH_MS;
	if (inputFresh && input.at !== state.lastInputAt) {
		state.lastInputAt = input.at;
		row.telemetry.inputPackets += 1;
		if (input.axes) {
			// browser jog: commanded motion magnitude + gripper direction flips
			const { gripper = 0, ...axes } = input.axes;
			const magnitude = Object.values(axes).reduce(
				(sum, v) => sum + Math.abs(v),
				0,
			);
			row.telemetry.commandedMotion += magnitude;
			const sign = gripper > 0.2 ? 1 : gripper < -0.2 ? -1 : 0;
			if (sign !== 0) {
				row.telemetry.commandedMotion += Math.abs(gripper);
				if (state.gripperSign !== 0 && sign !== state.gripperSign)
					state.gripperFlips += 1;
				state.gripperSign = sign;
			}
		} else if (input.joints) {
			// a leader arm streams joint targets: travel between packets
			if (state.lastInputJoints !== null)
				for (const [name, pos] of Object.entries(input.joints)) {
					const prev = state.lastInputJoints[name];
					if (prev !== undefined) {
						const delta = Math.abs(pos - prev);
						row.telemetry.commandedMotion += delta / 10; // rough axis-units
						if (name.toLowerCase().includes("gripper"))
							trackJointGripper(state, pos);
					}
				}
			state.lastInputJoints = { ...input.joints };
		}
	}

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
		Math.floor((state.gripperFlips + 1) / 2),
		Math.floor((state.jointGripper.reversals + 1) / 2),
	);

	// evidence: keep the freshest workspace frame — a close-time-only snapshot
	// can miss (real-backend attempts freeze the cam feed while recording)
	const cam = pickCam(rig.frames);
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

const pickCam = (
	frames: Map<string, { data: Uint8Array; at: number }>,
): string | null => {
	if (frames.size === 0) return null;
	for (const name of frames.keys())
		if (name.toLowerCase().includes("workspace")) return name;
	return frames.keys().next().value ?? null;
};
