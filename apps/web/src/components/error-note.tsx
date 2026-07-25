import { AlertCircle, CircleAlert } from "lucide-react";
import type { PreflightError } from "#/api/contract";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { apiErrorMessage } from "#/lib/errors";

export function ErrorNote({
	error,
	title,
}: {
	error: unknown;
	title?: string;
}) {
	return (
		<Alert variant="destructive">
			<AlertCircle />
			{title && <AlertTitle>{title}</AlertTitle>}
			<AlertDescription>{apiErrorMessage(error)}</AlertDescription>
		</Alert>
	);
}

export function PreflightGateList({ error }: { error: PreflightError }) {
	return (
		<Alert className="border-warn/50 text-warn [&>svg]:text-warn">
			<CircleAlert />
			<AlertTitle>Preflight failed — fix these and retry</AlertTitle>
			<AlertDescription>
				<ul className="flex flex-col gap-1">
					{error.gates.map((gate) => (
						<li key={gate} className="flex items-center gap-2">
							<CircleAlert className="size-3.5 shrink-0" />
							{gate}
						</li>
					))}
				</ul>
			</AlertDescription>
		</Alert>
	);
}
