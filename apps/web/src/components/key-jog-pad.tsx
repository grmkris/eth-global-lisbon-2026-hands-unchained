/** biome-ignore-all lint/a11y/noNoninteractiveTabindex: intentional key-capture surface (role=application, needs focus) */
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "#/lib/utils";

// browser-side key → EE axis map (lerobot units downstream; no pynput, no OS permissions)
const KEY_AXES: Record<string, [string, number]> = {
	w: ["x", 1],
	s: ["x", -1],
	a: ["y", 1],
	d: ["y", -1],
	q: ["z", 1],
	e: ["z", -1],
	o: ["gripper", 1],
	c: ["gripper", -1],
};

/**
 * Axes always leave through `onAxes` — the drive page relays them to the rig.
 *
 * The pad is also the START button: `onArm` fires on focus, so the route can
 * begin keys teleop on an arm that is merely connected. Focus (not first
 * keypress) is the trigger because the verb takes a link tick + a source seed
 * to take effect, and axes sent into that window are simply rejected.
 *
 * The pad is now mounted ONLY once the keyboard is the chosen source, so
 * `autoFocus` lands you capturing keys with no second click — picking the
 * keyboard chip is the whole gesture. The "keyboard unavailable" state survives
 * for the case where something takes the source out from under a mounted pad;
 * the ordinary "a leader is driving" explanation lives on the chip instead of
 * on a permanently parked box of key legends.
 *
 * When `armed` is false the pad sends NOTHING and says why: browser axes and a
 * leader's joints share one single-slot mailbox, so typing during a leader
 * session used to displace the leader's packet and then fail rig-side — the arm
 * just stuttered and nobody was told.
 */
export function KeyJogPad({
	onAxes,
	armed = true,
	disabledReason = null,
	onArm,
	autoFocus = false,
}: {
	onAxes: (axes: Record<string, number>) => void;
	armed?: boolean;
	disabledReason?: string | null;
	onArm?: () => void;
	autoFocus?: boolean;
}) {
	const pressed = useRef<Record<string, number>>({});
	const [focused, setFocused] = useState(false);
	const sink = useRef(onAxes);
	sink.current = onAxes;
	const pad = useRef<HTMLDivElement>(null);

	const armedRef = useRef(armed);
	armedRef.current = armed;

	const send = useCallback(() => {
		if (!armedRef.current) return; // something else owns the input
		const axes: Record<string, number> = { x: 0, y: 0, z: 0, gripper: 0 };
		for (const [key, [axis, sign]] of Object.entries(KEY_AXES)) {
			if (pressed.current[key]) axes[axis] += sign;
		}
		for (const k of Object.keys(axes))
			axes[k] = Math.max(-1, Math.min(1, axes[k]));
		sink.current(axes);
	}, []);

	useEffect(() => {
		// heartbeat keeps the driver's deadman fed while keys are held
		const interval = setInterval(() => {
			if (Object.values(pressed.current).some(Boolean)) send();
		}, 200);
		return () => clearInterval(interval);
	}, [send]);

	// Grab focus on mount when the operator got here by choosing the keyboard —
	// they already said what they wanted; asking for a second click is a step.
	// `focused` is then read back off activeElement rather than left to the
	// focus EVENT: a programmatic .focus() does not dispatch one in every
	// context, and the label lying ("click here to grab the keyboard" while the
	// pad is in fact capturing) is worse than either state alone.
	useEffect(() => {
		if (!autoFocus) return;
		pad.current?.focus();
		if (pad.current !== null && document.activeElement === pad.current)
			setFocused(true);
	}, [autoFocus]);

	return (
		<div
			ref={pad}
			role="application"
			tabIndex={0}
			onFocus={() => {
				setFocused(true);
				if (armed) onArm?.();
			}}
			onBlur={() => {
				setFocused(false);
				pressed.current = {};
				send();
			}}
			onKeyDown={(e) => {
				const key = e.key.toLowerCase();
				if (key in KEY_AXES) {
					e.preventDefault();
					if (!pressed.current[key]) {
						pressed.current[key] = 1;
						send();
					}
				}
			}}
			onKeyUp={(e) => {
				const key = e.key.toLowerCase();
				if (key in KEY_AXES) {
					pressed.current[key] = 0;
					send();
				}
			}}
			className={cn(
				"flex flex-wrap items-center gap-x-4 gap-y-1 rounded border-2 px-3 py-2 text-sm outline-none",
				!armed
					? "cursor-not-allowed border-dashed opacity-60"
					: focused
						? "cursor-pointer border-info bg-info/5"
						: "cursor-pointer border-dashed",
			)}
		>
			<span className="font-medium">
				{!armed
					? `⌨ keyboard unavailable — ${disabledReason ?? "another source is driving"}`
					: focused
						? "⌨ capturing keys — arm is live"
						: "⌨ click here to grab the keyboard"}
			</span>
			{/* one line, not a four-cell grid plus a paragraph: this sits directly
			    under the camera now, and every row it takes is a row the feed loses */}
			<span className="font-mono text-xs text-muted-foreground">
				W/S · A/D · Q/E move · O/C gripper · release = hold pose (0.5&nbsp;s
				deadman)
			</span>
		</div>
	);
}
