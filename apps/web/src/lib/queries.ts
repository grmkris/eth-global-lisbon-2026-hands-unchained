import { queryOptions } from "@tanstack/react-query";
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
