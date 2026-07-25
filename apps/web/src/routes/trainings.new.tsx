import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { ErrorNote } from "#/components/error-note";
import { PageHeader } from "#/components/page-header";
import { Button } from "#/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "#/components/ui/field";
import { Input } from "#/components/ui/input";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select";
import { Spinner } from "#/components/ui/spinner";
import { createRun, datasetsQuery } from "#/lib/queries";

type NewTrainingSearch = { dataset?: string; episodes?: string };

export const Route = createFileRoute("/trainings/new")({
	component: NewTrainingPage,
	validateSearch: (search: Record<string, unknown>): NewTrainingSearch => ({
		dataset: typeof search.dataset === "string" ? search.dataset : undefined,
		episodes: typeof search.episodes === "string" ? search.episodes : undefined,
	}),
});

const toInt = (value: string, fallback: number) => {
	const n = Number.parseInt(value, 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
};

function NewTrainingPage() {
	const { dataset, episodes: episodesPrefill } = Route.useSearch();
	const datasets = useQuery(datasetsQuery);
	const navigate = useNavigate();
	const queryClient = useQueryClient();

	const [name, setName] = useState("");
	const [datasetRepoId, setDatasetRepoId] = useState(dataset ?? "");
	const [episodes, setEpisodes] = useState(episodesPrefill ?? "");
	const [pretrainedPath, setPretrainedPath] = useState("");
	const [steps, setSteps] = useState(40000);
	const [batchSize, setBatchSize] = useState(16);
	const [saveFreq, setSaveFreq] = useState(5000);
	const [hypothesis, setHypothesis] = useState("");

	const create = useMutation({
		mutationFn: () =>
			createRun({
				name,
				datasetRepoId,
				episodes: episodes.trim() === "" ? null : episodes.trim(),
				pretrainedPath:
					pretrainedPath.trim() === "" ? null : pretrainedPath.trim(),
				steps,
				batchSize,
				saveFreq,
				hypothesis: hypothesis.trim() === "" ? null : hypothesis.trim(),
			}),
		onSuccess: (run) => {
			queryClient.invalidateQueries({ queryKey: ["runs"] });
			toast.success(`run ${run.name} registered`);
			navigate({ to: "/trainings/$runId", params: { runId: run.id } });
		},
	});

	return (
		<div className="max-w-xl">
			<PageHeader
				title="New training"
				description="Generates a version-matched Colab cell (lerobot v0.6.0, checkpoints pushed to Hub)"
				back={{ to: "/trainings", label: "Trainings" }}
			/>

			<FieldGroup>
				<Field>
					<FieldLabel htmlFor="nt-dataset">Dataset</FieldLabel>
					<Select value={datasetRepoId} onValueChange={setDatasetRepoId}>
						<SelectTrigger id="nt-dataset" className="w-full">
							<SelectValue placeholder="select…" />
						</SelectTrigger>
						<SelectContent>
							<SelectGroup>
								{(datasets.data ?? [])
									.filter((d) => d.onHub)
									.map((d) => (
										<SelectItem key={d.repoId} value={d.repoId}>
											{d.repoId}{" "}
											{d.totalEpisodes ? `(${d.totalEpisodes} eps)` : ""}
										</SelectItem>
									))}
							</SelectGroup>
						</SelectContent>
					</Select>
				</Field>

				<Field>
					<FieldLabel htmlFor="nt-name">Model name (kris0/…)</FieldLabel>
					<Input
						id="nt-name"
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder="act_wall_v4"
					/>
				</Field>

				<Field>
					<FieldLabel htmlFor="nt-hypothesis">
						Hypothesis (what will this run prove?)
					</FieldLabel>
					<Input
						id="nt-hypothesis"
						value={hypothesis}
						onChange={(e) => setHypothesis(e.target.value)}
						placeholder="40k steps closes the ±45° gap at edges"
					/>
				</Field>

				<Field>
					<FieldLabel htmlFor="nt-episodes">
						Episodes include-list (optional, e.g. [0,1,…,56])
					</FieldLabel>
					<Input
						id="nt-episodes"
						value={episodes}
						onChange={(e) => setEpisodes(e.target.value)}
						placeholder="leave empty for all episodes"
					/>
				</Field>

				<Field>
					<FieldLabel htmlFor="nt-pretrained">
						Continue from checkpoint (optional pretrained path)
					</FieldLabel>
					<Input
						id="nt-pretrained"
						value={pretrainedPath}
						onChange={(e) => setPretrainedPath(e.target.value)}
						placeholder="leave empty to train from scratch (default at our scale)"
					/>
				</Field>

				<div className="grid grid-cols-3 gap-4">
					<Field>
						<FieldLabel htmlFor="nt-steps">Steps</FieldLabel>
						<Input
							id="nt-steps"
							type="number"
							min={1}
							step={1000}
							value={steps}
							onChange={(e) => setSteps(toInt(e.target.value, 40000))}
						/>
					</Field>
					<Field>
						<FieldLabel htmlFor="nt-batch">Batch</FieldLabel>
						<Input
							id="nt-batch"
							type="number"
							min={1}
							value={batchSize}
							onChange={(e) => setBatchSize(toInt(e.target.value, 16))}
						/>
					</Field>
					<Field>
						<FieldLabel htmlFor="nt-savefreq">Save every</FieldLabel>
						<Input
							id="nt-savefreq"
							type="number"
							min={1}
							step={1000}
							value={saveFreq}
							onChange={(e) => setSaveFreq(toInt(e.target.value, 5000))}
						/>
					</Field>
				</div>
			</FieldGroup>

			<Button
				className="mt-6"
				disabled={!name || !datasetRepoId || create.isPending}
				onClick={() => create.mutate()}
			>
				{create.isPending && <Spinner />}
				{create.isPending ? "creating…" : "Create run"}
			</Button>
			{create.isError && (
				<div className="mt-3">
					<ErrorNote error={create.error} />
				</div>
			)}
		</div>
	);
}
