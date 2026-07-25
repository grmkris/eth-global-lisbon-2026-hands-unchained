import { Check, RotateCcw, Square } from "lucide-react";
import type { RecordStatus } from "#/api/contract";
import { CamFeed, CamOffAir } from "#/components/cam-feed";
import { KeyJogPad } from "#/components/key-jog-pad";
import { Button } from "#/components/ui/button";
import { Kbd } from "#/components/ui/kbd";
import { cn } from "#/lib/utils";
import { fmtClock, useEpisodeClock } from "./use-episode-clock";
import { useHudHotkeys } from "./use-hud-hotkeys";

const CAMS = ["workspace_cam", "wrist_cam"] as const;

export function RecordHud({
	status,
	isSim,
	durations,
	redone,
	onKeep,
	onRerecord,
	onFinish,
	controlPending,
}: {
	status: RecordStatus;
	isSim: boolean;
	durations: { episodeS: number; resetS: number } | null;
	redone: number;
	onKeep: () => void;
	onRerecord: () => void;
	onFinish: () => void;
	controlPending: boolean;
}) {
	const clock = useEpisodeClock(status, durations);
	const recording = status.phase === "recording";

	useHudHotkeys({
		enabled: !controlPending,
		onKeep,
		onRerecord,
		onFinish,
	});

	return (
		<div className="mt-4">
			<div className="flex flex-wrap items-center gap-4">
				<span
					className={cn(
						"flex items-center gap-3 rounded px-4 py-2 font-mono text-lg font-bold text-status-foreground",
						recording ? "animate-pulse bg-danger" : "bg-warn",
					)}
				>
					{recording ? "● REC" : "RESET"}
					{clock && (
						<span className="font-medium">
							{clock.mode === "countdown"
								? clock.overrun
									? "saving…"
									: `${fmtClock(clock.remaining)}/${fmtClock(clock.duration)}`
								: `${fmtClock(clock.elapsed)} elapsed`}
						</span>
					)}
				</span>
				<span className="font-mono text-lg">
					episode {status.episode}/{status.total}
				</span>
				<span className="font-mono text-sm text-muted-foreground">
					{status.repoId}
					{status.source ? ` · ${status.source}` : ""}
				</span>
			</div>

			{status.source === "keys" && <KeyJogPad />}

			<div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
				{CAMS.map((cam) =>
					isSim ? (
						<CamFeed key={cam} name={cam} src={`/api/cams/${cam}`} />
					) : (
						<CamOffAir
							key={cam}
							name={cam}
							note={
								<>
									cameras are owned by the recorder during real sessions —
									<span className="font-medium text-white/80">
										{" "}
										watch the rig, not the screen
									</span>
								</>
							}
						/>
					),
				)}
			</div>

			<div className="mt-4 flex flex-wrap gap-2">
				<Button size="lg" disabled={controlPending} onClick={onKeep}>
					<Check />
					keep &amp; next
					<Kbd>→</Kbd>
				</Button>
				<Button
					size="lg"
					variant="outline"
					disabled={controlPending}
					onClick={onRerecord}
				>
					<RotateCcw />
					re-record
					<Kbd>←</Kbd>
				</Button>
				<Button
					size="lg"
					variant="outline"
					className="border-danger/50 text-danger hover:text-danger"
					disabled={controlPending}
					onClick={onFinish}
				>
					<Square />
					finish
					<Kbd>Esc</Kbd>
				</Button>
			</div>

			<p className="mt-3 font-mono text-sm text-muted-foreground">
				kept {status.saved} · redone {redone} (this session)
			</p>
		</div>
	);
}
