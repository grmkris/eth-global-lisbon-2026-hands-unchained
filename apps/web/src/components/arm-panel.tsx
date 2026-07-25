import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ArmStateBadge, SimBadge } from "#/components/status-badge";
import { Button } from "#/components/ui/button";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select";
import { Spinner } from "#/components/ui/spinner";
import {
	robotConnect,
	robotDisconnect,
	robotEstop,
	robotStateQuery,
	robotTeleopStart,
	robotTeleopStop,
	robotTorque,
} from "#/lib/queries";
import { ErrorNote } from "./error-note";
import { KeyJogPad } from "./key-jog-pad";

export function ArmPanel() {
	const state = useQuery(robotStateQuery);
	const queryClient = useQueryClient();
	const invalidate = () =>
		queryClient.invalidateQueries({ queryKey: ["robot"] });
	const [lastError, setLastError] = useState<unknown>(null);

	const useAct = (fn: () => Promise<unknown>) =>
		useMutation({
			mutationFn: fn,
			onSuccess: () => {
				setLastError(null);
				invalidate();
			},
			onError: (e) => setLastError(e),
		});

	const [source, setSource] = useState<string>("default");
	const connect = useAct(() => robotConnect(true));
	const connectSolo = useAct(() => robotConnect(false));
	const connectSim = useAct(() => robotConnect(false, "sim"));
	const disconnect = useAct(robotDisconnect);
	const torqueOff = useAct(() => robotTorque(false));
	const torqueOn = useAct(() => robotTorque(true));
	const teleopStart = useAct(() =>
		robotTeleopStart(source === "default" ? null : source),
	);
	const teleopStop = useAct(robotTeleopStop);
	const estop = useAct(robotEstop);

	const s = state.data;
	// E-STOP is deliberately NOT gated on this — never lock the kill switch
	const busy =
		connect.isPending ||
		connectSolo.isPending ||
		connectSim.isPending ||
		disconnect.isPending ||
		teleopStart.isPending ||
		teleopStop.isPending ||
		torqueOn.isPending ||
		torqueOff.isPending;

	return (
		<div className="mt-8 rounded-lg border bg-card p-4">
			<div className="flex items-center justify-between">
				<div>
					<h2 className="flex items-center gap-2 text-lg font-semibold">
						Arm
						{s?.backend === "sim" && <SimBadge />}
						<ArmStateBadge state={s?.state} />
					</h2>
					<p className="mt-0.5 font-mono text-xs text-muted-foreground">
						follower {s?.rig.followerPort} · leader {s?.rig.leaderPort} · id{" "}
						{s?.rig.robotId}
					</p>
				</div>
				<Button
					variant="destructive"
					size="lg"
					className="font-bold"
					disabled={s?.state === "disconnected" || estop.isPending}
					onClick={() => estop.mutate()}
					title="Torque kill — arm goes limp, hold it if raised"
				>
					E-STOP
				</Button>
			</div>

			<div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
				{s?.state === "disconnected" ? (
					<>
						<Button disabled={busy} onClick={() => connect.mutate()}>
							{connect.isPending && <Spinner />}
							{connect.isPending
								? "connecting…"
								: "Connect (leader + follower)"}
						</Button>
						<Button
							variant="outline"
							disabled={busy}
							onClick={() => connectSolo.mutate()}
						>
							{connectSolo.isPending && <Spinner />}
							Follower only
						</Button>
						<Button
							variant="outline"
							className="border-sim/50 text-sim hover:text-sim"
							disabled={busy}
							onClick={() => connectSim.mutate()}
						>
							{connectSim.isPending && <Spinner />}
							{connectSim.isPending
								? "loading MuJoCo…"
								: "Connect SIM (MuJoCo)"}
						</Button>
					</>
				) : (
					<>
						{s?.state === "connected" && (
							<>
								<Select value={source} onValueChange={setSource}>
									<SelectTrigger className="w-56">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectGroup>
											<SelectItem value="default">
												{s.backend === "sim"
													? "scripted (default)"
													: "leader (default)"}
											</SelectItem>
											{s.backend === "real" && (
												<SelectItem value="leader">leader arm</SelectItem>
											)}
											{s.backend === "sim" && (
												<SelectItem value="scripted">
													scripted expert
												</SelectItem>
											)}
											<SelectItem value="keys">keyboard (EE jog)</SelectItem>
											<SelectItem value="phone">
												phone (HEBI, hold B1)
											</SelectItem>
										</SelectGroup>
									</SelectContent>
								</Select>
								<Button disabled={busy} onClick={() => teleopStart.mutate()}>
									{teleopStart.isPending && <Spinner />}
									Start teleop
								</Button>
							</>
						)}
						{s?.state === "teleop" && (
							<Button
								variant="outline"
								disabled={busy}
								onClick={() => teleopStop.mutate()}
							>
								{teleopStop.isPending && <Spinner />}
								Stop teleop
							</Button>
						)}
						<Button
							variant="outline"
							disabled={busy}
							onClick={() => torqueOn.mutate()}
						>
							Torque on
						</Button>
						<Button
							variant="outline"
							disabled={busy}
							onClick={() => torqueOff.mutate()}
						>
							Torque off
						</Button>
						<Button
							variant="outline"
							disabled={busy}
							onClick={() => disconnect.mutate()}
						>
							{disconnect.isPending && <Spinner />}
							Disconnect
						</Button>
					</>
				)}
			</div>

			{lastError != null && (
				<div className="mt-3">
					<ErrorNote error={lastError} />
				</div>
			)}

			{s?.state === "teleop" && s.source === "keys" && <KeyJogPad />}

			{s && Object.keys(s.joints).length > 0 && (
				<div className="mt-4 grid grid-cols-3 gap-2 font-mono text-xs md:grid-cols-6">
					{Object.entries(s.joints).map(([joint, pos]) => (
						<div key={joint} className="rounded bg-muted p-2">
							<div className="text-muted-foreground">{joint}</div>
							<div className="tabular-nums">{pos.toFixed(1)}</div>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
