import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vite";

/**
 * Vite loads the server entry lazily, so a rig would sit idle — never dialling
 * the hub — until someone happened to open its page. Poke it once on listen so
 * `bun run rig:sim` is self-sufficient, matching production where the entry
 * loads at boot.
 */
const warmServerEntry = (): Plugin => ({
	name: "lab-warm-server-entry",
	apply: "serve",
	configureServer(server) {
		server.httpServer?.once("listening", () => {
			const addr = server.httpServer?.address();
			const port = typeof addr === "object" && addr ? addr.port : null;
			if (!port) return;
			setTimeout(() => {
				fetch(`http://127.0.0.1:${port}/api/mode`).catch(() => {});
			}, 300);
		});
	},
});

const config = defineConfig({
	resolve: { tsconfigPaths: true },
	plugins: [
		warmServerEntry(),
		devtools(),
		tailwindcss(),
		tanstackStart(),
		viteReact(),
	],
});

export default config;
