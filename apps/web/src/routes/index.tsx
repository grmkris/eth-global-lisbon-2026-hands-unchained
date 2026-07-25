import { createFileRoute } from "@tanstack/react-router";
import { LobbyPage } from "./lobby";

// The hub is the whole app now — the front door is the lobby.
export const Route = createFileRoute("/")({ component: LobbyPage });
