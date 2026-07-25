import { useEffect, useRef } from "react";

/**
 * HUD hotkeys mirroring the lerobot-record CLI keys: → keep, ← re-record,
 * Esc finish — plus k/r/f alternates. Ignored while typing in a form control
 * or while the KeyJogPad ([role="application"]) has focus, so jogging the arm
 * can never trigger an episode action.
 */
export function useHudHotkeys(opts: {
	enabled: boolean;
	onKeep: () => void;
	onRerecord: () => void;
	onFinish: () => void;
}) {
	const cb = useRef(opts);
	cb.current = opts;

	useEffect(() => {
		if (!opts.enabled) return;
		const handler = (e: KeyboardEvent) => {
			if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
			const target = e.target;
			if (
				target instanceof HTMLElement &&
				target.closest(
					'input, textarea, select, [contenteditable], [role="application"]',
				)
			)
				return;
			switch (e.key) {
				case "ArrowRight":
				case "k":
					e.preventDefault();
					cb.current.onKeep();
					break;
				case "ArrowLeft":
				case "r":
					e.preventDefault();
					cb.current.onRerecord();
					break;
				case "Escape":
				case "f":
					e.preventDefault();
					cb.current.onFinish();
					break;
			}
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [opts.enabled]);
}
