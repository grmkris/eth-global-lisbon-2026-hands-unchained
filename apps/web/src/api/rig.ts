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
	hfUser: "kris0",
} as const;
