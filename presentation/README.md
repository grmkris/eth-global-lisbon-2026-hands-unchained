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

## Regenerating

Photos are generated with Gemini `gemini-3-pro-image`. Prompts live in
`gen-images.ts` and are the interesting part: they pin down what an SO-101
actually looks like (3D-printed PLA brackets, Feetech STS3215 servos,
daisy-chained 3-pin cables) so the arm doesn't come back as a generic
industrial robot, and they ban all in-frame text because the deck's `.duotone`
treatment would render any garbled AI lettering in blueprint blue.

```sh
GEMINI_API_KEY=… bun run presentation/gen-images.ts          # missing only
GEMINI_API_KEY=… bun run presentation/gen-images.ts --force  # all
GEMINI_API_KEY=… bun run presentation/gen-images.ts --only=photo-rig
python3 presentation/optimize.py                             # originals/ → images/
```

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
