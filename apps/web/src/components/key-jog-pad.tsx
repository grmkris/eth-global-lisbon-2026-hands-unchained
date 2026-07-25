/** biome-ignore-all lint/a11y/noNoninteractiveTabindex: intentional key-capture surface (role=application, needs focus) */
import { useCallback, useEffect, useRef, useState } from "react";
import { robotTeleopInput } from "#/lib/queries";

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
 * `onAxes` lets the same pad drive a remote rig through the hub; it defaults to
 * the local driver so the Robot/Record pages are unchanged.
 */
export function KeyJogPad({
	onAxes,
}: {
	onAxes?: (axes: Record<string, number>) => void;
}) {
	const pressed = useRef<Record<string, number>>({});
	const [focused, setFocused] = useState(false);
	const sink = useRef(onAxes);
	sink.current = onAxes;

	const send = useCallback(() => {
		const axes: Record<string, number> = { x: 0, y: 0, z: 0, gripper: 0 };
		for (const [key, [axis, sign]] of Object.entries(KEY_AXES)) {
			if (pressed.current[key]) axes[axis] += sign;
		}
		for (const k of Object.keys(axes))
			axes[k] = Math.max(-1, Math.min(1, axes[k]));
		if (sink.current) sink.current(axes);
		else robotTeleopInput(axes).catch(() => {});
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
			onFocus={() => setFocused(true)}
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
			className={`mt-3 cursor-pointer rounded border-2 p-4 text-sm outline-none ${
				focused ? "border-info bg-info/5" : "border-dashed"
			}`}
		>
			<div className="font-medium">
				{focused
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
