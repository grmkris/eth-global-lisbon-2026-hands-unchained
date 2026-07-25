import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Layer, Path } from "effect";
import {
	Etag,
	FetchHttpClient,
	HttpPlatform,
	HttpRouter,
} from "effect/unstable/http";
import { HttpApiBuilder, HttpApiScalar } from "effect/unstable/httpapi";
import { Checkpoints, HealthStatus, LabApi } from "./contract";
import { RIG } from "./rig";
import { Cameras } from "./services/cameras";
import { DatasetCatalog } from "./services/dataset-catalog";
import { DriverManager } from "./services/driver-manager";
import { HfHub } from "./services/hf-hub";
import { Recorder } from "./services/record";
import { RobotSvc } from "./services/robot";
import { RunsRegistry } from "./services/runs-registry";

const HealthLive = HttpApiBuilder.group(LabApi, "Health", (handlers) =>
	handlers.handle("status", () =>
		Effect.succeed(
			new HealthStatus({ ok: true, hfUser: RIG.hfUser, version: "0.1.0" }),
		),
	),
);

const DatasetsLive = HttpApiBuilder.group(LabApi, "Datasets", (handlers) =>
	handlers
		.handle("list", () =>
			Effect.flatMap(DatasetCatalog, (catalog) => catalog.list()),
		)
		.handle("episodes", ({ query }) =>
			Effect.flatMap(DatasetCatalog, (catalog) =>
				catalog.episodes(query.repoId),
			),
		),
);

const TrainingsLive = HttpApiBuilder.group(LabApi, "Trainings", (handlers) =>
	handlers
		.handle("list", () => Effect.flatMap(RunsRegistry, (r) => r.list()))
		.handle("get", ({ params }) =>
			Effect.flatMap(RunsRegistry, (r) => r.get(params.id)).pipe(Effect.orDie),
		)
		.handle("create", ({ payload }) =>
			Effect.flatMap(RunsRegistry, (r) => r.create(payload)),
		)
		.handle("update", ({ params, payload }) =>
			Effect.flatMap(RunsRegistry, (r) => r.update(params.id, payload)).pipe(
				Effect.orDie,
			),
		)
		.handle("checkpoints", ({ params }) =>
			Effect.flatMap(RunsRegistry, (r) => r.checkpoints(params.id)).pipe(
				Effect.map((c) => new Checkpoints(c)),
				Effect.orDie,
			),
		),
);

const CamerasLive = HttpApiBuilder.group(LabApi, "Cameras", (handlers) =>
	handlers
		.handle("probe", () =>
			Effect.flatMap(Cameras, (c) => c.probe()).pipe(Effect.orDie),
		)
		.handle("previewStart", ({ payload }) =>
			Effect.flatMap(Cameras, (c) => c.previewStart(payload.indexes)).pipe(
				Effect.orDie,
			),
		)
		.handle("previewStop", () =>
			Effect.flatMap(Cameras, (c) => c.previewStop()).pipe(Effect.orDie),
		)
		.handle("status", () => Effect.flatMap(Cameras, (c) => c.status()))
		.handle("confirm", ({ payload }) =>
			Effect.flatMap(Cameras, (c) => c.confirm(payload)),
		),
);

const RobotLive = HttpApiBuilder.group(LabApi, "Robot", (handlers) =>
	handlers
		.handle("state", () => Effect.flatMap(RobotSvc, (r) => r.state()))
		.handle("connect", ({ payload }) =>
			Effect.flatMap(RobotSvc, (r) =>
				r.connect(payload.withLeader, payload.backend),
			),
		)
		.handle("disconnect", () =>
			Effect.flatMap(RobotSvc, (r) => r.command("disconnect")),
		)
		.handle("torque", ({ payload }) =>
			Effect.flatMap(RobotSvc, (r) => r.command("torque", { on: payload.on })),
		)
		.handle("teleopStart", ({ payload }) =>
			Effect.flatMap(RobotSvc, (r) =>
				r.command("teleop_start", { source: payload.source }),
			),
		)
		.handle("teleopStop", () =>
			Effect.flatMap(RobotSvc, (r) => r.command("teleop_stop")),
		)
		.handle("teleopInput", ({ payload }) =>
			Effect.flatMap(RobotSvc, (r) => r.input(payload)),
		)
		.handle("estop", () => Effect.flatMap(RobotSvc, (r) => r.command("estop"))),
);

const RecordLive = HttpApiBuilder.group(LabApi, "Record", (handlers) =>
	handlers
		.handle("status", () => Effect.flatMap(Recorder, (r) => r.status()))
		.handle("start", ({ payload }) =>
			Effect.flatMap(Recorder, (r) => r.start(payload)),
		)
		.handle("control", ({ payload }) =>
			Effect.flatMap(Recorder, (r) => r.control(payload.action)),
		),
);

const ServicesLayer = Layer.mergeAll(
	RunsRegistry.layer,
	Recorder.layer,
	RobotSvc.layer,
).pipe(
	Layer.provideMerge(Layer.mergeAll(DatasetCatalog.layer, Cameras.layer)),
	Layer.provideMerge(HfHub.layer),
	Layer.provideMerge(DriverManager.layer),
	Layer.provideMerge(FetchHttpClient.layer),
	Layer.provideMerge(NodeFileSystem.layer),
);

const GroupsLayer = Layer.mergeAll(
	HealthLive,
	DatasetsLive,
	TrainingsLive,
	CamerasLive,
	RobotLive,
	RecordLive,
);

const PlatformLayer = Layer.mergeAll(
	Path.layer,
	Etag.layerWeak,
	HttpPlatform.layer,
).pipe(Layer.provideMerge(NodeFileSystem.layer));

const AppLayer = Layer.mergeAll(
	HttpApiBuilder.layer(LabApi, { openapiPath: "/api/openapi.json" }).pipe(
		Layer.provide(GroupsLayer),
	),
	HttpApiScalar.layer(LabApi, { path: "/api/docs" }),
).pipe(Layer.provideMerge(ServicesLayer), Layer.provideMerge(PlatformLayer));

// Vite HMR must not rebuild the layer (and later: respawn the Python driver) on
// every reload — stash the handler on globalThis in dev.
const globalStore = globalThis as unknown as {
	__labApiHandler?: (request: Request) => Promise<Response>;
};

if (!globalStore.__labApiHandler) {
	globalStore.__labApiHandler = HttpRouter.toWebHandler(AppLayer).handler;
}
export const apiHandler: (request: Request) => Promise<Response> =
	globalStore.__labApiHandler;
