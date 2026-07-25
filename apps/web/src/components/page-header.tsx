import { Link, type LinkProps } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "#/lib/utils";

export function PageHeader(props: {
	title: ReactNode;
	titleClassName?: string;
	description?: ReactNode;
	badge?: ReactNode;
	actions?: ReactNode;
	back?: { to: LinkProps["to"]; label: string };
}) {
	return (
		<header className="mb-6">
			{props.back && (
				<Link
					to={props.back.to}
					className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
				>
					<ArrowLeft className="size-3.5" />
					{props.back.label}
				</Link>
			)}
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex items-center gap-3">
					<h1
						className={cn(
							"text-2xl font-bold tracking-tight",
							props.titleClassName,
						)}
					>
						{props.title}
					</h1>
					{props.badge}
				</div>
				{props.actions}
			</div>
			{props.description && (
				<p className="mt-1 text-sm text-muted-foreground">
					{props.description}
				</p>
			)}
		</header>
	);
}
