/**
 * The input plane, and ONLY the input plane.
 *
 * Everything else (telemetry, commands, verbs, leases, frames, leader
 * heartbeats) stays on the polled HTTP that this codebase deliberately
 * prefers. Input is the one hop where polling is felt: a leader agent posting
 * one packet at a time over keep-alive is RTT-bound (~15/s) and the rig then
 * waits up to a 50 ms link tick to pick it up. A socket makes it event-driven
 * in both directions — leader -> hub -> rig with no quantization.
 *
 * If a socket is missing at either end, input falls back to the HTTP mailbox
 * (`rig.input`, drained by the /link tick) — identical behavior, just slower.
 * A packet pushed over a socket never enters the mailbox, so a rig with both
 * transports up cannot get the same packet twice.
 *
 * Auth is the hub's usual `hubAuthorized` (checked in server.ts before the
 * upgrade). Authorization for input is the SAME rule as the HTTP path:
 * `leaderMayDrive` — bound to whoever holds the lease.
 */
import type { ServerWebSocket } from "bun";
import {
	getLeader,
	getRig,
	impair,
	isOnline,
	leaderMayDrive,
	noteInputOdometer,
	noteLeaderInput,
	shouldDrop,
} from "./store";

export interface WsData {
	role: "rig" | "leader";
	name: string;
}

type Sock = ServerWebSocket<WsData>;

// globalThis-stashed like the hub store, so Vite HMR can't double-init
const reg = globalThis as unknown as {
	__labWsRigs?: Map<string, Sock>;
	__labWsLeaders?: Map<string, Sock>;
};
reg.__labWsRigs ??= new Map<string, Sock>();
reg.__labWsLeaders ??= new Map<string, Sock>();
const rigSockets = reg.__labWsRigs;
const leaderSockets = reg.__labWsLeaders;

const socketsFor = (role: WsData["role"]) =>
	role === "rig" ? rigSockets : leaderSockets;

const open = (ws: Sock): void => {
	const { role, name } = ws.data;
	const sockets = socketsFor(role);
	const previous = sockets.get(name);
	sockets.set(name, ws);
	// a reconnect (agent restart, network flap) must not leave the old socket
	// registered — close it AFTER swapping so close() below is a no-op for it
	if (previous && previous !== ws) previous.close();
	console.error(`[hub-ws] ${role} ${name} connected`);
};

const close = (ws: Sock): void => {
	const { role, name } = ws.data;
	const sockets = socketsFor(role);
	if (sockets.get(name) === ws) {
		sockets.delete(name);
		console.error(`[hub-ws] ${role} ${name} disconnected`);
	}
};

const message = async (ws: Sock, raw: string | Buffer): Promise<void> => {
	if (ws.data.role !== "leader") return; // rigs only receive on this plane
	let packet: {
		t?: string;
		rig?: string;
		joints?: Record<string, number>;
		sentAt?: number;
	};
	try {
		packet = JSON.parse(typeof raw === "string" ? raw : raw.toString());
	} catch {
		return; // a malformed packet is a dropped packet, nothing more
	}
	if (packet.t !== "input" || !packet.rig || !packet.joints) return;
	const rig = getRig(packet.rig);
	const leader = getLeader(ws.data.name);
	if (!rig || !leader) return;
	// exactly the HTTP rule: bound to the current lease holder, no renewal
	if (!leaderMayDrive(leader, rig)) return;
	await impair();
	const dropped = shouldDrop();
	noteLeaderInput(rig, leader.name, "websocket", packet.joints, dropped);
	// URLSession reports a local WebSocket write as successful even if a
	// half-open connection never reaches this hub. Ack every authorized packet
	// so native leaders can detect that condition and use their HTTP fallback.
	ws.send(JSON.stringify({ t: "ack", forwarded: !dropped, at: Date.now() }));
	if (dropped) return;
	// Only trust the socket while the rig's own HTTP link says it is alive: a
	// half-open socket (network partition, the rig reconnected over a fresh TCP
	// connection) swallows sends silently, and input would vanish until Bun's
	// idle timeout. The mailbox is the safer landing spot in that window.
	const sock = isOnline(rig) ? rigSockets.get(rig.name) : undefined;
	// `at` gives the rig the same 500ms freshness gate the mailbox path has
	// (routes.ts): after a stall, a burst of buffered packets must not replay.
	// `sentAt` (leader clock) rides along for latency telemetry only — the
	// freshness gate stays on the hub-stamped `at`.
	if (sock)
		sock.send(
			JSON.stringify({
				t: "input",
				joints: packet.joints,
				at: Date.now(),
				sentAt: packet.sentAt,
			}),
		);
	else noteInputOdometer(rig, { joints: packet.joints });
	rig.input = {
		joints: packet.joints,
		at: Date.now(),
		sentAt: packet.sentAt,
	}; // mailbox
};

export const websocketHandlers = { open, close, message };
