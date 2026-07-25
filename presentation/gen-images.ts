/**
 * Deck photography generator — fills the three <image-slot> placeholders in the
 * Claude Design deck ("Proof of Hands.dc.html") with generated photographs.
 *
 * The deck wraps every photo in `.duotone`, which paints --color-accent over it
 * with mix-blend-mode: color — the image keeps its LUMINANCE and loses its hue.
 * So the prompts below chase tonal separation (bright subject, dark ground) and
 * ignore color, and every prompt bans text: a duotone blueprint slide with a
 * garbled AI-rendered label on it reads as fake.
 *
 * Usage:
 *   GEMINI_API_KEY=... bun run presentation/gen-images.ts            # missing only
 *   GEMINI_API_KEY=... bun run presentation/gen-images.ts --force    # regenerate all
 *   GEMINI_API_KEY=... bun run presentation/gen-images.ts --only=photo-rig
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { type AspectRatio, EXT, generateImage } from "./gemini";

/** Full-resolution frames land here; optimize.py downscales them into images/. */
const OUT_DIR = path.join(import.meta.dir, "originals");

/** Shared house style — the deck is a blueprint, so the photos are documentary. */
const STYLE = `
Photographic style: honest documentary photography of real hardware, shot on a
full-frame camera with a 35mm lens at f/2.8. Cool neutral daylight from a large
window, soft directional falloff, no coloured gels, no lens flare. Wide tonal
range with a bright subject against a markedly darker background, because the
image will be reduced to a single-hue duotone and only luminance survives.
Slightly desaturated, fine natural grain, real depth of field. Looks like a
photograph taken by an engineer documenting their own bench, NOT a product
render, NOT a stock photo, NOT CGI, NOT a glossy advertisement.

ABSOLUTELY NO text, letters, numbers, logos, brand marks, labels, stickers,
watermarks, captions or UI copy anywhere in the frame. Screens, if visible, are
out of focus and show only vague dark panels with faint glow — never readable
type. No robot arms other than the one described. No extra hands or fingers.
`.trim();

/** What an SO-101 actually is — get this wrong and a robotics judge sees it. */
const ARM = `
The robot is a LeRobot SO-101 (SO-ARM101) follower arm: a small, low-cost,
open-source 5-degree-of-freedom desktop arm, roughly 45cm of reach, built from
chunky matte-black 3D-printed PLA brackets with visible layer lines and exposed
hex-socket screws. Its joints are Feetech STS3215 serial-bus servos — plain
black plastic cubes about 4cm across, each bolted between two printed brackets,
with short flat 3-pin cables daisy-chained from one servo to the next along the
outside of the arm. It ends in a simple parallel-jaw gripper: two flat printed
black fingers, one moving, one fixed. The whole arm is bolted down to a flat
plate clamped to the table edge. It is unmistakably a hobbyist 3D-printed arm,
not an industrial robot: no smooth injection-moulded shells, no white
enamel-painted casing, no six-axis factory manipulator, no humanoid.
`.trim();

type Shot = {
  /** Matches the image-slot id in the deck, and names the output file. */
  readonly id: string;
  /** Slide it fills, for the log. */
  readonly slide: string;
  /** Slot box in stage px — the aspect ratio is picked to cover it. */
  readonly box: string;
  readonly aspectRatio: AspectRatio;
  readonly prompt: string;
};

const SHOTS: readonly Shot[] = [
  {
    aspectRatio: "4:5",
    box: "936×1080 (half-bleed, left half, full stage height)",
    id: "photo-arm-loop",
    slide: "04 · The loop we ship",
    prompt: `
A tight vertical close-up of the SO-101 arm caught mid-task, reaching down and
forward to pick up a single small unpainted wooden cube from a bare wooden
workbench. The gripper fingers are open, a couple of centimetres from the cube,
about to close — the frozen instant before contact. The arm fills the frame
diagonally from the lower left, its bracket-and-servo stack legible joint by
joint as it rises out of the bottom of the picture. Shot from a low
three-quarter angle at roughly bench height so the arm reads tall and vertical
in the portrait crop. Sharp focus on the gripper and the cube; the background —
a dim workshop wall and the dark shapes of tools — falls away into soft bokeh.
A short length of servo cable hangs slack in the light.

${ARM}

${STYLE}
`.trim(),
  },
  {
    aspectRatio: "5:4",
    box: "816×696 (split slide, right column, blueprint frame)",
    id: "photo-rig",
    slide: "05 · Plain HTTP, end to end",
    prompt: `
A calm, straight-on technical documentation photograph of the whole rig sitting
on a workbench: the SO-101 arm bolted to its flat plate at the centre of the
frame, at rest in a folded home pose. Beside it on the bench: a cheap USB webcam
on a small black mini-tripod aimed at the arm's workspace, a coil of USB cable
gathered loosely, a small servo-driver board, and a couple of plain unpainted
wooden cubes set out as the task objects. The dark edge of a closed laptop
intrudes at the far right. Shot from standing height looking slightly down, the
bench surface running level across the lower third. Everything is in focus and
laid out clearly, like a photograph taken to show someone exactly what the setup
is. Bright arm and objects against a dark background wall.

${ARM}

${STYLE}
`.trim(),
  },
  {
    aspectRatio: "16:9",
    box: "1920×1080 (full-bleed; copy sits bottom-left under a scrim)",
    id: "photo-arm-bleed",
    slide: "06 · One arm, many hands",
    prompt: `
A wide over-the-shoulder shot of a person driving the SO-101 arm at a crowded
hackathon table. We see only their hands and forearms in dark sleeves, entering
low from the bottom-left corner — no face, no head, no shoulders, the
photographer stands behind them. BOTH hands stay down on the laptop: fingers on
the keys of an open dark laptop whose screen we see only edge-on and out of
focus. Nothing is raised, nothing waves, nothing points — the hands are working,
quiet and still, the way someone's hands sit when they are concentrating.
The SO-101 stands on the same table in the upper right third of the frame,
several feet away and clearly separate from the hands, caught mid-motion with
its gripper closed on a small unpainted wooden cube it has just lifted a few
centimetres off the table. The arm is brightly lit and the sharpest thing in the
picture. Behind it, the deep bokeh of a busy event hall: rows of tables,
scattered dark laptop shapes, standing figures reduced to soft silhouettes,
strings of overhead lights as round highlights. The table surface across the
bottom-left of the frame is dark, plain and empty. Documentary, unposed, caught
rather than arranged.

${ARM}

${STYLE}
`.trim(),
  },
];

const args = Bun.argv.slice(2);
const force = args.includes("--force");
const onlyArg = args.find((a) => a.startsWith("--only="))?.split("=")[1];

await mkdir(OUT_DIR, { recursive: true });

let failures = 0;
for (const shot of SHOTS) {
  if (onlyArg !== undefined && onlyArg !== shot.id) continue;

  const already = Object.values(EXT)
    .map((ext) => path.join(OUT_DIR, `${shot.id}.${ext}`))
    .find((p) => existsSync(p));
  if (already !== undefined && !force) {
    console.log(`· ${shot.id} — exists, skipping (--force to regenerate)`);
    continue;
  }

  console.log(`→ ${shot.id} — ${shot.slide} — ${shot.aspectRatio} for ${shot.box}`);
  try {
    const { bytes, mimeType } = await generateImage(shot.prompt, shot.aspectRatio);
    const out = path.join(OUT_DIR, `${shot.id}.${EXT[mimeType] ?? "png"}`);
    await writeFile(out, bytes);
    console.log(`  ✓ ${path.relative(process.cwd(), out)} — ${Math.round(bytes.length / 1024)} KB`);
  } catch (error) {
    failures += 1;
    console.error(`  ✗ ${shot.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failures > 0) process.exit(1);
