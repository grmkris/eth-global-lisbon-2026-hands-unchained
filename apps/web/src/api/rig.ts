/** Rig profile — the flags nobody should ever retype (crib-sheet convention).
 * Defaults are Kristjan's arms; another machine overrides via env
 * (FOLLOWER_PORT=$(ls /dev/tty.usbmodem*)). */
export const RIG = {
	followerPort: process.env.FOLLOWER_PORT ?? "/dev/tty.usbmodem5AE60832001",
	leaderPort: process.env.LEADER_PORT ?? "/dev/tty.usbmodem5AE60538411",
	robotId: process.env.ROBOT_ID ?? "arm",
	brightnessBand: { min: 115, max: 131 },
	hfUser: "kris0",
} as const;
