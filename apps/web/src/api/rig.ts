/** OpenCV device indexes this rig may EVER open. The driver scans 0..5 and
 * keeps whatever isn't returning black frames, which on a Mac means the arm's
 * USB pair AND the built-in FaceTime/Continuity cameras — dead grey tiles that
 * still cost a capture thread and a 12.5 fps uplink. So this is a floor, not a
 * preference: cam0/cam1 are the arm. Widen it per rig with `LAB_CAMS=0,1,3`.
 *
 * Guarded like LAB_FRAME_MS in rig/link.ts: a malformed value falls back to the
 * default, never to "everything" (the bug we are fixing) and never to "nothing"
 * (a rig with no cameras at all). */
const parseCams = (raw: string | undefined): ReadonlyArray<number> => {
	const tokens = (raw ?? "").split(",").filter((part) => part.trim() !== "");
	const parsed = tokens
		.map((part) => Number(part.trim()))
		.filter((n) => Number.isInteger(n) && n >= 0);
	// A typo'd token silently narrowing the allowlist is how you lose an hour
	// wondering why a camera never came back.
	if (parsed.length !== tokens.length)
		console.error(
			`[rig] LAB_CAMS="${raw}" — ignoring ${tokens.length - parsed.length} unparseable entr${tokens.length - parsed.length === 1 ? "y" : "ies"}`,
		);
	return parsed.length > 0
		? [...new Set(parsed)].sort((a, b) => a - b)
		: [0, 1];
};

/** Rig profile. Ports are null unless set via env: the driver auto-detects
 * the follower when exactly one serial device is plugged in, and the leader
 * attaches ONLY when LEADER_PORT is explicit (so a leader agent on the same
 * machine can own that port). Kristjan's serials live in package.json
 * scripts (`rig:real`, `rig:sim*`), not here. */
export const RIG = {
	followerPort: process.env.FOLLOWER_PORT || null,
	leaderPort: process.env.LEADER_PORT || null,
	robotId: process.env.ROBOT_ID ?? "arm",
	brightnessBand: { min: 115, max: 131 },
	cams: parseCams(process.env.LAB_CAMS),
	hfUser: "kris0",
} as const;
