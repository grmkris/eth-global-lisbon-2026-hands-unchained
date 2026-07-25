import type { ReactNode } from "react";
import { Badge } from "#/components/ui/badge";
import { cn } from "#/lib/utils";

export type StatusTone =
	| "success"
	| "warn"
	| "danger"
	| "info"
	| "sim"
	| "neutral";

const toneClass: Record<StatusTone, string> = {
	success: "border-success/40 bg-success/10 text-success",
	warn: "border-warn/40 bg-warn/10 text-warn",
	danger: "border-danger/40 bg-danger/10 text-danger",
	info: "border-info/40 bg-info/10 text-info",
	sim: "bg-sim text-status-foreground font-bold",
	neutral: "border-border bg-muted text-muted-foreground",
};

export function StatusBadge({
	tone,
	className,
	children,
	title,
}: {
	tone: StatusTone;
	className?: string;
	children: ReactNode;
	title?: string;
}) {
	return (
		<Badge
			variant="outline"
			className={cn(toneClass[tone], className)}
			title={title}
		>
			{children}
		</Badge>
	);
}

export function SimBadge() {
	return <StatusBadge tone="sim">SIM</StatusBadge>;
}

const armTone: Record<string, StatusTone> = {
	disconnected: "neutral",
	connected: "success",
	teleop: "info",
	recording: "danger",
};

export function ArmStateBadge({ state }: { state: string | undefined }) {
	return (
		<StatusBadge tone={state ? (armTone[state] ?? "neutral") : "neutral"}>
			{state ?? "…"}
		</StatusBadge>
	);
}
