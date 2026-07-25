import * as crypto from "node:crypto";
import { Context, Effect, FileSystem, Layer } from "effect";
import {
	RunConfig,
	type RunCreate,
	RunInfo,
	type RunPatch,
} from "#/api/contract";
import { RIG } from "#/api/rig";
import { HfHub } from "./hf-hub";

const DATA_DIR = `${process.cwd()}/.data`;
const RUNS_FILE = `${DATA_DIR}/runs.json`;

/** Version-matched Colab cell, crib-sheet convention (lerobot v0.6.0). */
const colabCell = (run: {
	name: string;
	hubModelId: string;
	config: {
		datasetRepoId: string;
		episodes: string | null;
		pretrainedPath: string | null;
		steps: number;
		batchSize: number;
		saveFreq: number;
	};
}): string => {
	const c = run.config;
	const lines = [
		"!git clone https://github.com/huggingface/lerobot.git",
		"%cd lerobot",
		"!git checkout v0.6.0",
		'!pip install -e ".[dataset,training]"',
		"!pip uninstall -y hf_xet",
		"from huggingface_hub import notebook_login; notebook_login()  # REQUIRED or push 401s",
		`!lerobot-train --dataset.repo_id=${c.datasetRepoId} \\`,
	];
	if (c.episodes) lines.push(`  --dataset.episodes="${c.episodes}" \\`);
	lines.push(
		"  --dataset.image_transforms.enable=true --policy.type=act --policy.device=cuda \\",
	);
	if (c.pretrainedPath)
		lines.push(`  --policy.pretrained_path=${c.pretrainedPath} \\`);
	lines.push(
		`  --output_dir=outputs/train/${run.name} --job_name=${run.name} \\`,
		`  --batch_size=${c.batchSize} --steps=${c.steps} --save_freq=${c.saveFreq} \\`,
		"  --save_checkpoint_to_hub=true \\",
		`  --policy.push_to_hub=true --policy.repo_id=${run.hubModelId} --wandb.enable=true`,
	);
	return lines.join("\n");
};

export interface RunsRegistryShape {
	readonly list: () => Effect.Effect<ReadonlyArray<RunInfo>>;
	readonly get: (id: string) => Effect.Effect<RunInfo, Error>;
	readonly create: (input: RunCreate) => Effect.Effect<RunInfo>;
	readonly update: (
		id: string,
		patch: RunPatch,
	) => Effect.Effect<RunInfo, Error>;
	readonly checkpoints: (
		id: string,
	) => Effect.Effect<
		{ hubModelId: string; steps: ReadonlyArray<string> },
		Error
	>;
}

export class RunsRegistry extends Context.Service<
	RunsRegistry,
	RunsRegistryShape
>()("app/RunsRegistry") {
	static readonly layer = Layer.effect(
		RunsRegistry,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const hub = yield* HfHub;

			const reviveRun = (raw: RunInfo): RunInfo =>
				new RunInfo({
					...raw,
					config: raw.config ? new RunConfig(raw.config) : null,
				});

			const loadSidecar = fs.readFileString(RUNS_FILE).pipe(
				Effect.map((raw) => (JSON.parse(raw) as Array<RunInfo>).map(reviveRun)),
				Effect.orElseSucceed(() => [] as Array<RunInfo>),
			);

			const saveSidecar = (runs: ReadonlyArray<RunInfo>) =>
				fs
					.makeDirectory(DATA_DIR, { recursive: true })
					.pipe(
						Effect.andThen(
							fs.writeFileString(RUNS_FILE, JSON.stringify(runs, null, 2)),
						),
						Effect.orDie,
					);

			const merged = Effect.gen(function* () {
				const [sidecar, models] = yield* Effect.all(
					[loadSidecar, hub.listModels()],
					{
						concurrency: 2,
					},
				);
				const known = new Set(sidecar.map((r) => r.hubModelId));
				const imported = models
					.filter((m) => !known.has(m.id))
					.map(
						(m) =>
							new RunInfo({
								id: `hub-${m.id.split("/").at(-1)}`,
								name: m.id.split("/").at(-1) ?? m.id,
								status: "imported",
								hubModelId: m.id,
								createdAt: m.lastModified,
								hypothesis: null,
								finding: null,
								config: null,
								colabCell: null,
							}),
					);
				return [...sidecar, ...imported].sort((a, b) =>
					(b.createdAt ?? "").localeCompare(a.createdAt ?? ""),
				);
			});

			const findRun = (id: string) =>
				merged.pipe(
					Effect.flatMap((runs) => {
						const run = runs.find((r) => r.id === id);
						return run
							? Effect.succeed(run)
							: Effect.fail(new Error(`run ${id} not found`));
					}),
				);

			return {
				list: () => merged,
				get: findRun,
				create: (input) =>
					Effect.gen(function* () {
						const sidecar = yield* loadSidecar;
						const config = new RunConfig({
							datasetRepoId: input.datasetRepoId,
							episodes: input.episodes,
							policyType: "act",
							pretrainedPath: input.pretrainedPath,
							steps: input.steps,
							batchSize: input.batchSize,
							saveFreq: input.saveFreq,
						});
						const hubModelId = `${RIG.hfUser}/${input.name}`;
						const run = new RunInfo({
							id: crypto.randomUUID().slice(0, 8),
							name: input.name,
							status: "draft",
							hubModelId,
							createdAt: new Date().toISOString(),
							hypothesis: input.hypothesis,
							finding: null,
							config,
							colabCell: colabCell({ name: input.name, hubModelId, config }),
						});
						yield* saveSidecar([...sidecar, run]);
						return run;
					}),
				update: (id, patch) =>
					Effect.gen(function* () {
						const sidecar = yield* loadSidecar;
						const idx = sidecar.findIndex((r) => r.id === id);
						if (idx < 0)
							return yield* Effect.fail(
								new Error(
									`run ${id} not in registry (imported runs are read-only for now)`,
								),
							);
						const prev = sidecar[idx];
						const next = new RunInfo({
							...prev,
							status: patch.status ?? prev.status,
							hypothesis: patch.hypothesis ?? prev.hypothesis,
							finding: patch.finding ?? prev.finding,
						});
						const updated = [...sidecar];
						updated[idx] = next;
						yield* saveSidecar(updated);
						return next;
					}),
				checkpoints: (id) =>
					findRun(id).pipe(
						Effect.flatMap((r) =>
							hub
								.checkpointSteps(r.hubModelId)
								.pipe(
									Effect.map((steps) => ({ hubModelId: r.hubModelId, steps })),
								),
						),
					),
			};
		}),
	);
}
