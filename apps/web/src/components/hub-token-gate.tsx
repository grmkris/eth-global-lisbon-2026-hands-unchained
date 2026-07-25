import { useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { useState } from "react";
import { Button } from "#/components/ui/button";
import { Card, CardContent } from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { hubToken } from "#/lib/hub-api";

/**
 * Shown when the hub answers 401. One shared secret, entered once — stored in
 * localStorage for fetch headers and mirrored into a cookie for the <img>
 * MJPEG streams, which cannot set headers.
 */
export function HubTokenGate() {
	const queryClient = useQueryClient();
	const [value, setValue] = useState("");

	const save = () => {
		if (!value.trim()) return;
		hubToken.set(value.trim());
		void queryClient.invalidateQueries();
	};

	return (
		<Card className="mx-auto max-w-sm">
			<CardContent className="flex flex-col gap-4">
				<div className="flex items-center gap-2 font-medium">
					<KeyRound className="size-4 text-muted-foreground" />
					Hub access token
				</div>
				<p className="text-sm text-muted-foreground">
					This hub requires a token. Ask the person who deployed it.
				</p>
				<div className="flex flex-col gap-2">
					<Label htmlFor="hub-token">Token</Label>
					<Input
						id="hub-token"
						type="password"
						value={value}
						onChange={(e) => setValue(e.target.value)}
						onKeyDown={(e) => e.key === "Enter" && save()}
						placeholder="paste the shared secret"
					/>
				</div>
				<Button onClick={save} disabled={!value.trim()}>
					Unlock
				</Button>
			</CardContent>
		</Card>
	);
}
