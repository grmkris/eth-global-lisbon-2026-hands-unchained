import { Disc, Square } from "lucide-react";
import { useState } from "react";
import { Button } from "#/components/ui/button";
import { Card, CardContent } from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select";
import { type RigSummary, ownerKeyStore } from "#/lib/hub-api";

const ts = () => {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

const SOURCES: Record<string, Array<{ value: string; label: string }>> = {
	real: [
		{ value: "leader", label: "Leader arm" },
		{ value: "keys", label: "Keyboard (EE jog)" },
		{ value: "phone", label: "Phone (HEBI)" },
	],
	sim: [
		{ value: "scripted", label: "Scripted expert" },
		{ value: "keys", label: "Keyboard (EE jog)" },
		{ value: "phone", label: "Phone (HEBI)" },
	],
};

/**
 * Owner free-form recording over the hub pipe. Live status comes from the
 * rig's record telemetry; keyboard driving DURING a session works because
 * teleop input reaches the record source (existing plumbing).
 */
export function RecordPanel(props: {
	rig: RigSummary;
	onCommand: (verb: string, args?: Record<string, unknown>) => void;
	busy: boolean;
}) {
	const { rig, onCommand, busy } = props;
	const key = ownerKeyStore.get(rig.name);
	const isSim = rig.backend === "sim";
	const sources = SOURCES[isSim ? "sim" : "real"];
	const [repoName, setRepoName] = useState("");
	const [task, setTask] = useState("pick the piece and place it on the peg");
	const [numEpisodes, setNumEpisodes] = useState(5);
	const [episodeS, setEpisodeS] = useState(20);
	const [resetS, setResetS] = useState(10);
	const [source, setSource] = useState<string | null>(null);
	const status = rig.record;
	const active = status?.active === true;

	const start = () =>
		onCommand("record_start", {
			repoName:
				repoName || `so101_${isSim ? "sim" : "session"}_${ts()}`,
			task,
			numEpisodes,
			episodeS,
			resetS,
			source: source ?? sources[0].value,
		});

	return (
		<Card>
			<CardContent className="flex flex-col gap-3">
				<div className="flex items-center gap-2 font-medium">
					<Disc className="size-4 text-muted-foreground" />
					Record a session
				</div>

				{active ? (
					<div className="flex flex-wrap items-center gap-3">
						<span
							className={`rounded px-2 py-0.5 font-mono text-xs ${
								status?.phase === "recording"
									? "bg-destructive text-destructive-foreground"
									: "bg-muted"
							}`}
						>
							{status?.phase === "recording" ? "● REC" : status?.phase}
						</span>
						<span className="font-mono text-xs text-muted-foreground">
							ep {(status?.episode ?? 0) + 1}/{status?.total} · saved{" "}
							{status?.saved} · {status?.repoId} · {status?.source}
						</span>
						<Button
							size="sm"
							disabled={!key || busy}
							onClick={() => onCommand("record_control", { action: "keep" })}
						>
							✓ Keep
						</Button>
						<Button
							size="sm"
							variant="outline"
							disabled={!key || busy}
							onClick={() =>
								onCommand("record_control", { action: "rerecord" })
							}
						>
							↺ Re-record
						</Button>
						<Button
							size="sm"
							variant="outline"
							disabled={!key || busy}
							onClick={() => onCommand("record_control", { action: "finish" })}
						>
							<Square />
							Finish
						</Button>
						<Button
							size="sm"
							variant="destructive"
							disabled={!key || busy}
							onClick={() => onCommand("record_control", { action: "discard" })}
						>
							✗ Discard
						</Button>
					</div>
				) : (
					<div className="flex flex-col gap-2">
						<div className="grid grid-cols-1 gap-2 md:grid-cols-2">
							<div className="flex flex-col gap-1">
								<Label htmlFor="rec-name">Dataset name</Label>
								<Input
									id="rec-name"
									value={repoName}
									onChange={(e) => setRepoName(e.target.value)}
									placeholder={`so101_${isSim ? "sim" : "session"}_<auto>`}
								/>
							</div>
							<div className="flex flex-col gap-1">
								<Label htmlFor="rec-task">Task label</Label>
								<Input
									id="rec-task"
									value={task}
									onChange={(e) => setTask(e.target.value)}
								/>
							</div>
							<div className="flex items-end gap-3">
								<div className="flex flex-col gap-1">
									<Label htmlFor="rec-eps">Episodes</Label>
									<Input
										id="rec-eps"
										type="number"
										value={numEpisodes}
										onChange={(e) => setNumEpisodes(Number(e.target.value))}
									/>
								</div>
								<div className="flex flex-col gap-1">
									<Label htmlFor="rec-epS">Episode s</Label>
									<Input
										id="rec-epS"
										type="number"
										value={episodeS}
										onChange={(e) => setEpisodeS(Number(e.target.value))}
									/>
								</div>
								<div className="flex flex-col gap-1">
									<Label htmlFor="rec-resetS">Reset s</Label>
									<Input
										id="rec-resetS"
										type="number"
										value={resetS}
										onChange={(e) => setResetS(Number(e.target.value))}
									/>
								</div>
							</div>
							<div className="flex flex-col gap-1">
								<Label>Demo source</Label>
								<Select
									value={source ?? sources[0].value}
									onValueChange={setSource}
								>
									<SelectTrigger>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{sources.map((s) => (
											<SelectItem key={s.value} value={s.value}>
												{s.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
						</div>
						<div>
							<Button
								size="sm"
								disabled={!key || !task.trim() || busy}
								onClick={start}
							>
								<Disc />
								Start recording
							</Button>
						</div>
					</div>
				)}
				{!key && (
					<p className="text-xs text-muted-foreground">
						Enter the owner key below to record.
					</p>
				)}
			</CardContent>
		</Card>
	);
}
