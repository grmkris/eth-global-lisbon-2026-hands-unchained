import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as readline from "node:readline";
import { Context, Effect, Layer } from "effect";

// apps/web/src/api/services -> 4 hops up -> apps/ -> sibling driver package.
// LAB_DRIVER_DIR overrides for nonstandard layouts (and the built bundle,
// whose hop count differs — hub images never spawn the driver anyway).
const DRIVER_DIR =
	process.env.LAB_DRIVER_DIR ??
	new URL("../../../../driver", import.meta.url).pathname;
const VENV_PYTHON = `${DRIVER_DIR}/.venv/bin/python`;
const PYTHON =
	process.env.LAB_DRIVER_PYTHON ??
	(existsSync(VENV_PYTHON)
		? VENV_PYTHON
		: `${os.homedir()}/.local/share/uv/tools/lelab/bin/python`);
const DRIVER_SCRIPT = `${DRIVER_DIR}/driver.py`;

export interface RecordState {
	active: boolean;
	phase: string;
	episode: number;
	saved: number;
	total: number;
	repoId: string | null;
	source: string | null;
}

interface Pending {
	resolve: (value: unknown) => void;
	reject: (err: Error) => void;
}

/**
 * Plain supervisor around the Python driver process. Lives on globalThis so
 * Vite HMR reloads never orphan or double-spawn the process.
 */
class DriverProc {
	private proc: ChildProcess | null = null;
	private nextId = 1;
	private pending = new Map<number, Pending>();
	/** OS-assigned, reported back in `ready` — several rigs can share a machine. */
	mjpegPort = 0;
	brightness: Record<string, number> = {};
	streams: ReadonlyArray<string> = [];
	readonly joints: Record<string, number> = {};
	robotState = "disconnected";
	backendName = "real";
	sourceName: string | null = null;
	hasLeader = false;
	/** Driver `error` events used to be dropped on the floor — that is how a
	 * dead teleop loop stayed invisible. */
	lastError: string | null = null;
	recordState: RecordState = {
		active: false,
		phase: "idle",
		episode: 0,
		saved: 0,
		total: 0,
		repoId: null,
		source: null,
	};
	private readyPromise: Promise<void> | null = null;

	private start(): Promise<void> {
		if (this.readyPromise && this.proc && this.proc.exitCode === null)
			return this.readyPromise;
		const proc = spawn(PYTHON, [DRIVER_SCRIPT, "--mjpeg-port", "0"], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.proc = proc;
		proc.stderr?.on("data", (chunk: Buffer) =>
			console.error(chunk.toString().trimEnd()),
		);
		// Without this, a missing python binary is an uncaught ChildProcess
		// 'error' event — it kills the whole server, not just the request.
		proc.on("error", (err) => {
			console.error(`[driver-manager] driver spawn failed: ${String(err)}`);
			this.lastError = `driver spawn failed: ${String(err)}`;
			for (const p of this.pending.values())
				p.reject(new Error(`driver spawn failed: ${String(err)}`));
			this.pending.clear();
			this.proc = null;
			this.readyPromise = null;
			this.robotState = "disconnected";
		});
		proc.on("exit", (code) => {
			console.error(`[driver-manager] driver exited (${code})`);
			for (const p of this.pending.values())
				p.reject(new Error(`driver exited (${code})`));
			this.pending.clear();
			this.proc = null;
			this.readyPromise = null; // next rpc() respawns lazily
			this.robotState = "disconnected";
			this.backendName = "real";
			this.sourceName = null;
			this.hasLeader = false;
			this.brightness = {};
			this.streams = [];
		});

		this.readyPromise = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("driver did not become ready in 15s")),
				15_000,
			);
			const rl = readline.createInterface({
				input: proc.stdout as NodeJS.ReadableStream,
			});
			rl.on("line", (line) => {
				let msg: Record<string, unknown>;
				try {
					msg = JSON.parse(line);
				} catch {
					console.error(`[driver-manager] non-json stdout: ${line}`);
					return;
				}
				if (msg.event === "ready") {
					this.mjpegPort = Number(msg.mjpegPort) || 0;
					clearTimeout(timer);
					resolve();
				} else if (msg.event === "status") {
					this.brightness = msg.brightness as Record<string, number>;
					this.streams = msg.streams as ReadonlyArray<string>;
				} else if (msg.event === "joints") {
					Object.assign(this.joints, msg.values as Record<string, number>);
				} else if (msg.event === "error") {
					this.lastError = `${msg.where ?? "driver"}: ${msg.error}`;
					console.error(`[driver-manager] ${this.lastError}`);
				} else if (msg.event === "robot_state") {
					this.robotState = String(msg.state);
					if (msg.backend) this.backendName = String(msg.backend);
					this.sourceName = msg.source ? String(msg.source) : null;
				} else if (msg.event === "record_state") {
					const phase = String(msg.phase);
					this.recordState = {
						active: phase === "recording" || phase === "resetting",
						phase,
						episode: Number(msg.episode),
						saved: Number(msg.saved),
						total: Number(msg.total),
						repoId: String(msg.repoId),
						source: msg.source ? String(msg.source) : null,
					};
				} else if (typeof msg.id === "number") {
					const p = this.pending.get(msg.id);
					if (p) {
						this.pending.delete(msg.id);
						if (msg.ok) p.resolve(msg.result);
						else p.reject(new Error(String(msg.error)));
					}
				}
			});
		});
		return this.readyPromise;
	}

	async rpc<T>(cmd: string, extra: Record<string, unknown> = {}): Promise<T> {
		// A fault stays visible until the next connect attempt — sticky enough
		// to be read, but a clean reconnect must not keep showing a stale one.
		if (cmd === "connect") this.lastError = null;
		await this.start();
		const proc = this.proc;
		if (!proc?.stdin) throw new Error("driver not running");
		const id = this.nextId++;
		const result = new Promise<unknown>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			setTimeout(() => {
				if (this.pending.delete(id))
					reject(new Error(`driver rpc ${cmd} timed out (30s)`));
			}, 30_000);
		});
		proc.stdin.write(`${JSON.stringify({ id, cmd, ...extra })}\n`);
		return result as Promise<T>;
	}

	/** Frame URL base, or null until the driver has reported its port. */
	mjpegBase(): string | null {
		return this.mjpegPort ? `http://127.0.0.1:${this.mjpegPort}` : null;
	}

	kill(): void {
		this.proc?.kill();
		this.proc = null;
		this.readyPromise = null;
	}
}

const globalStore = globalThis as unknown as {
	__labDriverProc?: DriverProc;
	__labDriverExitHook?: boolean;
};
if (!globalStore.__labDriverProc) {
	globalStore.__labDriverProc = new DriverProc();
}
const driverProc = globalStore.__labDriverProc;

/** Where this process's driver serves frames (null before it is ready). */
export const mjpegBase = (): string | null => driverProc.mjpegBase();

if (!globalStore.__labDriverExitHook) {
	globalStore.__labDriverExitHook = true;
	for (const signal of ["exit", "SIGINT", "SIGTERM"] as const) {
		process.on(signal, () => {
			driverProc.kill();
			if (signal !== "exit") process.exit(0);
		});
	}
}

export interface DriverManagerShape {
	readonly rpc: <T>(
		cmd: string,
		extra?: Record<string, unknown>,
	) => Effect.Effect<T, Error>;
	readonly brightness: () => Effect.Effect<Record<string, number>>;
	readonly streams: () => Effect.Effect<ReadonlyArray<string>>;
	readonly robot: () => Effect.Effect<{
		state: string;
		backend: string;
		source: string | null;
		leader: boolean;
		joints: Record<string, number>;
		lastError: string | null;
	}>;
	readonly record: () => Effect.Effect<RecordState>;
	readonly setLeader: (leader: boolean) => Effect.Effect<void>;
}

export class DriverManager extends Context.Service<
	DriverManager,
	DriverManagerShape
>()("app/DriverManager") {
	static readonly layer = Layer.succeed(DriverManager)({
		rpc: <T>(cmd: string, extra: Record<string, unknown> = {}) =>
			Effect.tryPromise({
				try: () => driverProc.rpc<T>(cmd, extra),
				catch: (e) => (e instanceof Error ? e : new Error(String(e))),
			}),
		brightness: () => Effect.sync(() => ({ ...driverProc.brightness })),
		streams: () => Effect.sync(() => driverProc.streams),
		robot: () =>
			Effect.sync(() => ({
				state: driverProc.robotState,
				backend: driverProc.backendName,
				source: driverProc.sourceName,
				leader: driverProc.hasLeader,
				joints: { ...driverProc.joints },
				lastError: driverProc.lastError,
			})),
		record: () => Effect.sync(() => ({ ...driverProc.recordState })),
		setLeader: (leader: boolean) =>
			Effect.sync(() => {
				driverProc.hasLeader = leader;
			}),
	});
}
