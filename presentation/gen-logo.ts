/**
 * Logo concepts — "Proof of Hands": a human hand touching a robot.
 *
 * These are generated as RASTER stand-ins for a vector mark, so every prompt
 * forces the raster to behave like an SVG: pure black on pure white, one even
 * stroke weight, flat, no shading, no background. That way the winner can be
 * run through potrace into a real logo.svg (see trace-logo.sh) and then tint
 * itself with currentColor like the rest of the blueprint system.
 *
 * The hard constraint is legibility at 32px on a slide corner — so each
 * concept is a few bold strokes, not an illustration.
 *
 * Usage:
 *   GEMINI_API_KEY=… bun run presentation/gen-logo.ts              # missing only
 *   GEMINI_API_KEY=… bun run presentation/gen-logo.ts --force
 *   GEMINI_API_KEY=… bun run presentation/gen-logo.ts --only=touch
 *   GEMINI_API_KEY=… bun run presentation/gen-logo.ts --variants=3  # N takes each
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { EXT, generateImage } from "./gemini";

const OUT_DIR = path.join(import.meta.dir, "logo-concepts");

/** Shared constraints — this is what turns a "picture" into a "mark". */
const MARK = `
This is a LOGO MARK, not an illustration and not a photograph.

Render it as flat vector-style line art: pure black (#000000) strokes on a pure
white (#ffffff) background, one single even stroke weight throughout, clean
geometric construction, rounded stroke caps. Absolutely flat — no shading, no
gradients, no hatching, no texture, no drop shadow, no 3D, no perspective
depth, no grey tones, no colour. It must look like a technical/blueprint
pictogram drawn with a single pen.

Composition: one centred mark on an empty white square, with generous even
margin on all four sides. Nothing else in the frame — no text, no letters, no
numbers, no wordmark, no circle border unless described, no background
elements, no decorative flourishes.

Legibility is the whole job: it must still read clearly when shrunk to 32x32
pixels. So use few, bold, confident strokes and a strong clear silhouette.
Simplify aggressively — suggest the hands with the minimum number of lines.
Do NOT render realistic anatomy, individual knuckle wrinkles, fingernails,
or fine detail that would turn to mud when small. Exactly five fingers on any
human hand shown; no extra or missing digits.
`.trim();

type Concept = {
  /** Filename stem and --only key. */
  readonly id: string;
  /** One-line description for the log and the pick list. */
  readonly note: string;
  readonly prompt: string;
  /**
   * Optional explicit direction per take, used by --variants=N instead of the
   * generic "find another arrangement" nudge. Spelling the takes out gives a
   * far wider spread than re-rolling the same prompt, and lets a take target a
   * specific failure mode from the previous round.
   */
  readonly takes?: readonly string[];
};

const CONCEPTS: readonly Concept[] = [
  {
    id: "touch",
    note: "The touch — human index finger meeting a robot index finger (Creation of Adam)",
    prompt: `
A human hand entering from the left and a robot hand entering from the right,
seen in profile, reaching toward each other so their extended index fingertips
almost touch at the exact centre of the mark, with a small deliberate gap
between them. The human hand is drawn with soft continuous curves; the robot
hand is drawn with straight segments, square knuckle joints and a visible pivot
circle at each joint, so the two read as organic versus mechanical at a glance.
Both hands are simplified to outlines only. The near-touching fingertips are the
focal point and sit dead centre.`,
  },
  {
    id: "palms",
    note: "Palm to palm — human and robot palms pressed together, mirror symmetry",
    prompt: `
A human hand and a robot hand pressed flat palm-to-palm, fingers pointing
straight up, seen edge-on so the mark is vertically symmetrical about its centre
line. The left half is the human hand: smooth, softly curved outline. The right
half is the robot hand: angular, segmented, with square finger joints and a
small pivot circle at each knuckle. The two meet along a single clean vertical
seam down the middle. Simplified to outlines only, tall and centred.`,
  },
  {
    id: "grip",
    note: "The grip — a human hand clasping a robot gripper's two jaws",
    prompt: `
A human hand and a robot hand clasped together in a handshake, seen from the
side. The human hand comes in from the lower left; the robot side is a simple
two-jaw parallel gripper — two straight flat fingers — closing around the human
hand from the upper right. Their overlap at the centre is the focal point, drawn
so it is instantly clear which form is flesh and which is machine: the human
outline curves, the gripper is all straight lines and right angles with one
pivot circle at its hinge. Simplified to outlines only.`,
  },
  {
    id: "split",
    note: "Split hand — one hand, left half human, right half mechanical",
    prompt: `
A SINGLE open hand seen flat palm-forward, fingers pointing up, thumb out to the
left — the ordinary "hand" pictogram silhouette. A straight vertical line runs
down the middle of it, dividing it into a human left half and a mechanical right
half. Left of that line the hand is drawn with soft continuous curves. Right of
it the same hand is rebuilt as a machine: each finger is a stack of two straight
segments with a small square knuckle block and a pivot dot between them.

THE CRITICAL PART — the previous attempt failed exactly here, so read carefully:

- The hand has ONE single unbroken outer outline that encloses the whole shape,
  left half and right half together, and it CLOSES at the bottom across the
  wrist. The outline never stops or opens up at the centre line.
- There is ONE palm, a single continuous closed shape spanning both halves. The
  centre line is a line drawn ON TOP OF that palm — it is a change of styling,
  NOT a place where the drawing stops.
- All five fingers are attached to that one palm along its top edge. None of them
  float free, none are detached rods, and none run off the bottom of the frame.
- Left fingers and right fingers are the SAME length, SAME width and SAME
  splayed spacing, so the two halves line up as one hand. Only the interior
  detail differs between them.
- Exactly five fingers total, counting the thumb, all clearly joined to the palm.

Think of it as a normal hand pictogram with mechanical panelling drawn inside its
right half — not two different objects placed side by side.`,
    takes: [
      "Take 1: split exactly down the geometric centre — the middle finger itself is halved, human on its left edge, mechanical on its right.",
      "Take 2: put the seam in a finger gap instead of through a finger — thumb, index and middle stay fully human, ring and little finger are fully mechanical, all five still on the one shared palm.",
      "Take 3: make it as bold and reduced as possible. Very heavy strokes, no interior lines at all on the human half, and only THREE marks on the mechanical half — one square knuckle block per finger. It must survive being shrunk to 20 pixels.",
      "Take 4: draw the mechanical half as a thin exoskeleton frame fitted over that half of the hand — straight rails following the finger outlines with a pivot dot at each joint — while the human hand outline stays complete and unbroken underneath, visible through it.",
    ],
  },
  {
    id: "teach",
    note: "The teach — a human hand cupped above a robot gripper holding a cube",
    prompt: `
A human hand, seen from the side, held open and cupped above a robot gripper
that is holding a small square block. The human hand is at the top of the mark,
palm down, guiding but not touching. Below it, a simple two-jaw parallel gripper
grips a plain square from either side. A single short straight line runs down
from the gripper's hinge as its wrist. The human hand curves; the gripper and
the square are strictly straight lines and right angles. The vertical stack —
hand above, gripper and square below — is the composition. Simplified to
outlines only, centred.`,
  },
  {
    id: "proof",
    note: "The proof — fingertips touching, with a fingerprint whorl in the human palm",
    prompt: `
A human hand from the left and a robot hand from the right, meeting at the
centre with index fingertips touching. Set into the human hand's palm is a
simple concentric fingerprint whorl — three or four smooth nested curves, no
more, drawn in the same stroke weight — reading as identity and verification.
The robot hand is angular with square joints and pivot circles at the knuckles.
The mark should say "a verified human touched this machine". Simplified to
outlines only, centred, with the fingerprint clearly legible as a spiral rather
than as noise.`,
  },
  {
    id: "seal",
    note: "The seal — touching fingertips inside a technical circle with registration ticks",
    prompt: `
A perfect thin circle enclosing the mark, like an engineering stamp or approval
seal. Inside the circle, drawn small and centred: a human fingertip entering
from the left and a robot fingertip entering from the right, touching at the
exact centre of the circle. The robot finger is angular with one square joint
and a pivot circle; the human finger is a smooth curve. On the circle itself,
four short straight registration tick marks at the top, bottom, left and right,
crossing the circle line — technical drawing datum marks. Everything in one even
stroke weight. No text anywhere inside or outside the circle.`,
  },
];

const args = Bun.argv.slice(2);
const force = args.includes("--force");
const onlyArg = args.find((a) => a.startsWith("--only="))?.split("=")[1];
const variants = Number(args.find((a) => a.startsWith("--variants="))?.split("=")[1] ?? "1");

await mkdir(OUT_DIR, { recursive: true });

let failures = 0;
for (const concept of CONCEPTS) {
  if (onlyArg !== undefined && onlyArg !== concept.id) continue;

  for (let v = 1; v <= variants; v += 1) {
    // Single-variant runs keep the bare id so filenames stay stable/quotable.
    const stem = variants === 1 ? concept.id : `${concept.id}-${v}`;
    const already = Object.values(EXT)
      .map((ext) => path.join(OUT_DIR, `${stem}.${ext}`))
      .find((p) => existsSync(p));
    if (already !== undefined && !force) {
      console.log(`· ${stem} — exists, skipping (--force to regenerate)`);
      continue;
    }

    // Vary the prompt per take rather than seeding — scripts have no RNG.
    // Explicit `takes` win; otherwise fall back to a generic re-arrangement.
    const direction = concept.takes?.[v - 1];
    const nudge =
      direction !== undefined
        ? `\n\n${direction}`
        : v === 1
          ? ""
          : `\n\nTake ${v}: keep the same idea but find a different, simpler arrangement of it.`;
    console.log(`→ ${stem} — ${concept.note}`);
    try {
      const { bytes, mimeType } = await generateImage(
        `${concept.prompt.trim()}\n\n${MARK}${nudge}`,
        "1:1"
      );
      const out = path.join(OUT_DIR, `${stem}.${EXT[mimeType] ?? "png"}`);
      await writeFile(out, bytes);
      console.log(`  ✓ ${path.relative(process.cwd(), out)} — ${Math.round(bytes.length / 1024)} KB`);
    } catch (error) {
      failures += 1;
      console.error(`  ✗ ${stem}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

if (failures > 0) process.exit(1);
