# Lab Console — UX spec

Companion to SPEC.md. The CLI problem: every intent ("record 10 more eps")
requires re-stating the whole rig (ports, ids, cameras, paths). The UI inverts
this: rig stated once, intents are 1–3 fields.

## Principles
1. **Rig profile kills the flags** — ports/ids/cameras/brightness band/HF user stored once (env-overridable), inherited everywhere. Forms only contain per-session deltas.
2. **Intents, not commands** — IA organized by practitioner intent (collect / extend / train / eval / correct), never by lerobot binary.
3. **Show the command** — actions reveal the exact CLI they run/generate (today: the Colab cell fold). Trust + escape hatch.
4. **A control that cannot succeed is not rendered** — visibility is derived
   from telemetry (arm state, the live input sink, whether a leader is actually
   attached), so a button never fails with "you can't do that now". No
   exceptions any more: E-STOP used to be one (always shown, made unfailable
   instead) and it is no longer rendered at all.
5. **Guardrails are UI** — `save_checkpoint_to_hub` locked on; no deletes (exclude lists only); the drive page's one stop (`Stop driving`) is visible to everyone, lease or not, because `teleop_stop` is a `safety: true` verb. The `estop` verb is still on the rig API but has no button — see the safety section of SPEC.md for what that costs.
5. **Convention over configuration** — names auto-suggested, defaults from crib-sheet (40k/16/5k, transforms on, wandb on), advanced flags behind a fold.
6. **Restart-safe** — all state derived from disk/Hub/driver, never from app memory. Kill the app mid-anything, reopen, continue. (Hub leases are the accepted exception — in-memory, self-healing.)

## Shipped pages
- **Dashboard `/`** — rig/trainings/datasets cards (on a hub this renders the Lobby instead — a local-arm dashboard there would be a lie).
- **Robot** — connect/disconnect (sim/real, ± leader), teleop with source select (leader · keys · phone · scripted), E-STOP, live joint grid, camera probe → thumbnails → confirm, brightness vs band.
- **Datasets** — merged local+Hub list with sync badges, SIM badges; detail: episode table (length-outlier flags), exclude-builder → `--dataset.episodes` string.
- **Trainings** — run list (Hub `kris0/*` auto-imported); detail: lineage, Hub ckpt timeline, generated Colab cell, hypothesis/finding notes.
- **Lobby** (hub) — rig cards: live preview, online/holder state, link ms, impairment badge, token gate when auth is on.
- **Drive `/drive/$rig`** (hub) — a **cockpit, not a document**: the only page
  that opts out of the reading-width column (`staticData: { wide: true }`).
  One camera is dominant with a 62vh height budget, the rest are click-to-promote
  tiles (each feed rendered exactly once — a duplicate `<img>` is a duplicate
  MJPEG connection). **Setup lives in the rail, live control stays welded to the
  feed.** Under the frame: the driving badge, the link/rtt readout, and one
  **Stop driving** for everyone — a safety verb a spectator must be able to hit
  while watching the arm, and a spectator has no rail. Release control stays in
  the header. The keyboard jog pad mounts only when keys are the chosen source
  and arrives already focused.
  **While an attempt records, the rail becomes the recorder** — ● REC, a
  draining clock bar, Success / Discard — so the buttons that end a 20s episode
  are never a scroll away from the feed you are watching. Slot ledger + task
  list sit in a right rail; leader-input debug and the joint grid are behind a
  **Diagnostics** fold whose collapsed summary carries the live packet rate.
  Rig faults surface under the viewport.
- **The task IS the gate.** The rail holds ONE card, not a toll above a
  worklist: the tasks are the reason to stake and the gate is the mechanism, so
  as peers they put the price before the point. Everything between an operator
  and one recorded episode is a single ordered list
  (`lib/use-start-requirements.ts` — online · verified · staked · arm connected ·
  cameras · drive source · lease), and a blocked **Start attempt** opens that
  task's list in place rather than firing. Met rows are ✓ receipts; the first
  unmet one is the only one that renders its remedy (World ID for `verified`,
  the chain toggle + stake button for `staked`, the source chips for `source`, a
  pointer at whoever can fix it for the rest — never a duplicate control). So the
  slot gate is not a concept of its own any more, it is two rows of this.
  **Choosing a source IS taking the rig** (keyboard / \<name\>'s leader / the
  rig's own arm, each claims the lease then starts that source, with a confirm
  when stealing a live holder), and `source` is the one row whose remedy survives
  being satisfied — it becomes `✓ driving — keyboard` with the chips still under
  it, because switching source is something you do repeatedly inside a slot.
  The card header is the disclosure; **Start attempt is always last and purely
  terminal**, disabled with the first unmet requirement as its tooltip. It must
  never double as the opener: as one it re-armed the already-open task and did
  nothing, which is a button that looks live and isn't. While gated the first
  startable task is open by default, so nothing is hidden behind a click.
- **Staking IS starting** — the corollary of rule 4. On a free rig, one button
  takes you from nothing to driving: the stake mines and the hub relays
  `startSlot` in the same breath, so the clock begins when you pay and no second
  confirmation is asked for a decision already made with money. Two chain writes
  behind one button is a 6–20 s wait, so it is narrated rather than spinnered —
  *confirm in your wallet → staking → opening the arm*, each naming what is
  being waited on (the `opening` line says the hub pays that transaction, which
  is the moment people expect a second popup). **Take control** survives only
  where the clock genuinely cannot have started: promotion from the queue, a
  second device, a hub restart mid-slot, or a relay that failed after the money
  landed. It is the fallback, never the path.

## Backlog UX (not built — the plan when it lands)
- **Preflight gate**: recording blocked until cams confirmed · brightness in band · calibration fresh · disk OK — all green → Start.
- **Coach overlay** on the record HUD: "place at C2, rotate +45°", live coverage tally, prompted-vs-actual.
- **Exit summary** after a record session: kept/redone, brightness stats, coverage delta → Push to Hub · Journal draft · Record more · Train on this.
- **Rollouts page**: episodic eval / DAgger bound to a checkpoint; per-episode success/fail + condition tags → eval matrix → coach targets; `rollout_*` naming automatic.
- **Extend** on a dataset (resume flags invisible), **Replay ep**, **Push/Pull** buttons.
- **Settings** page (rig profile editor — today it's env vars).
- Dashboard "suggested next action" derived from state.

## CLI → UI mapping
| CLI today | UI | Status |
|---|---|---|
| cam-index verify snippet | Rig owner fold → Cameras (probe + assign over the verb pipe, real rigs only) | ✅ |
| lerobot-teleoperate (5 lines) | Teleop with source select | ✅ |
| lerobot-record (10 lines) | Record wizard | ✅ |
| Colab cell assembly | Train form → generated cell | ✅ |
| --dataset.episodes crafting | Episode table ticks | ✅ |
| — (no CLI equivalent) | Lobby/Drive remote teleop, leader-over-wire | ✅ |
| lerobot-calibrate ×2 | drive page button + staleness badge | backlog |
| --resume --dataset.root | "Extend" button | backlog |
| lerobot-replay | "Replay" on episode row | backlog |
| lerobot-rollout episodic/dagger | Rollout wizard | backlog |
| push_to_hub snippet | "Push" button | backlog |
| manual journal entry | Auto-draft + one-click append | backlog |

## Open UX questions
- Episode thumbnails: extract first-frames at record time (cheap) vs on-demand (slow page)? Leaning record-time.
- Dashboard "suggested next action": rule-based from state (v1) vs LLM-composed (later).
- Eval matrix in v1 or after coach? Leaning: tags + tally in v1, matrix visualization with coach.
- Drive page for touch (jog pad on a phone) — matters the moment a friend without a leader arm wants to drive.
