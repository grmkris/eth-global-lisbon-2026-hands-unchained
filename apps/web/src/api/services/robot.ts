import { Context, Effect, Layer } from "effect";
import { DriverError, RobotState } from "#/api/contract";
import { RIG } from "#/api/rig";
import { DriverManager } from "./driver-manager";

export interface RobotShape {
	readonly state: () => Effect.Effect<RobotState>;
	readonly connect: (
		withLeader: boolean,
		backend: string,
	) => Effect.Effect<RobotState, DriverError>;
	/** Run a driver command, then return the fresh state snapshot. */
	readonly command: (
		cmd: string,
		extra?: Record<string, unknown>,
	) => Effect.Effect<RobotState, DriverError>;
	readonly input: (payload: {
		axes?: Record<string, number> | undefined;
		joints?: Record<string, number> | undefined;
	}) => Effect.Effect<{ ok: boolean }, DriverError>;
}

export class RobotSvc extends Context.Service<RobotSvc, RobotShape>()(
	"app/Robot",
) {
	static readonly layer = Layer.effect(
		RobotSvc,
		Effect.gen(function* () {
			const driver = yield* DriverManager;
			const toDriverError = (e: Error) =>
				new DriverError({ message: e.message });

			const state = () =>
				Effect.map(
					driver.robot(),
					(r) =>
						new RobotState({
							state: r.state,
							backend: r.backend,
							source: r.source,
							leader: r.leader,
							joints: r.joints,
							lastError: r.lastError,
							rig: {
								followerPort: RIG.followerPort,
								leaderPort: RIG.leaderPort,
								robotId: RIG.robotId,
							},
						}),
				);

			const command = (cmd: string, extra: Record<string, unknown> = {}) =>
				driver
					.rpc(cmd, extra)
					.pipe(Effect.mapError(toDriverError), Effect.andThen(state()));

			return {
				state,
				command,
				connect: (withLeader, backend) =>
					Effect.gen(function* () {
						yield* driver.rpc("connect", {
							backend,
							followerPort: RIG.followerPort,
							leaderPort: withLeader ? RIG.leaderPort : null,
							robotId: RIG.robotId,
						});
						yield* driver.setLeader(backend === "sim" ? true : withLeader);
						return yield* state();
					}).pipe(Effect.mapError(toDriverError)),
				input: (payload) =>
					driver
						.rpc("teleop_input", payload)
						.pipe(Effect.as({ ok: true }), Effect.mapError(toDriverError)),
			};
		}),
	);
}
