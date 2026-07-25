# presentation/

Deck photography for the ETHGlobal Lisbon 2026 pitch deck. Nothing here is
shipped by the app — `railway.toml`'s `watchPatterns` excludes this directory,
so touching it never redeploys the hub.

The deck itself lives in Claude Design:
<https://claude.ai/design/p/6f8cc292-ccbd-4d0b-b5e8-9dfe60c37d0f?file=Proof+of+Hands.dc.html>

`Proof of Hands.dc.html` here is a mirror of that file at the commit where the
photos were wired in — same relative `./images/…` paths as the design project,
so the two stay interchangeable. Edit the deck in Claude Design, not here.

## The three slots

The deck had three empty `<image-slot>` placeholders. Each now carries a
`src` pointing into `images/`:

| slot id | slide | box on the 1920×1080 stage |
|---|---|---|
| `photo-arm-loop` | 04 · The loop we ship | 936×1080 — half-bleed, left half |
| `photo-rig` | 05 · Plain HTTP, end to end | 816×696 — split, right column |
| `photo-arm-bleed` | 06 · One arm, many hands | 1920×1080 — full bleed |

A slot's `src` is a *fallback*: dragging a real photo onto the slot in Claude
Design still overrides it. So when we have actual bench photos of the rig,
drop them in — no code change needed, and these stand in until then.

## The logo

`logo.svg` is the mark: one hand, its right half wearing a teleoperation
exoskeleton. That is not a metaphor — the frame over the fingers is the rig and
the pivots are the joints an operator drives.

It started as generated raster (`logo-concepts/split-4.jpg`) and was traced to
vector with `trace-logo.py`, which turns the black strokes into filled outlines
so the mark takes `fill: currentColor` and tints itself like everything else in
the blueprint system. The deck draws it at **84x84** in the slide corner and
**200x200** on the cover; it is legible at both, but it muds below ~40px, so a
favicon would want a reduced cut rather than this file shrunk.

```sh
python3 presentation/trace-logo.py split-4 --smooth 1.3 --tolerance 0.8 --width 900
```

`--width` is the real quality/size dial: 900 gives 8 KB and is visually
identical to 16 KB at 1200; below ~700 the outline starts to wobble and the
joint circles go polygonal. Requires `potrace` (and `rsvg-convert` if you want
to render the result locally to check it).

**The mark is inlined on all twelve slides, not referenced.** Do not "optimise"
that into a `<symbol>` + `<use>` pair: `deck-stage` treats its direct children
as slides, so a `<defs>`/`<symbol>` block placed there renders as an extra blank
slide at position 1. Twelve copies of an 8 KB path is the deliberate trade.

## Regenerating

Photos and logo concepts both go through `gemini.ts` (Gemini
`gemini-3-pro-image`, no SDK). Prompts live in `gen-images.ts` and
`gen-logo.ts` and are the interesting part: they pin down what an SO-101
actually looks like (3D-printed PLA brackets, Feetech STS3215 servos,
daisy-chained 3-pin cables) so the arm doesn't come back as a generic
industrial robot, and they ban all in-frame text because the deck's `.duotone`
treatment would render any garbled AI lettering in blueprint blue.

```sh
GEMINI_API_KEY=… bun run presentation/gen-images.ts          # missing only
GEMINI_API_KEY=… bun run presentation/gen-images.ts --force  # all
GEMINI_API_KEY=… bun run presentation/gen-images.ts --only=photo-rig
python3 presentation/optimize.py                             # originals/ → images/

GEMINI_API_KEY=… bun run presentation/gen-logo.ts             # seven logo concepts
GEMINI_API_KEY=… bun run presentation/gen-logo.ts --only=split --variants=4
```

For logo concepts, prefer giving a concept explicit `takes[]` in `gen-logo.ts`
over re-rolling the same prompt with `--variants` — spelling each take out is
what produced four genuinely different split-hand answers after the first
attempt failed. That first failure is instructive and the prompt still carries
the fix: the outline stopped at the seam, so the mechanical half had no palm and
its fingers came back as detached floating rods.

- `originals/` — full 2K frames as generated (keep: useful for the video).
- `images/` — downscaled to 2× each slot's box, ~200–900 KB. These are what
  the deck loads.

Re-run `optimize.py` after any regeneration, then re-upload `images/` and the
deck HTML to the design project.

## Why the photos look like that

The deck wraps every photo in `.duotone`, which paints `--color-accent` over it
with `mix-blend-mode: color` — the image keeps its **luminance** and loses its
hue entirely. So the prompts chase tonal separation (bright subject, dark
ground) and ignore colour completely.

On slide 06 the copy sits bottom-left under `.bleed-scrim`, a near-opaque
`--color-bg` fade. That frame is composed with the arm up in the right third
and the table left dark and empty, so the scrim has somewhere quiet to land.
