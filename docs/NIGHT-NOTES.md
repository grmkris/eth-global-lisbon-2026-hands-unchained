# Overnight run notes — 2026-07-25

Autonomous overnight execution of: tasks/attempts platform (B), headless
agent (A), hub lab pages (C), docs + deploy (D). Everything landed; the
evidence and the honest caveats are below.

## Verified end-to-end (WAN, deployed hub)

Task advertised over the link → operator claims `poh-sim` → `attempt_start`
→ recording (spin-up grace) → axes streamed mid-recording → `attempt_finish
{success:true}` → **episode 4 (625 frames) saved with the task title as its
lerobot per-frame label**, attempts.json row `{success, op-wan}`. Also on
the deployed hub: datasets page (5 HF-API entries — no local cache on
Railway, by design), trainings page (13 imported runs), hardware + tasks
endpoints correctly 404.

Loopback gates additionally covered: wrong owner key visibly rejected
(`lastCommandResult`), missing ownerKey 403, disallowed args 403, discard
leaves the episode count unchanged, resume appends (episode files 000+001),
headless agent has ZERO listening ports, tasks re-advertise on fresh boot.

## Bugs found & fixed along the way

1. **Watcher/spin-up race** — the driver's ~2s dataset-create window looks
   identical to session-end; the watcher closed attempts instantly. Fixed
   with an 8s spin-up grace.
2. **`LeRobotDataset.resume(root=None)` refuses**, and a metadata-less
   dataset dir (from a crashed session) 404s against the Hub. Fixed: resume
   gets the explicit local root (HF_LEROBOT_HOME/repo_id).
3. **recorder never called `dataset.finalize()`** (recon find; lerobot's own
   script does). Fixed in the finally.
4. **No discard existed** — `finish` SAVES the partial episode. Added a real
   `discard` control (clear buffer, skip reset pass, end session).
5. **Stale command queue** — hub `pending` had no TTL; a minutes-old
   teleop_start firing on link resume was a real hazard. 15s TTL + cap.

## Known warts (deliberate, not broken)

- `info.json` episode counts update at finalize, a few seconds after the
  attempt closes — UIs reading it immediately see the old count.
- The TasksRegistry layer also initializes on the HUB (module-scope layer
  build) and prints a meaningless "owner key" into Railway logs; the tasks
  endpoints are 404-gated there so it's cosmetic only.
- Attempt outcomes `timeout` vs `failed` are best-effort labels around the
  driver's terminal phase; ground truth is the dataset.
- Real-backend attempts: cameras are owned by the recorder during a session,
  so the drive-page video freezes while recording on REAL rigs (sim is
  unaffected). Known pre-existing limitation.
- `remote`-source recording (leader-over-wire DURING an attempt) — the
  driver gate now accepts `set_joints` sources, but `make_input_source`
  still doesn't construct RemoteJoints for record sessions (stretch item,
  not needed for keyboard attempts). Keys attempts fully work.
- GitHub→Railway auto-deploy still needs the one-click repo connect in the
  Railway dashboard (the API/CLI return Unauthorized for that grant);
  deploys are `railway up` until then.

## Skipped (documented, deliberate)

- HF auto-push of task datasets (owner pushes via CLI; wrong thing to debug
  unattended).
- Wallet identity / attestation — the ETHGlobal layer on top of the now-
  existing operator provenance.
- Old `so101-hub` Railway project + so101-lab `app/` removal — both need an
  awake user.
