# Stage script — ETHGlobal Lisbon 2026

Two speakers. **Kristjan** narrates (beats 1–7), **friend** takes the arm and
demos live (beat 8). Built to **4:00**; the 3:00 cut is marked.

The spine: *I wanted one robot to do one thing. I found out the data doesn't
exist. So I built the thing that makes the data — and the referee that decides
which of it is worth keeping.*

Deck lives in Claude Design (see `README.md`). The mirror
`Hands Unchained.dc.html` already carries every slide named below — re-upload
it to the design project and the deck matches this script.

---

## Beat 1 · Cover — 0:10

**Slide:** Cover (unchanged)

> "I'm Kristjan. Six weeks ago I got into robotics — I bought an arm and I
> wanted to teach it one thing: to play chess."

Don't explain the project yet. The audience should think this is a robotics
talk for the next thirty seconds. It is.

---

## Beat 2 · The chess arm — 0:35

**Slide:** 02 · Teach this arm to play chess (in the deck — half-bleed, the
`photo-chess` slot). Generate the real chess frame or drop a home photo on it.

> "Not chess the game — chess the *hands*. Pick up the knight without touching
> the two pieces beside it. Put it down centred on the square, not straddling
> two. Take a piece off the board, then put yours where it stood.
>
> Every one of those is a separate manipulation skill, and none of them are in
> any model you can download. So I went looking for the training data."

This is the whole reason the personal opening works: chess makes "manipulation
data" something the room can *see*. Do not skip the knight sentence.

---

## Beat 3 · Zero — 1:00

**Slide:** `03 · The data bottleneck` — the giant **0**

> "Zero. There is no internet for robots. Language models were trained on the
> whole web; robot models are trained on humans physically moving the robot,
> one recorded episode at a time — and you need hundreds per task.
>
> I sat down and recorded them myself. It's twenty seconds an episode and it is
> excruciating. I have a job. I was never going to finish."

The number lands twice as hard here as it did as slide 2 of an impersonal deck
— it's now *your* wall, not a market statistic. Same slide, no edit needed.

---

## Beat 4 · Give the arm away — 1:30

**Slide:** `05 · The loop we ship`

> "So I stopped trying to produce the data and built the thing that collects
> it. The arm sits on my desk in Lisbon and dials out to a hub. Anyone,
> anywhere, opens a browser, takes control of it, and does the task I set. Each
> successful attempt is saved as one labelled episode in *my* dataset.
>
> Strangers on the internet train my robot while I sleep."

---

## Beat 5 · But is it any good? — 2:05

**Slide:** 10 · Claimed is not graded (in the deck — Claimed/Graded columns,
with the knight-off-its-square line).

> "And then the problem that actually matters. Crowdsourced data isn't
> worthless because people fail — failures you throw away. It's worthless
> because of the *sloppy successes*. Someone drops the knight half on the
> square, clicks the green button, and my model faithfully learns to do that
> forever.
>
> Success was self-declared. The worker was grading their own work. That's the
> hole — and it's the one place where AI earns its keep here: the referee is a
> model running in a TEE on 0G. It never sees the click. It reads the recorded
> trajectory itself — thirty hertz of joint state, the actual work product —
> and *its* verdict decides whether that episode is kept and whether you get
> paid. The enclave signs the verdict, and the contract checks that signature,
> so I can choose which grade to submit but I can never forge one."

This beat is the pitch. Say it slower than the rest.

---

## Beat 6 · The rest of the mechanism — 2:35

**Slide:** existing `Three gaps, three integrations` (World ID · 0G · payment)

> "Once strangers get paid, two more holes open. An operator is a random tab ID
> — so **World ID** gates it: unverified gets a 402 and the arm stays locked.
> Watching is free, touching needs a verified human over eighteen, because this
> is real machinery. And booking *is* staking — thirty exclusive minutes bought
> from your own wallet on-chain, so nobody takes the arm out from under you
> mid-episode. Pass the referee, get your stake back plus the reward. Claim a
> success the referee rejects, take a strike."

**3:00 cut:** if the clock is tight, this beat compresses to two sentences —
"World ID gates the arm, the chain holds the slot and the money." Beat 5 never
gets cut.

---

## Beat 7 · Handoff — 2:55

**Slide:** `06 · One arm, many hands` (full-bleed arm photo)

> "That's my side. I set up one arm — plugged it in, ran one command, it dialled
> out and appeared in the lobby. No ports, no port-forwarding, nothing open on
> my network.
>
> Everything else is the strangers. So — here's one."

*Step back. Hand over.*

---

## Beat 8 · Live demo — 2:55 → 4:00

**Friend, on a Vision Pro, driving the real arm on the table.**

Her opening line should make the network explicit, because that's what nobody
believes:

> "I've never touched this arm. I'm holding a lease on it over the public
> internet, from a headset, with my bare hands."

Order (from `HACKATHON.md`, resequenced so the deny path stays first):

1. **Unverified → refused.** Take Control → 402. Show it before anything works.
2. **Verify** (World ID) → book the slot → lease granted.
3. **Drive.** Hand tracking → arm moves. Let the room watch the lag, it's
   ~50 ms and that's the flex.
4. **Run the task, claim ✓.**
5. **The grade comes back** — score, `teeVerified`, and the payout on the
   explorer. Second screen.

**Kicker if there's room:** the sim rig running at the same time. "Zero hardware
to join the market."

**Fallback ladder** — pre-agreed, no improvising on stage:
headset drops → browser keyjog on the same arm → sim rig → Saturday-night
recording with the explorer links already open.

---

## Close — 4:00

**Slide:** existing `Close`

> "I still can't play chess. But I'm no longer the bottleneck — and neither is
> anyone else who owns one arm and no time."

---

## Deck state (mirror = `Hands Unchained.dc.html`, 13 slides)

All structural changes are DONE in the local mirror — re-upload it to the
Claude Design project to make it the presented deck. What the mirror now has:
the chess origin slide (02), the personal bottleneck hero (03), first-person
loop bullets (05), the VR-headset input list (06), the knight-off-its-square
hinge (10), the handoff demo timeline (11), and the chess-callback close (13).
Speaker notes ride on slides 02, 03, 05, and 11 (`data-speaker-notes`).

Still open, in Claude Design or before stage:

| # | Action |
|---|---|
| 1 | **Replace `photo-chess`** — the one slot still generated (the other three now carry real booth photos). Generate (`gen-images.ts --only=photo-chess` + `optimize.py`) or drop a real photo of the arm at a chessboard. |
| 2 | **Fill** the `[N]` on the Traction slide before you present, or pull the slide. |
| 3 | **Add your teammate's name** to the cover meta (it reads "Kristjan · July 2026") — she carries half the demo. |

## Before you walk up

- **The name is _Hands Unchained_** — live app, deck, and submission all agree
  now. Say it out loud in beat 1 — the cover is the only place the room hears
  it.
- **Who says the honest caveat.** Somewhere in Q&A: the TEE proves the grade
  came out of the enclave, not what was asked, and the backend still chooses
  which attempt to submit. Volunteering that is worth more than being caught by
  it — but it belongs in Q&A, not the pitch.

## Likely judge questions

- *"Why would anyone plug in their expensive arm?"* → They get a labelled
  dataset for their task, produced by other people, and they never leave their
  desk. The arm is the thing they already own and can't get data for.
- *"What stops someone wrecking the hardware?"* → 15°/tick clamp, 0.5 s
  deadman, servo EEPROM limits from the *owner's* calibration are the hard
  stop, and anyone watching can hit e-stop — lease or not.
- *"Isn't the grader just an LLM you trust?"* → It's not trusted, it's
  attested and it's constrained: it grades the recorded trajectory, the enclave
  signs the response, the contract `ecrecover`s that signature. An ungraded
  attempt can pay you but can never cost you a strike — lenient without the
  enclave, never punitive.
