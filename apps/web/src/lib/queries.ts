import { queryOptions } from "@tanstack/react-query";
import type { RunCreate, RunPatch } from "#/api/contract";
import { runApi } from "./api";

export const healthQuery = queryOptions({
	queryKey: ["health"],
	queryFn: () => runApi((client) => client.Health.status()),
	refetchInterval: 30_000,
});

export const datasetsQuery = queryOptions({
	queryKey: ["datasets"],
	queryFn: () => runApi((client) => client.Datasets.list()),
});

export const datasetEpisodesQuery = (repoId: string) =>
	queryOptions({
		queryKey: ["datasets", "episodes", repoId],
		queryFn: () =>
			runApi((client) => client.Datasets.episodes({ query: { repoId } })),
	});

export const runsQuery = queryOptions({
	queryKey: ["runs"],
	queryFn: () => runApi((client) => client.Trainings.list()),
});

export const runQuery = (id: string) =>
	queryOptions({
		queryKey: ["runs", id],
		queryFn: () => runApi((client) => client.Trainings.get({ params: { id } })),
	});

export const checkpointsQuery = (id: string) =>
	queryOptions({
		queryKey: ["runs", id, "checkpoints"],
		queryFn: () =>
			runApi((client) => client.Trainings.checkpoints({ params: { id } })),
		refetchInterval: 60_000,
	});

export const createRun = (payload: typeof RunCreate.Type) =>
	runApi((client) => client.Trainings.create({ payload }));

export const cameraStatusQuery = queryOptions({
	queryKey: ["cameras", "status"],
	queryFn: () => runApi((client) => client.Cameras.status()),
	refetchInterval: 2_000,
});

export const probeCameras = () => runApi((client) => client.Cameras.probe());

export const startPreview = (indexes: ReadonlyArray<number>) =>
	runApi((client) => client.Cameras.previewStart({ payload: { indexes } }));

export const stopPreview = () =>
	runApi((client) => client.Cameras.previewStop());

export const confirmCameras = (payload: {
	workspace: number | null;
	wrist: number | null;
}) => runApi((client) => client.Cameras.confirm({ payload }));

export const robotStateQuery = queryOptions({
	queryKey: ["robot", "state"],
	queryFn: () => runApi((client) => client.Robot.state()),
	refetchInterval: 1_000,
});

export const robotConnect = (
	withLeader: boolean,
	backend: "real" | "sim" = "real",
) =>
	runApi((client) =>
		client.Robot.connect({ payload: { withLeader, backend } }),
	);
export const robotDisconnect = () =>
	runApi((client) => client.Robot.disconnect());
export const robotTorque = (on: boolean) =>
	runApi((client) => client.Robot.torque({ payload: { on } }));
export const robotTeleopStart = (source: string | null = null) =>
	runApi((client) => client.Robot.teleopStart({ payload: { source } }));
export const robotTeleopStop = () =>
	runApi((client) => client.Robot.teleopStop());
export const robotTeleopInput = (axes: Record<string, number>) =>
	runApi((client) => client.Robot.teleopInput({ payload: { axes } }));
export const robotEstop = () => runApi((client) => client.Robot.estop());

export const recordStatusQuery = queryOptions({
	queryKey: ["record", "status"],
	queryFn: () => runApi((client) => client.Record.status()),
	refetchInterval: 1_000,
});

export const recordStart = (payload: {
	source: string | null;
	repoName: string;
	task: string;
	numEpisodes: number;
	episodeS: number;
	resetS: number;
	resume: boolean;
}) => runApi((client) => client.Record.start({ payload }));

export const recordControl = (action: "keep" | "rerecord" | "finish") =>
	runApi((client) => client.Record.control({ payload: { action } }));

export const patchRun = (id: string, payload: typeof RunPatch.Type) =>
	runApi((client) => client.Trainings.update({ params: { id }, payload }));
