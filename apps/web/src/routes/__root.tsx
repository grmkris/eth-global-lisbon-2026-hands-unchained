import { TanStackDevtools } from "@tanstack/react-devtools";
import {
	QueryClient,
	QueryClientProvider,
	useQuery,
} from "@tanstack/react-query";
import {
	createRootRoute,
	HeadContent,
	Link,
	Scripts,
} from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { ExternalLink, FlaskConical } from "lucide-react";

import { ShellStatus } from "#/components/shell-status";
import { ThemeToggle } from "#/components/theme-toggle";
import { Toaster } from "#/components/ui/sonner";
import { modeQuery } from "#/lib/hub-api";
import appCss from "../styles.css?url";

const queryClient = new QueryClient();

export const Route = createRootRoute({
	head: () => ({
		meta: [
			{
				charSet: "utf-8",
			},
			{
				name: "viewport",
				content: "width=device-width, initial-scale=1",
			},
			{
				title: "Lab Console",
			},
		],
		links: [
			{
				rel: "stylesheet",
				href: appCss,
			},
		],
	}),
	shellComponent: RootDocument,
});

// A hub has no arm, no cameras and no lerobot cache — offering the lab pages
// there would be lying. A rig is not a hub, so it has no lobby.
const HUB_NAV = [{ to: "/lobby", label: "Lobby" }] as const;
const RIG_NAV = [
	{ to: "/robot", label: "Robot" },
	{ to: "/record", label: "Record" },
	{ to: "/datasets", label: "Datasets" },
	{ to: "/trainings", label: "Trainings" },
] as const;

function Nav() {
	const mode = useQuery(modeQuery);
	// render no links until the role is known — a wrong link is worse than none
	const items = mode.data ? (mode.data.mode === "hub" ? HUB_NAV : RIG_NAV) : [];
	return (
		<>
			{items.map((item) => (
				<Link
					key={item.to}
					to={item.to}
					className="text-muted-foreground hover:text-foreground"
					activeProps={{ className: "font-semibold text-foreground" }}
				>
					{item.label}
				</Link>
			))}
		</>
	);
}

function RootDocument({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en" className="dark" suppressHydrationWarning>
			<head>
				{/* runs pre-paint: dark is the SSR default, honor a saved light preference before first render */}
				<script
					// biome-ignore lint/security/noDangerouslySetInnerHtml: static theme bootstrap, no user input
					dangerouslySetInnerHTML={{
						__html:
							'try{localStorage.getItem("theme")==="light"&&document.documentElement.classList.remove("dark")}catch(e){}',
					}}
				/>
				<HeadContent />
			</head>
			<body>
				<QueryClientProvider client={queryClient}>
					<nav className="sticky top-0 z-10 flex items-center gap-4 border-b bg-background/90 px-6 py-3 text-sm backdrop-blur">
						<Link to="/" className="flex items-center gap-2 font-semibold">
							<FlaskConical className="size-4 text-muted-foreground" />
							Lab Console
						</Link>
						<Nav />
						<div className="ml-auto flex items-center gap-3">
							<ShellStatus />
							<a
								href="/api/docs"
								className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
								target="_blank"
								rel="noreferrer"
							>
								API docs
								<ExternalLink className="size-3" />
							</a>
							<ThemeToggle />
						</div>
					</nav>
					<main className="mx-auto w-full max-w-5xl px-6 py-8">{children}</main>
					<Toaster position="bottom-center" />
				</QueryClientProvider>
				{import.meta.env.DEV && (
					<TanStackDevtools
						config={{
							position: "bottom-right",
						}}
						plugins={[
							{
								name: "Tanstack Router",
								render: <TanStackRouterDevtoolsPanel />,
							},
						]}
					/>
				)}
				<Scripts />
			</body>
		</html>
	);
}
