import { useQuery } from "@tanstack/react-query";
import { healthQuery } from "#/lib/queries";
import { cn } from "#/lib/utils";

/** Shell-level API/driver reachability dot — visible on every page. */
export function ShellStatus() {
	const health = useQuery(healthQuery);

	const state = health.isPending ? "pending" : health.isError ? "down" : "ok";

	return (
		<span
			className="flex items-center gap-1.5 text-xs text-muted-foreground"
			title="console API health (30s poll)"
		>
			<span
				className={cn(
					"size-2 rounded-full",
					state === "ok" && "bg-success",
					state === "down" && "animate-pulse bg-danger",
					state === "pending" && "bg-muted-foreground/40",
				)}
			/>
			{state === "down"
				? "API unreachable"
				: state === "ok"
					? `hf ${health.data?.hfUser} · v${health.data?.version}`
					: "…"}
		</span>
	);
}
