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

import { EXT, generateImage, MODELS, type ModelKey } from "./gemini";

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

AVOID THE OBVIOUS. Do not draw any of these, in any form: a broken chain, a
snapped shackle or manacle, a hand enclosed in a circle or ring, a globe, a
world map, a circuit board, a brain, a lightbulb, a rocket, a fist, or a
handshake between a human hand and a chrome android hand. Those are the first
things everyone draws for this kind of brief and every one of them is generic.
The mark should be something you could only have drawn for THIS product.
`.trim();

/**
 * Constraints for FLAT-COLOUR marks. Same job as MARK, but the output is solid
 * colour areas rather than strokes, because trace-color.py separates the image
 * by colour and runs potrace once per layer — so every region has to be one
 * flat, unmodulated hue with a clean edge or the separation smears.
 */
const MARK_COLOUR = `
This is a LOGO MARK in FLAT COLOUR — not an illustration, not a painting, not a
photograph.

Render it as flat vector artwork: solid areas of colour with clean, crisp edges.
Absolutely flat — no gradients, no shading, no highlights, no gloss, no
airbrushing, no texture, no hatching, no drop shadows, no 3D, no bevels, no
anti-aliased fades between colours. Every single shape is ONE solid colour from
edge to edge, like cut paper or a screen print.

Composition: one centred mark, with generous even margin on all four sides.
Nothing else in the frame — no text, no letters, no numbers, no wordmark, no
border, no background pattern, no decorative flourishes.

Legibility is the whole job: it must still read clearly when shrunk to 40x40
pixels. Few, big, confident shapes. No fine detail, no anatomical detail, no
fingernails, no knuckle wrinkles, no veins, no screw heads. Exactly five fingers
on any human hand; no extra or missing digits.
`.trim();

/** The "Worker" palette — warm human, cool machine, hot rupture. */
const PALETTE_WORKER = `
PALETTE — use these colours and absolutely no others:
  background: solid #E4E8ED (pale blue-grey)
  the worker's arm and fist: solid #C0552B (terracotta)
  the robot arm, its joints and its gripper: solid #3E6183 (steel blue)
  the chain links: solid #1C2530 (near-black ink)
  the burst rays at the break: solid #E3A008 (amber)
Every area is ONE flat, unmodulated colour, edge to edge.`.trim();

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
  /**
   * Photographs handed to the model alongside the prompt, as construction
   * reference. Paths are relative to this directory.
   */
  readonly references?: readonly string[];
  /** Use the flat-colour constraints instead of the black-line-art ones. */
  readonly colour?: boolean;
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
  // ── "Hands Unchained", round 2 ─────────────────────────────────────────────
  // Round 1 (the hu-* set below) was rejected, correctly: it drew the DICTIONARY
  // meaning of "unchained" — shackles, snapped links, freedom — which is what
  // every brand with that word draws. This set starts from the product instead.
  //
  // The wedge, in the pitch's own words: Tesla and Figure pay teleoperators
  // "$25-48/hr ON-SITE", and this makes it work for "any verified human
  // ANYWHERE". So unchained means unchained from PLACE. The hand is not in the
  // room with the robot, and nothing runs between them. That — plus "one arm,
  // many hands" and the graded episode as the unit of work — is the material.
  {
    id: "hu2-echo",
    note: "One gesture made twice — a human hand and the machine copying it",
    prompt: `
A human hand seen flat palm-forward, fingers up, thumb out to the left, drawn as
a bold clean outline. Offset a short distance up and to the right, partially
overlapping it like a shadow or an echo, is THE SAME HAND AGAIN in THE SAME
POSE — identical silhouette, identical finger spread, identical proportions —
but built as a machine: straight segments instead of curves, with a small pivot
circle at each knuckle.

The whole idea is repetition: one gesture, performed twice, once by a person and
once by a machine copying them. So the two shapes MUST be the same shape. Do not
draw two different hands, do not change the pose between them, do not make one
larger. Same outline, same angle, same fingers — only the construction differs.
They overlap, so the pair reads as a single motion caught twice rather than as
two separate objects.`,
  },
  {
    id: "hu2-cut-tether",
    note: "The robot still follows the hand with nothing connecting them",
    prompt: `
On the left, a human hand seen from the side, fingers curled as if closing on
something. On the right, a robot two-jaw gripper curled to EXACTLY the same
degree, in the same pose, mirroring the hand's shape.

Between them runs a cable. It leaves the human wrist, travels toward the
gripper — and is CUT clean through in the middle. Its two cut ends hang apart
with a clear, obvious gap between them, each end drooping slightly, loose and
unattached.

The point: the machine is still copying the hand exactly, even though the thing
that used to connect them has been cut and nothing bridges the gap. Make the
severed gap unmistakable and make the two poses obviously identical. The cable
should read as a limp cut cord, not as a chain and not as a lightning bolt.`,
    takes: [
      `Take 1: arrange it SQUARE, not wide. The human hand sits in the upper left,
seen from the side with its fingers OPEN and spread. The robot gripper sits in
the lower right, its two jaws OPEN to exactly the same angle as the hand's
fingers. The cut cable runs diagonally between them, from the hand's wrist down
toward the gripper, severed in the middle with a clear gap and two loose
drooping ends. Both are open — the poses must match.`,
      `Take 2: stack it VERTICALLY. The human hand at the top, seen from the side,
fingers curled as if pinching. The robot gripper directly below it, jaws curled
to exactly the same degree in the same pinching shape, like a reflection. The cut
cable runs straight down between them and is severed in the middle, its two ends
hanging apart with an obvious gap. Compact and square overall.`,
      `Take 3: keep it horizontal but make it TIGHT and square-ish. Human hand on
the left and robot gripper on the right, both closed to exactly the same degree —
if the hand is a closed grip, the gripper's jaws are shut to match. Push the two
forms close together and make the severed cable short, so the whole mark is
nearly as tall as it is wide. The cut in the cable stays the most obvious thing
between them.`,
    ],
  },
  {
    id: "hu2-shared-grip",
    note: "The unit of work — a person and a machine holding the same object",
    prompt: `
A small square block sits at the exact centre of the mark. Gripping it from the
left is a human hand, seen from the side, its fingers curled over the block's
left face. Gripping it from the right is a robot two-jaw gripper, its two
straight jaws closed on the block's right face.

Both hold the same block, at the same moment, with equal weight — the hand and
the gripper are the same visual size and the composition is balanced left and
right about the block. The human side is drawn with curves, the machine side
with straight lines and one pivot circle at its hinge.

Nothing else in the frame. No arms, no wrists beyond a short stub, no table, no
background. Three elements only: hand, block, gripper.`,
  },
  {
    id: "hu2-many-hands",
    note: "One arm, many hands — the crowd, from the deck's own slide title",
    prompt: `
A single robot two-jaw gripper at the bottom centre of the mark, seen from the
side, pointing upward, holding a small square block.

Arranged above it in a fan, like spokes radiating from that gripper, are five
simplified human hands — small, flat, identical silhouettes — all reaching
inward and downward toward the one gripper. They are evenly spaced across the
upper half, each angled so its fingers point at the gripper.

The idea is many separate people converging on one machine. So the hands must be
plainly separate from each other, identical to one another, and clearly smaller
than the gripper. Keep every hand to a simple mitten-like silhouette with a
thumb — no interior detail whatsoever, or this will not survive being shrunk.`,
  },
  {
    id: "hu2-one-line",
    note: "A single unbroken stroke: human hand at one end, gripper at the other",
    prompt: `
A single continuous unbroken line of constant thickness, drawn as though in one
stroke without lifting the pen.

It begins at the lower left as a human hand — thumb, fingers, wrist, drawn with
soft curves. The very same line then continues, straightens out, and becomes a
robot arm: two straight segments with a pivot circle at their elbow, ending at
the upper right in a simple two-jaw gripper.

There must be NO break, NO gap and NO separate pieces anywhere: one contour runs
the whole way, flesh at one end, machine at the other, and you cannot say
exactly where one becomes the other. The line's thickness never changes. This is
one object, not two joined together.`,
  },
  {
    id: "hu2-chain-of-hands",
    note: "A chain whose links are arms clasped wrist to wrist, last link open",
    prompt: `
A horizontal chain running left to right, in which every link is made of PEOPLE
rather than metal. Each link is a closed loop formed by two forearms clasping
each other wrist to wrist — the way people grip each other's forearms — so each
loop is an oval made of two hands and two arms.

Three such loops interlock in a row, exactly like the links of a chain.

The loop at the right-hand end is OPEN: its last hand is unclasped, fingers
spread, reaching out into empty space, so that another hand could take it and
extend the chain.

Draw each hand and arm with the absolute minimum — a couple of strokes each. The
oval loop shape of every link must be the thing you see first, and the chain must
read as a chain at a glance before you notice it is made of arms.`,
  },
  {
    id: "nb-picto2",
    note: "Pictogram, refined — no photo reference (it leaked in elsewhere)",
    colour: true,
    prompt: `
A LOGO MARK: a worker's arm on the LEFT and a LeRobot SO-101 robot arm on the
RIGHT, hauling a short chain apart between them, the chain snapping at the
centre.

DRAW IT AS A PICTOGRAM IN THE ISOTYPE / OTL AICHER TRADITION — the visual
language of Otto Neurath's Isotype charts and Aicher's Munich 1972 Olympic
pictograms. This instruction outranks everything else here. It means:

- Every form is assembled from ONE SMALL KIT of primitives: constant-width bars
  with rounded ends, circles, squares, rounded rectangles. Nothing else exists
  in this drawing.
- Every angle in the mark is 0, 45 or 90 degrees. No arbitrary angles anywhere.
- Limbs are BARS. The worker's upper arm is one bar; the forearm is a second bar
  of identical thickness; they meet at a clean 90-degree elbow. The bicep is a
  single smooth swelling of the upper-arm bar — one convex curve, nothing more.
- The fist is a single rounded block on the end of the forearm bar, with NO
  separate fingers, no knuckles, no thumb.
- There is NO anatomy: no muscle striation, no veins, no fingernails, no
  wrinkles, no interior lines of any kind.
- If a shape cannot be built from bars, circles and squares, simplify it until
  it can. The system matters more than the likeness.

THE SO-101 IS DRAWN FROM THE SAME KIT — bars of exactly the same thickness as
the worker's arm, a SQUARE at every joint, and a gripper of two short bars. The
real arm genuinely is flat brackets and square servo blocks — so worker and machine end up
drawn from the same alphabet. That is the point of
the mark.

THE CHAIN: a short level row of identical thick rounded-rectangle links running
between the two fists. At the exact centre, one link is torn into two halves
sprung apart with a clean gap between them. Four straight burst rays radiate
from that gap at 45-degree intervals.

COMPOSITION: symmetrical about the vertical centre line. The worker's arm enters
from the left edge and the robot arm from the right edge, both cropped by the
frame. Same size, same visual weight — a fair contest. The mark FILLS the frame
edge to edge: no wasted margin, no small figure floating in a void.
${PALETTE_WORKER}`,
    takes: [
      `Take 1: exactly as specified above.`,
      `Take 2: bigger and tighter. Scale both arms up so they nearly touch the top
and bottom of the frame, and shorten the chain so the two fists come closer
together. More compact, more forceful, less air.`,
      `Take 3: give the robot arm ONE more bar segment so it reads unmistakably as a
jointed ARM rather than a stub — a shoulder bar, an elbow square, a forearm bar,
a wrist square, then the two-bar gripper. Keep the worker's arm and everything
else exactly as specified.`,
    ],
  },
  {
    id: "nb-pictogram",
    note: "Isotype / Otl Aicher pictogram discipline",
    references: ["originals/photo-rig.jpg"],
    colour: true,
    prompt: `
A LOGO MARK: a worker's arm on the LEFT and a LeRobot SO-101 robot arm on the
RIGHT, hauling a short chain apart between them, the chain snapping at the
centre.

DRAW IT AS A PICTOGRAM IN THE ISOTYPE / OTL AICHER TRADITION — the visual
language of Otto Neurath's Isotype charts and Aicher's Munich 1972 Olympic
pictograms. This instruction outranks everything else here. It means:

- Every form is assembled from ONE SMALL KIT of primitives: constant-width bars
  with rounded ends, circles, squares, rounded rectangles. Nothing else exists
  in this drawing.
- Every angle in the mark is 0, 45 or 90 degrees. No arbitrary angles anywhere.
- Limbs are BARS. The worker's upper arm is one bar; the forearm is a second bar
  of identical thickness; they meet at a clean 90-degree elbow. The bicep is a
  single smooth swelling of the upper-arm bar — one convex curve, nothing more.
- The fist is a single rounded block on the end of the forearm bar, with NO
  separate fingers, no knuckles, no thumb.
- There is NO anatomy: no muscle striation, no veins, no fingernails, no
  wrinkles, no interior lines of any kind.
- If a shape cannot be built from bars, circles and squares, simplify it until
  it can. The system matters more than the likeness.

THE SO-101 IS DRAWN FROM THE SAME KIT — bars of exactly the same thickness as
the worker's arm, a SQUARE at every joint, and a gripper of two short bars. The
real arm genuinely is flat brackets and square servo blocks (see the attached
photograph for its construction only — not its lighting, colour or background),
so worker and machine end up drawn from the same alphabet. That is the point of
the mark.

THE CHAIN: a short level row of identical thick rounded-rectangle links running
between the two fists. At the exact centre, one link is torn into two halves
sprung apart with a clean gap between them. Four straight burst rays radiate
from that gap at 45-degree intervals.

COMPOSITION: symmetrical about the vertical centre line. The worker's arm enters
from the left edge and the robot arm from the right edge, both cropped by the
frame. Same size, same visual weight — a fair contest. The mark FILLS the frame
edge to edge: no wasted margin, no small figure floating in a void.
${PALETTE_WORKER}`,
  },
  {
    id: "nb-screenprint",
    note: "Hand-pulled industrial screen print, poster weight",
    references: ["originals/photo-rig.jpg"],
    colour: true,
    prompt: `
A LOGO MARK: a worker's arm on the LEFT and a LeRobot SO-101 robot arm on the
RIGHT, hauling a chain apart between them, snapping at the centre.

DRAW IT AS A HAND-PULLED INDUSTRIAL SCREEN PRINT — the register of a mid-century
workshop or labour-union poster. Forms are MASSIVE, blunt and reduced to
silhouettes, cut from flat colour with crisp confident edges, made to be read
across a room. Heavy over delicate, every time. No line work, no outlines: the
shapes ARE the drawing, defined by where one flat colour meets another.

The worker's arm is a huge solid silhouette — bent at the elbow, fist clenched,
bicep swollen — filling the left half of the frame. The SO-101 is an equally
massive silhouette filling the right half: thick flat bracket slabs, big square
joints, a blunt two-bar gripper. They are evenly matched.

Between them, a thick heavy chain, bar-taut, its middle link torn apart at the
exact centre with bold burst rays firing out of the gap.

The composition is edge to edge and almost brutal in its simplicity. Nothing
delicate survives in this medium — if a detail would not print, it is not there.
The SO-101's construction is in the attached photograph; use it for the
hardware's shape only, never its lighting, colour or setting.
${PALETTE_WORKER}`,
  },
  {
    id: "nb-minimal",
    note: "Maximum reduction — a Vignelli-grade mark, eight shapes",
    colour: true,
    prompt: `
A LOGO MARK reduced to the FEWEST POSSIBLE SHAPES: a worker's arm and a robot
arm hauling a chain apart, the chain snapping between them.

This is an exercise in subtraction, in the discipline of Massimo Vignelli or Paul
Rand — nothing may remain that could be removed without the meaning collapsing.

HARD BUDGET: at most EIGHT shapes in the entire mark. Count them as you draw.
A workable budget is: two bars for the worker's arm, one block for the fist, two
bars for the robot arm, one square for its joint, and two torn link-halves with
a gap between them. The break may be carried by the gap alone, or by at most
four short rays if they fit inside the budget.

Absolutely no detail. No fingers, no servo screws, no bracket panels, no extra
chain links. If a viewer at arm's length cannot instantly read
"arm — chain — break — machine", simplify differently. Never add.

The shapes are big, flat and confident, and they fill the frame.
${PALETTE_WORKER}`,
  },
  {
    id: "nb-refine",
    note: "Image-to-image: refine the best colour mark, do not redesign it",
    references: ["logo-concepts/hu6-colour-1.jpg"],
    colour: true,
    prompt: `
The attached image is a logo mark I want REFINED, not redesigned. Keep its
composition, its palette and its idea exactly. Redraw it with these specific
corrections and no others:

1. The robot arm on the right is too thin and sprawls across the frame. Make it
   as visually HEAVY as the worker's arm: thicker bracket bars, larger square
   joints, and FEWER parts — delete any bracket not needed to read as an arm.
2. The chain links are too thin. Roughly double their thickness so they carry
   the same weight as the two arms.
3. The burst at the break is too small and timid. Make the rays about twice as
   long and clearly thicker.
4. Fill the frame. Scale the whole mark up so it reaches nearer the edges, and
   remove the empty bands across the top and bottom.
5. Remove every small interior line inside the fist and the bicep — they should
   be plain solid shapes with no detail drawn on them.

Everything else — the poses, the colours, the left/right arrangement, the flat
style — stays exactly as it is.
${PALETTE_WORKER}`,
  },
  {
    id: "hu6-colour",
    note: "The face-off in flat colour — four palettes",
    references: ["originals/photo-rig.jpg"],
    colour: true,
    prompt: `
A powerful MUSCULAR HUMAN ARM on the LEFT and a LeRobot SO-101 robot arm on the
RIGHT, facing each other, hauling in opposite directions on a short chain strung
between them, at the instant the chain SNAPS.

Cropped close and drawn BIG: only the clenched fist and thick forearm enter from
the left, only the gripper and one bracket segment enter from the right. Both
fill their halves. Few elements, all of them large.

THE HUMAN SIDE IS AN ARM, NOT A HAND — clenched fist, thick forearm, bent elbow,
bulging bicep, visibly heaving. A worker's arm: heavy and blunt. Draw it as one
solid silhouette of flat colour; suggest the bicep with a single clean edge, not
with shading.

THE TWO SIDES ARE EVENLY MATCHED — same visual weight, same size. A fair contest
between equals, not a machine overpowering a person.

THE BREAK is dead centre and is the focal point: the middle link torn into two
halves, rotated outward, a clear gap between them, with four or five short
straight burst rays radiating outward. The burst rays are structure, not
decoration. The chain is bar-taut on both sides — rigid straight runs, no sag.
Two links each side plus the snapped one.

THE ROBOT ARM MUST BE A LeRobot SO-101 (SO-ARM101) — see the attached
photograph for construction. Flat 3D-printed bracket plates with square-cut
ends, never smooth tubes; a plain SQUARE SERVO BLOCK at every joint; and a
simple PARALLEL-JAW gripper of exactly two straight flat fingers clamped on the
chain. The photograph is reference for CONSTRUCTION ONLY — do not copy its
lighting, colour, background or props.`,
    takes: [
      `PALETTE — use these colours and absolutely no others:
  background: solid #E4E8ED (pale blue-grey)
  the human arm and fist: solid #C0552B (terracotta)
  the robot arm, its servo blocks and gripper: solid #3E6183 (steel blue)
  the chain links: solid #1C2530 (near-black ink)
  the burst rays at the break: solid #E3A008 (amber)
Warm human, cool machine, hot rupture. Four colours plus the background, each
one flat and unmodulated.`,
      `PALETTE — use these colours and absolutely no others:
  background: solid #E4E8ED (pale blue-grey)
  the human arm and fist: solid #1C2530 (near-black ink)
  the robot arm and gripper: solid #1C2530 (near-black ink)
  the chain links: solid #1C2530 (near-black ink)
  the burst rays at the break: solid #C8471D (signal orange)
Everything is near-black except the rupture, which is the only colour in the
mark. Two colours plus the background, nothing else.`,
      `PALETTE — use these colours and absolutely no others:
  background: solid #E4E8ED (pale blue-grey)
  the human arm and fist: solid #E0A020 (amber)
  the robot arm and gripper: solid #3E6183 (steel blue)
  the chain links: solid #1C2530 (near-black ink)
  the burst rays at the break: solid #D6402C (hot red)
Bright and high-contrast — the boldest of the four. Four colours plus the
background, each one flat.`,
      `PALETTE — use these colours and absolutely no others:
  background: solid #14171B (near-black)
  the human arm and fist: solid #E8672C (burnt orange)
  the robot arm and gripper: solid #7FA8CC (pale steel blue)
  the chain links: solid #4A5560 (mid grey)
  the burst rays at the break: solid #F0B429 (machine yellow)
A dark ground with the mark glowing on it. Four colours plus the background.`,
    ],
  },
  {
    id: "hu5-strongarm",
    note: "A worker's arm and an SO-101, evenly matched, snapping a chain",
    references: ["originals/photo-rig.jpg"],
    prompt: `
A powerful MUSCULAR HUMAN ARM and a LeRobot SO-101 robot arm, straining against
each other on a chain strung between them, at the instant the chain SNAPS.

THE HUMAN SIDE IS AN ARM, NOT A HAND. Draw a whole bare arm — clenched fist,
thick forearm, bent elbow, and a bulging bicep — visibly heaving. This is a
worker's arm: heavy, blunt and strong. The bicep swells, the forearm is thick
and tapers to a tight fist wrapped around the last link. Suggest the muscle with
AT MOST two short interior curves for the bicep and one for the forearm — never
anatomical shading, never veins, never striations.

THE TWO SIDES ARE EVENLY MATCHED. The robot arm is drawn at the same visual
weight and the same size as the human arm — this is a fair contest of strength
between equals, not a machine overpowering a person or the reverse. Both are
bent at the elbow, both are hauling.

STROKE WEIGHT: noticeably HEAVIER than a normal icon. Thick, blunt, forceful
lines throughout. The mark should feel like it was cut with a chisel.

THE BREAK: the middle link has just given way, its two halves torn apart and
rotated outward with a clear gap between them, and four or five short straight
burst lines radiating from the rupture. Those burst lines are structure, not
decoration — they carry the action. The chain is bar-taut on both sides: rigid
straight runs, no sag.

THE ROBOT ARM MUST BE A LeRobot SO-101 (SO-ARM101). See the attached photograph
for its construction. In line-art terms: flat 3D-printed bracket plates with
square-cut ends, never smooth tubes; a visible SQUARE SERVO BLOCK straddling
every joint (shoulder, elbow, wrist) — the most recognisable feature of this
arm; and a simple PARALLEL-JAW gripper of exactly two straight flat fingers
clamped on the chain. Not a three-fingered claw, not a humanoid hand.

The attached photograph is reference for the ARM'S CONSTRUCTION ONLY. Do not
copy its photographic style, lighting, colour, background or props.

Keep the chain SHORT — two links each side plus the snapped one. Few elements,
drawn big and heavy.`,
    takes: [
      `Take 1: level and symmetrical. The muscular arm enters from the LEFT edge and
the SO-101 from the RIGHT edge, both bent at the elbow, forearms level and facing
each other, the taut chain running straight between their grips and snapping at
the exact midpoint. A mirror: flesh against machine, evenly matched.`,
      `Take 2: both rising from below. The muscular arm comes up out of the BOTTOM
LEFT corner and the SO-101 up out of the BOTTOM RIGHT corner, both angled inward
and upward like two raised arms, the chain stretched between their grips across
the upper middle and snapping at its centre. Heroic and symmetrical.`,
      `Take 3: crop in TIGHT and heavy. Only the clenched fist and thick forearm
enter from the left, only the SO-101's gripper and one bracket segment enter from
the right, both drawn LARGE and filling their halves. Between them the snapping
link is big and central with its burst. Very few elements, all of them huge —
this version must survive being shrunk to 32 pixels.`,
      `Take 4: diagonal. The muscular arm hauls up from the LOWER LEFT, the SO-101
braces at the UPPER RIGHT, the taut chain on the diagonal between them snapping
at its midpoint.`,
      `Take 5: the flex. The human arm is bent hard at the elbow with the bicep
clearly flexed and the fist high, dominating the LEFT half of the mark; the
SO-101 mirrors that bend on the RIGHT, its gripper high. The chain runs low
between them, below both elbows, and snaps at the bottom centre.`,
      `Take 6: vertical. The muscular arm reaches DOWN from the top of the mark, fist
clenched on the chain; the SO-101 stands on its base plate at the bottom with its
gripper reaching UP; the chain runs straight up and down between them and snaps
in the middle.`,
    ],
  },
  {
    id: "hu4-snap",
    note: "The instant it gives — hand + a real SO-101 hauling a chain apart",
    // The deck's own rig photograph goes in as construction reference: words
    // alone kept producing a generic claw, and this also makes the mark and the
    // photography agree about what the hardware looks like.
    references: ["originals/photo-rig.jpg"],
    prompt: `
A human hand and a LeRobot SO-101 robot arm hauling in opposite directions on a
chain strung between them, drawn at the exact instant the chain SNAPS.

THE BREAK IS THE SUBJECT. The middle link has just given way: its two halves are
torn apart, each half rotated outward and recoiling from the other, with a clear
gap opening between them. Radiating from that point of rupture are four or five
short straight burst lines — the standard pictogram convention for something
snapping. Those burst lines ARE wanted here: they carry the action, so treat
them as structure, not as decoration.

TENSION EVERYWHERE. The chain is bar-taut — perfectly straight rigid runs of
links on each side, no sag, no droop, no lazy curve. The hand and the arm both
lean hard away from the centre, angled outward, caught mid-heave. The whole mark
must read as one violent instant, not as a broken chain lying still.

The human hand: seen from the side, fingers wrapped tight around the last link
on its side, on a short wrist stub, drawn with soft curves.

THE ROBOT ARM MUST BE A LeRobot SO-101 (SO-ARM101), not a generic industrial
robot. See the attached photograph for its construction. In line-art terms:
- A small DESKTOP arm built from flat 3D-printed brackets, so every segment is a
  flat straight plate with square-cut ends — never a smooth tapering tube, never
  a curved factory manipulator.
- At EVERY joint there is a visible SQUARE SERVO BLOCK, drawn as a plain square
  straddling the joint. This is the single most recognisable feature of this arm.
  Three of them: shoulder, elbow, wrist.
- It ends in a simple PARALLEL-JAW gripper: exactly two straight flat fingers,
  one above the other, closing like pliers. Not a three-fingered claw, not a
  humanoid hand, not a suction cup.
- It rises from a short vertical base column standing on a flat rectangular BASE
  PLATE.
- Proportions: short base, one long upper segment, one shorter forearm.

The attached photograph is reference for the ARM'S CONSTRUCTION ONLY. Do not
copy its photographic style, lighting, colour, background, bench, cables or
props. The output is flat black line art on white, exactly as specified below.

Two whole links on each side plus the snapped one in the middle — five link
shapes total. Everything heavy and bold.`,
    takes: [
      `Take 1: a taut V. The hand hauls up and away to the UPPER LEFT, the SO-101
stands to the UPPER RIGHT with its gripper clamped on the chain, and the two
straight runs of chain meet at the snapping link at the bottom vertex, dead
centre and low. Symmetrical and square.`,
      `Take 2: a horizontal tug-of-war. Hand on the left, SO-101 on the right, the
chain bar-taut and level between them, snapping at the exact midpoint. Both
lean back away from the centre. Push them close so the mark stays compact.`,
      `Take 3: make the BREAK the hero. Crop in close: only the human fingers enter
from the left edge and only the SO-101's gripper jaws enter from the right edge,
both small. The snapping link is LARGE and dead centre, filling the middle of
the mark, its two halves torn apart with the burst lines around it. The rupture
should occupy roughly half the width of the whole mark.`,
      `Take 4: diagonal. The hand hauls from the LOWER LEFT, the SO-101 stands at
the UPPER RIGHT, the taut chain running the diagonal between them and snapping
at its midpoint. Fills a square corner to corner.`,
      `Take 5: a wide, hard stance. Like the V but far more extreme — the hand and
the SO-101 are pulled right out to the left and right edges, leaning steeply
away, and the chain between them is stretched almost straight and level with the
snap at the centre. Maximum tension.`,
      `Take 6: vertical. The human hand at the TOP hauling upward, the SO-101 below
it on its base plate with the gripper hauling DOWN, the chain straight and
vertical between them, snapping in the middle. Tall and symmetrical.`,
    ],
  },
  {
    id: "hu3-break",
    note: "Human hand and robot arm breaking a chain between them",
    prompt: `
A human hand on the LEFT and a robot arm on the RIGHT, each gripping one end of
a short heavy chain that runs between them, hauling in opposite directions — and
at the exact centre of that chain the middle link has SNAPPED. Its two broken
halves are parted, pulled away from each other, with a clear open gap between
them.

The human hand: seen from the side, fingers closed around the last link on its
side, drawn with soft continuous curves, on a short wrist stub.
The robot arm: unmistakably a machine — two straight rigid segments with a pivot
circle at the elbow joint, ending in a two-jaw gripper clamped shut on the last
link on its side.

Keep the chain SHORT: two whole oval links on each side plus the snapped one in
the middle. Five link shapes total, no more. Everything heavy and bold.

The snap at dead centre is the focal point and must be unmistakable — two parted
halves of a broken ring, clearly the two ends of something that has just given
way. Not a dotted line, not a gap in a plain line, not a lightning bolt.

Both sides are pulling: the hand and the arm lean away from the centre, the
chain is taut, the whole thing reads as one shared effort that has just
succeeded.`,
    takes: [
      `Take 1: straight and horizontal. Hand and arm face each other across a level
chain, the break dead centre. Push them close together so the mark is compact
rather than a wide strip.`,
      `Take 2: diagonal. The human hand grips from the LOWER LEFT and the robot arm
from the UPPER RIGHT, the taut chain running on the diagonal between them with
the snap at the middle of that diagonal. This should fill a square well.`,
      `Take 3: a V. The human hand pulls up and away to the UPPER LEFT, the robot arm
pulls up and away to the UPPER RIGHT, and the chain hangs between them in a
shallow V — the snapped link is at the bottom vertex of the V, dead centre and
low. Symmetrical, square, and full of tension.`,
      `Take 4: vertical. The human hand at the TOP pulling upward, the robot arm at
the BOTTOM pulling downward, the chain running straight up and down between them
with the snap at the middle. Tall, symmetrical, square-ish.`,
    ],
  },
  // ── "Hands Unchained", round 1 (rejected — kept for reference) ──────────────
  // The rename breaks the old mark: a hand inside an exoskeleton frame reads as
  // a hand in a CAGE, which is the exact opposite of "unchained". These all
  // resolve that, and most of them keep a real chain link in the frame — open,
  // not absent — so the name reads "the chain is open to anyone" rather than
  // "we are not on a blockchain".
  {
    id: "hu-open-link",
    note: "Hand through a sprung-open chain link",
    prompt: `
A single open hand seen flat palm-forward, fingers up, thumb out to the left,
drawn as one bold simple closed silhouette. Encircling its wrist is one large
chain link — a thick oval ring — that has SPRUNG OPEN: there is a clear, wide,
unmistakable gap in the ring where it has parted, and its two cut ends are drawn
slightly pulled away from each other. The hand rises freely up through the
opening; the ring does not touch or overlap the fingers.

The open gap is the whole idea and must be the most obvious feature after the
hand itself — make it wide and place it clearly, not hidden behind the wrist.
The ring is a chain link, not a bracelet: thick, oval, heavy.`,
  },
  {
    id: "hu-unclasp",
    note: "The exoskeleton mark, frame hinged open and swung clear of the hand",
    prompt: `
A single open hand seen flat palm-forward, fingers up, thumb out to the left,
drawn as one bold closed silhouette with a completely empty interior. Beside it,
a thin mechanical frame — straight rails with small pivot circles at their
joints, shaped to match the hand's fingers — that WAS clamped over the hand's
right half and has now been RELEASED: it is hinged at a single pivot down at the
wrist and swung open away from the fingers, rotated clear to the right, with an
obvious empty gap between the frame and the hand it used to hold.

The reading must be unmistakable: the hand is free, the machine that held it is
hanging open beside it, still attached at one point. Like a cuff released, not
like a hand still wearing a glove. Keep the frame simple — three rails, three
pivots at most.`,
  },
  {
    id: "hu-cuff",
    note: "An open manacle, hand passing straight through it",
    prompt: `
A thick open manacle — a heavy C-shaped shackle drawn as two concentric arcs,
with a small hinge circle on one side and its opening gaping wide on the other.
Passing straight through that opening, unimpeded, is a human hand and forearm:
the forearm enters from the lower left, the hand emerges upper right with its
fingers open and relaxed.

The cuff is wide open and the hand plainly is not held by it — there must be
clear space between the hand and both arcs of the shackle. Bold and heavy: the
shackle's stroke should be noticeably thicker than the hand's outline so the two
read as different materials.`,
  },
  {
    id: "hu-break",
    note: "A chain broken mid-run, a hand rising out of the break",
    prompt: `
A short horizontal chain of thick oval links running left to right across the
mark — two whole links on the left, two whole links on the right. In the middle,
where a fifth link should be, the chain is BROKEN: the two facing ends are drawn
as the parted halves of a snapped link, pulled apart with a clear gap between
them. Rising up out of that gap is a human hand, palm forward, fingers open,
reaching upward and clearly taller than the chain.

The chain sits low, across the bottom third. The hand is the tallest element and
the focal point. Keep the links few and heavy — four links total, no more.`,
  },
  {
    id: "hu-five-links",
    note: "Wildcard — the hand's fingers ARE open chain links",
    prompt: `
A hand built entirely out of chain links. The palm is one solid, simple, heavy
rounded shape. Rising from it are four fingers, and each finger is drawn as a
single tall narrow oval chain link standing on end — an elongated ring with a
visible gap in it, so each link is open rather than closed. A fifth open link,
shorter and angled out to the left, serves as the thumb.

It must still read as a hand at a glance — the links are finger-shaped and
finger-placed, in the right proportions and splayed like real fingers, not a
random pile of rings. Bold and heavy throughout.`,
  },
  {
    id: "hu-pass",
    note: "Human hand and robot gripper with an opened link between them",
    prompt: `
A human hand entering from the left, drawn with soft curves, and a simple
two-jaw robot gripper entering from the right, drawn with straight lines and one
pivot circle. Between them, at the centre of the mark, hangs a single thick oval
chain link that has been opened — a clear gap in the ring, its ends parted — as
though it has just been passed from one to the other, or just released them from
each other.

Three elements only, on one horizontal line: hand, open link, gripper. The open
link is dead centre and is the focal point. Keep both hands simple outlines so
the link stays the thing you see first.`,
  },
  {
    id: "mark-small",
    note: "Reduced cut of the chosen mark — for 16-32px (app nav, favicon)",
    prompt: `
The same subject as the chosen mark, drawn as a REDUCTION for very small sizes:
a single open hand seen flat palm-forward, fingers up, thumb out to the left,
with one straight vertical line down its middle and the right half reading as
machine.

This version exists because the detailed mark turns to mud below about 40
pixels. So strip it to the absolute minimum that still says "hand, half of it
machine":

- Very heavy, thick strokes — roughly twice the weight you would normally use.
- The hand silhouette is one bold, closed, simplified shape. Short blunt fingers,
  wide gaps between them, no tapering, no anatomical curve. Closed flat across
  the wrist at the bottom.
- The interior of the human (left) half is completely EMPTY. No lines at all.
- The machine (right) half carries exactly THREE marks and nothing else: three
  solid filled dots, one on each of the three fingers on that side, sitting where
  a knuckle joint would be. Solid filled circles, not outlines, not rings.
- One straight vertical line down the centre of the hand, same heavy weight.
- Nothing else whatsoever. No rails, no exoskeleton frame, no panel seams, no
  tendons, no wrist cuff detail, no extra joints.

It must still be recognisable as a hand at 16x16 pixels. Err on the side of
too bold and too simple.`,
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
// Which Nano Banana to call. Non-default models suffix the filename so the same
// concept can be run across the family and compared side by side.
const modelKey = (args.find((a) => a.startsWith("--model="))?.split("=")[1] ?? "pro") as ModelKey;
if (MODELS[modelKey] === undefined) {
  console.error(`unknown --model=${modelKey}; expected one of ${Object.keys(MODELS).join(", ")}`);
  process.exit(1);
}
const modelSuffix = modelKey === "pro" ? "" : `-${modelKey}`;

await mkdir(OUT_DIR, { recursive: true });

let failures = 0;
for (const concept of CONCEPTS) {
  if (onlyArg !== undefined && onlyArg !== concept.id) continue;

  for (let v = 1; v <= variants; v += 1) {
    // Single-variant runs keep the bare id so filenames stay stable/quotable.
    const stem = (variants === 1 ? concept.id : `${concept.id}-${v}`) + modelSuffix;
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
    console.log(`→ ${stem} — ${concept.note} [${MODELS[modelKey]}]`);
    try {
      const { bytes, mimeType } = await generateImage(
        `${concept.prompt.trim()}\n\n${concept.colour === true ? MARK_COLOUR : MARK}${nudge}`,
        "1:1",
        "2K",
        (concept.references ?? []).map((r) => path.join(import.meta.dir, r)),
        MODELS[modelKey]
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
