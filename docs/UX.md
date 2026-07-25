# Lab Console — UX spec

Companion to SPEC.md. The CLI problem: every intent ("record 10 more eps")
requires re-stating the whole rig (ports, ids, cameras, paths). The UI inverts
this: rig stated once, intents are 1–3 fields.

## Principles
1. **Rig profile kills the flags** — ports/ids/cameras/brightness band/HF user stored once (env-overridable), inherited everywhere. Forms only contain per-session deltas.
2. **Intents, not commands** — IA organized by practitioner intent (collect / extend / train / eval / correct), never by lerobot binary.
3. **Show the command** — actions reveal the exact CLI they run/generate (today: the Colab cell fold). Trust + escape hatch.
4. **Guardrails are UI** — `save_checkpoint_to_hub` locked on; no deletes (exclude lists only); safety verbs (E-STOP/stop) visible to everyone on a drive page, lease or not.
5. **Convention over configuration** — names auto-suggested, defaults from crib-sheet (40k/16/5k, transforms on, wandb on), advanced flags behind a fold.
6. **Restart-safe** — all state derived from disk/Hub/driver, never from app memory. Kill the app mid-anything, reopen, continue. (Hub leases are the accepted exception — in-memory, self-healing.)

## Shipped pages
- **Dashboard `/`** — rig/trainings/datasets cards (on a hub this renders the Lobby instead — a local-arm dashboard there would be a lie).
- **Robot** — connect/disconnect (sim/real, ± leader), teleop with source select (leader · keys · phone · scripted), E-STOP, live joint grid, camera probe → thumbnails → confirm, brightness vs band.
- **Record** — wizard (task, eps, durations, source) + HUD (feeds, REC/RESET phases, keep/re-record/discard/finish, hotkeys).
- **Datasets** — merged local+Hub list with sync badges, SIM badges; detail: episode table (length-outlier flags), exclude-builder → `--dataset.episodes` string.
- **Trainings** — run list (Hub `kris0/*` auto-imported); detail: lineage, Hub ckpt timeline, generated Colab cell, hypothesis/finding notes.
- **Lobby** (hub) — rig cards: live preview, online/holder state, link ms, impairment badge, token gate when auth is on.
- **Drive `/drive/$rig`** (hub) — cam feeds, Take control / Take over (force, with confirm), keyboard jog pad, connect/teleop verb buttons for the holder, **Stop teleop + E-STOP for everyone**, rig fault surfacing, link/rtt readout.

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
| cam-index verify snippet | Robot page probe + confirm | ✅ |
| lerobot-teleoperate (5 lines) | Teleop with source select | ✅ |
| lerobot-record (10 lines) | Record wizard | ✅ |
| Colab cell assembly | Train form → generated cell | ✅ |
| --dataset.episodes crafting | Episode table ticks | ✅ |
| — (no CLI equivalent) | Lobby/Drive remote teleop, leader-over-wire | ✅ |
| lerobot-calibrate ×2 | Robot page button + staleness badge | backlog |
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
