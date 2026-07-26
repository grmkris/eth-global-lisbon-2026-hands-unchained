import { TanStackDevtools } from "@tanstack/react-devtools";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createRootRoute,
	HeadContent,
	Link,
	Scripts,
	useMatches,
} from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";

import { HandMark } from "#/components/logo";
import { ShellStatus } from "#/components/shell-status";
import { ThemeToggle } from "#/components/theme-toggle";
import { Toaster } from "#/components/ui/sonner";
import { WalletBadge } from "#/components/wallet-badge";
import { cn } from "#/lib/utils";
// Imported through Vite so it lands in /assets/* — the only path server.ts
// serves statically in production. A public/ dir would 404 there.
import faviconUrl from "../logo-mark.png?url";
import appCss from "../styles.css?url";

const queryClient = new QueryClient();

/**
 * `wide` opts a route out of the reading-width column. Exactly one page wants
 * it: the drive cockpit, where the camera IS the interface and 1024px makes it
 * a stamp. Everything else stays narrow on purpose — a table of datasets read
 * across 1600px is worse, not better.
 */
declare module "@tanstack/react-router" {
	interface StaticDataRouteOption {
		wide?: boolean;
	}
}

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
				title: "Hands Unchained",
			},
		],
		links: [
			{
				rel: "stylesheet",
				href: appCss,
			},
			{
				rel: "icon",
				type: "image/png",
				href: faviconUrl,
			},
		],
	}),
	shellComponent: RootDocument,
});

// One app, one nav. Hardware lives behind each rig's drive page.
const NAV = [
	{ to: "/lobby", label: "Lobby" },
	{ to: "/market", label: "Market" },
	{ to: "/datasets", label: "Datasets" },
	{ to: "/trainings", label: "Trainings" },
] as const;

function Nav() {
	return (
		<>
			{NAV.map((item) => (
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
	const wide = useMatches().some((m) => m.staticData.wide === true);
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
							<HandMark className="h-[22px] w-auto shrink-0" />
							Hands Unchained
						</Link>
						<Nav />
						{/* Identity, then health, then preference — what this browser IS
						    connected to, on every page. `/api/docs` still serves; it was a
						    developer bookmark taking nav weight from the wallet. */}
						<div className="ml-auto flex items-center gap-3">
							<WalletBadge />
							<ShellStatus />
							<ThemeToggle />
						</div>
					</nav>
					<main
						className={cn(
							"mx-auto w-full px-6 py-8",
							wide ? "max-w-[1600px]" : "max-w-5xl",
						)}
					>
						{children}
					</main>
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
