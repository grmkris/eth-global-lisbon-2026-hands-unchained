# presentation/

Deck photography for the ETHGlobal Lisbon 2026 pitch deck. Nothing here is
shipped by the app — `railway.toml`'s `watchPatterns` excludes this directory,
so touching it never redeploys the hub.

The deck itself lives in Claude Design:
<https://claude.ai/design/p/6f8cc292-ccbd-4d0b-b5e8-9dfe60c37d0f?file=Hands+Unchained.dc.html>

`Hands Unchained.dc.html` here is a mirror of that file at the commit where the
photos were wired in — same relative `./images/…` paths as the design project,
so the two stay interchangeable. Edit the deck in Claude Design, not here.

## The four slots

The deck's `<image-slot>` placeholders each carry a `src` pointing into
`images/`:

| slot id | slide | box on the 1920×1080 stage |
|---|---|---|
| `photo-chess` | 02 · Teach this arm to play chess | 936×1080 — half-bleed mirror, right half |
| `photo-arm-loop` | 05 · The loop we ship | 936×1080 — half-bleed, left half |
| `photo-arm-bleed` | 06 · One arm, many hands | 1920×1080 — full bleed |
| `photo-rig` | 09 · The gate is a person | 816×696 — split, right column |

All slots except `photo-chess` now hold real booth photographs (see below).
`images/photo-chess.jpg` is still a generated stand-in (the old generated
arm-loop frame) so the slide never presents an empty slot. Generate the real
frame (`gen-images.ts --only=photo-chess`, then `optimize.py`) or drop a real
photo of the arm at a chessboard onto the slot in Claude Design — that photo
is the opening beat of the whole pitch, so a real one beats a generated one.

A slot's `src` is a *fallback*: dragging a real photo onto the slot in Claude
Design still overrides it. So when we have actual bench photos of the rig,
drop them in — no code change needed, and these stand in until then.

## The logo

`logo.png` at the repo root is the final mark and the source of truth: a
worker's arm and an SO-101 snapping a chain, neon cyan on a dark navy plate,
with a grid and registration corners baked in. It is raster, has no alpha, and
its artwork is about **1.7:1 wide** — none of which suits being dropped straight
into a deck corner or a nav bar. So everything else is cut from it by
`extract-logo.py`:

| file | what it is | used by |
|---|---|---|
| `logo-plate.png` | the whole artwork, downscaled | README hero, social |
| `logo-art.png` | artwork only, transparent | the deck cover |
| `logo-arm.png` | the arm alone, transparent | app nav + favicon |
| `logo-mark.svg` | traced silhouette, `currentColor` | the deck's 12 slide corners |

```sh
python3 presentation/extract-logo.py --threshold 95
python3 presentation/trace-logo.py --input presentation/logo-mask.pbm \
  --smooth 1.3 --tolerance 1.6 --width 520 --out presentation/logo-mark.svg
cp presentation/logo-arm.png apps/web/src/logo-mark.png     # nav + favicon
```

The plate separates on luminance alone — the artwork is ~5% of pixels above
L=80 with a flat gap either side, so one threshold lifts the strokes and leaves
the plate, its grid and its corner marks behind.

**Why there are two cuts.** Measured, not assumed: the full lockup is clean at
110px and 84px and turns to mush by 40px, because it is three separate forms in
a wide frame. The arm crop spends the whole height budget on one form and still
reads at 18–22px, which is what the app nav needs. The arm stays **raster**
rather than traced — its antialiasing and cyan gradient are doing real
legibility work at that size, and the app is permanently dark so a
`currentColor` silhouette would buy nothing.

**`--width` on the trace is the quality/size dial.** 520 gives 9 KB and is
indistinguishable from 19 KB at the 84px the deck actually draws it — and the
mark is inlined twelve times, so the difference is 108 KB against 228 KB of deck.

**The mark is inlined on all twelve slides, not referenced.** Do not "optimise"
that into a `<symbol>` + `<use>` pair: `deck-stage` treats its direct children
as slides, so a `<defs>`/`<symbol>` block placed there renders as an extra blank
slide at position 1.

## The dark flip

The deck used to be light blueprint paper. It now lives in the logo's world —
dark navy, cyan accent — and because the deck is token-driven that is eight
lines in the `deck-stage {}` block plus one corrections block. Two things fell
out of it for free, and three broke:

- Free: `.duotone::after` paints `--color-accent` with `mix-blend-mode: color`,
  so all three photographs re-duotone to cyan off one token. `.bleed-scrim`
  fades `--color-bg`, so the slide-05 scrim inverted to a dark fade by itself.
- Broke: `.divider` was an *inverted* sheet (`background: --color-accent-900;
  color: --color-bg`), which inverted literally into a full-bleed pale cyan
  slide that flashes the room. Its ghost numeral went light-on-light. And every
  rule using `--color-bg` as **ink** — correct when the page was paper — began
  painting dark on dark.

All three are fixed in a "dark-ground corrections" block at the end of the
stylesheet rather than in place, so the original rules still read as written.

## The booth photos are real now

The three photo slots (`photo-arm-loop`, `photo-rig`, `photo-arm-bleed`) carry
**real photographs of the rig on the floor at Lisbon**, converted upright from
the iPhone HEICs into `originals/` and run through `optimize.py` like any other
frame. The bleed original is pre-cropped to a 16:9 band (arm, board, overhead
camera, the hall behind) so the copy's scrim lands on the dark mat.

The README-strip versions of the same photos (1600px / q82 — GitHub will not
render HEIC) live in `docs/images/` next to the app screenshots:
`rig-board-top.jpg`, `rig-gripper-mid-task.jpg`, `rig-bench-hall.jpg`.

⚠️ `gen-images.ts --force` would overwrite the real originals with generated
frames. Only `photo-chess` remains generated — regenerate that one with
`--only=photo-chess`, never with `--force`.

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
