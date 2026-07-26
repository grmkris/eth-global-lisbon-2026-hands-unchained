import { Activity, ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { LeaderInputDebugPanel } from "#/components/leader-input-debug";
import { Card, CardContent } from "#/components/ui/card";
import type { LeaderInputDebug } from "#/lib/hub-api";

/**
 * Everything that proves the pipe works, folded away until asked for.
 *
 * The leader-input dump was mounted unconditionally and cost ~330px of JSON on
 * every drive page — including the ones with no remote leader, where it said
 * "no remote leader" and nothing else. It pushed the controls below the fold to
 * answer a question nobody was asking.
 *
 * The collapsed summary carries the live signal (`27 pkt/s · receiving`), so
 * the fold rarely has to be opened at all: you can tell input is flowing
 * without reading a single joint value.
 *
 * Disclosure is hand-rolled to match components/owner-panel.tsx — there is no
 * shadcn Collapsible in this project and one fold pattern is enough.
 */
export function DiagnosticsFold({
	leader,
	input,
	joints,
}: {
	/** the bound remote leader's name, null when nothing remote is driving */
	leader: string | null;
	input: LeaderInputDebug | null;
	joints: Record<string, number>;
}) {
	const [open, setOpen] = useState(false);

	const source = leader ?? input?.leader ?? null;
	const jointCount = Object.keys(joints).length;
	const receiving = input !== null && input.ageMs < 1_000;

	// what you would have opened the fold to find out
	const summary = source
		? `${source} · ${input ? (receiving ? "receiving" : "stale") : "waiting for input"}`
		: jointCount > 0
			? `${jointCount} joints`
			: "nothing to report";

	return (
		<Card>
			<CardContent className="flex flex-col gap-3">
				<button
					type="button"
					className="flex items-center gap-2 text-left font-medium"
					onClick={() => setOpen(!open)}
				>
					{open ? (
						<ChevronDown className="size-4" />
					) : (
						<ChevronRight className="size-4" />
					)}
					<Activity className="size-4 text-muted-foreground" />
					Diagnostics
					{!open && (
						<span className="font-mono font-normal text-muted-foreground text-xs">
							{summary}
						</span>
					)}
				</button>
				{open && (
					<>
						{/* only when there is something remote to inspect — a panel whose
						    whole content is "no remote leader" is not information */}
						{(source !== null || input !== null) && (
							<LeaderInputDebugPanel leader={leader} input={input} />
						)}
						{jointCount > 0 && (
							<div className="grid grid-cols-3 gap-2 font-mono text-xs md:grid-cols-6">
								{Object.entries(joints).map(([joint, pos]) => (
									<div key={joint} className="rounded bg-muted p-2">
										<div className="text-muted-foreground">{joint}</div>
										<div className="tabular-nums">{pos.toFixed(1)}</div>
									</div>
								))}
							</div>
						)}
					</>
				)}
			</CardContent>
		</Card>
	);
}
