/**
 * Version-matched Colab training cell, crib-sheet convention (lerobot v0.6.0).
 * Pure function — runs client-side on the hub (the run advertisement from the
 * rig deliberately omits the cell to keep the link payload small) and
 * rig-side when persisting a run.
 */
export interface ColabCellConfig {
	datasetRepoId: string;
	episodes: string | null;
	pretrainedPath: string | null;
	steps: number;
	batchSize: number;
	saveFreq: number;
}

export const colabCell = (run: {
	name: string;
	hubModelId: string;
	config: ColabCellConfig;
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
