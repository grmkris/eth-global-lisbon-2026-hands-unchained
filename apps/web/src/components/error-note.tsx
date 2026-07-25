import { AlertCircle } from "lucide-react";
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
