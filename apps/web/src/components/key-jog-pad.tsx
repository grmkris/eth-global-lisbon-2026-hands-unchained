/** biome-ignore-all lint/a11y/noNoninteractiveTabindex: intentional key-capture surface (role=application, needs focus) */
import { useCallback, useEffect, useRef, useState } from "react";

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
 * begin keys teleop on an arm that is merely connected. That is why there is no
 * "Teleop (keys)" button any more. Focus (not first keypress) is the trigger
 * because the verb takes a link tick + a source seed to take effect, and axes
 * sent into that window are simply rejected.
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
}: {
	onAxes: (axes: Record<string, number>) => void;
	armed?: boolean;
	disabledReason?: string | null;
	onArm?: () => void;
}) {
	const pressed = useRef<Record<string, number>>({});
	const [focused, setFocused] = useState(false);
	const sink = useRef(onAxes);
	sink.current = onAxes;

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

	return (
		<div
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
			className={`mt-3 rounded border-2 p-4 text-sm outline-none ${
				!armed
					? "cursor-not-allowed border-dashed opacity-60"
					: focused
						? "cursor-pointer border-info bg-info/5"
						: "cursor-pointer border-dashed"
			}`}
		>
			<div className="font-medium">
				{!armed
					? `⌨ keyboard unavailable — ${disabledReason ?? "another source is driving"}`
					: focused
						? "⌨ capturing keys — arm is live"
						: "click here to grab the keyboard"}
			</div>
			<div className="mt-2 grid grid-cols-2 gap-1 font-mono text-xs text-muted-foreground md:grid-cols-4">
				<span>W/S forward · back</span>
				<span>A/D left · right</span>
				<span>Q/E up · down</span>
				<span>O/C gripper open · close</span>
			</div>
			<p className="mt-2 text-xs text-muted-foreground">
				release all keys (or click away) → arm holds pose (0.5&nbsp;s deadman)
			</p>
		</div>
	);
}
