# Proof of Hands — testing checklists

Everything runs through the hub UI — there is no local console. A "rig" is a
headless agent (`src/agent.ts`) that dials out; you drive and manage it from
the hub's drive page. Never actuate the real arm unattended.

Start a loopback pair (two tabs, both in `apps/web`):

```sh
# tab 1 — the hub (dev twin of the Railway deployment)
bun run hub                                        # → :3001

# tab 2 — a headless sim rig (python driver spawns lazily;
# venv at apps/driver/.venv, `uv sync` in apps/driver if missing)
bun run rig:sim
```

The rig terminal prints its OWNER KEY at boot (also `apps/web/.data/owner.json`).
Owner panels on the drive page (camera setup, record, tasks) need it once per
browser.

## 1 — Sim smoke (no hardware, hub UI only)

All on `http://localhost:3001`:

| # | Step | Expect |
|---|------|--------|
| 1 | Lobby `/` | `kris-sim` card online (autoconnected sim) |
| 2 | Open the card → **Take control** | both cams stream (MuJoCo scene); joints grid live |
| 3 | **Teleop (keys)** → click the jog pad | W/S/A/D/Q/E jog the arm; O/C gripper |
| 4 | Release all keys / click away | arm holds pose (deadman ~0.5 s) |
| 5 | Owner: Record panel → source `Scripted expert`, 2 eps × 5 s | REC pill cycles recording/resetting, saved count reaches 2, panel returns to the form |
| 6 | Record again → source `Keyboard`, drive during REC via the pad | keys drive the arm while recording; 2/2 saved |
| 7 | Datasets page → `report` on the new dataset | episode table renders; exclude an ep → `--dataset.episodes` flag string appears |
| 8 | Trainings → New training → pick the dataset + rig → Create | detail page opens, Colab cell renders (client-generated); run appears in the rig's advertisement within ~2 s |
| 9 | E-STOP during any teleop | physics pauses, state back to connected |

## 2 — Rig session (real arm, user at the rig)

Rig: `bun run rig:real` (or `HUB_URL=<deployed> … bun run agent`). Everything
else happens on the hub's drive page.

Pre-flight (every session — macOS shuffles camera indexes on replug):
- [ ] Drive page → Camera setup → **Probe + preview all** → identify
      workspace/wrist from the thumbnails → confirm each
- [ ] Brightness badges inside the 115–131 band (one dominant desk lamp)
- [ ] Both arms powered + plugged (follower `...832001`, leader `...538411`)

| # | Step | Expect |
|---|------|--------|
| 1 | **Connect REAL** | state connected; joints grid live |
| 2 | **Teleop (leader arm)** | follower mirrors leader, no lag spikes |
| 3 | Stop → **Teleop (keys)** → jog gently | EE-space jog works; big jump attempt → driver stderr shows the 15°/frame clamp warning |
| 4 | E-STOP (raised arm — catch it!) | torque kills instantly, arm goes limp |
| 5 | Owner record: 2 real eps, source `Leader arm` (cameras confirmed) | REC pill; ✓ Keep saves; done 2/2 |
| 6 | Datasets → report card on the new set | lengths sane, no unexpected `short` flags |

Phone source is currently broken (driver venv lacks the lerobot phone
patches — runbook: so101-lab repo `phone_teleop/README.md`).

## 3 — Remote teleop cluster (no hardware, two processes on one Mac)

Simulates "my rig, her laptop, a cloud in between" without a cloud. The only
difference from production is the value of `HUB_URL`. Setup as in the intro
(optionally `HUB_LATENCY_MS=120 HUB_DROP_RATE=0.05 bun run hub`).

Look for `[rig-link] kris-sim -> http://localhost:3001` in tab 2.

| # | Step | Expect |
|---|------|--------|
| 1 | `:3001/lobby` | `kris-sim` card, online |
| 2 | Open the card → **Take control** → **Connect SIM** (if not autoconnected) | both feeds appear within ~2 s |
| 3 | **Teleop (keys)** → click the jog pad → W/S/A/D/Q/E | arm moves in the hub's video; joints grid updates |
| 4 | Release all keys | arm holds — the deadman fires because the hub does **not** replay input |
| 5 | Second browser tab on the same rig | video plays, jog pad hidden, "someone else is driving" |
| 6 | Take over from tab 2, then drive from tab 1 | tab 1 gets 403; one writer at a time |
| 7 | Kill tab 2 (the rig) | lobby flips to offline within 5 s |
| 8 | Restart the rig, then restart the hub | both re-register with no reconnect logic — that is a Railway redeploy |
| 9 | Re-run with `HUB_LATENCY_MS=120 HUB_DROP_RATE=0.3` | still driveable; rig card shows link ≈125 ms; arm still holds on silence |

## 4 — Against the DEPLOYED hub (https://web-production-b5106.up.railway.app)

Deploys are push-to-deploy: a push to `main` touching `apps/web/**` rebuilds
the Railway service (`railway.toml` at the repo root).

```sh
# headless sim rig on your Mac, registered with the cloud hub
HUB_URL=https://web-production-b5106.up.railway.app RIG_NAME=kris-sim \
  LAB_AUTOCONNECT=sim bun run agent
```

| # | Step | Expect |
|---|------|--------|
| 1 | Hub lobby in any browser | rig online, streaming, `link` ≈ your RTT |
| 2 | Drive with the keyboard from another network (phone off wifi) | ~100–200 ms feel; deadman holds on silence |
| 3 | Leader-over-wire: `bun run teleop` (leader plugged in, port auto-detected) → drive page → **Take control** → **Drive with \<name\>'s leader** | sim mirrors the physical leader; badge reads "you are driving — via \<name\>'s leader"; ~30 packets/s in the leader-agent log |
| 4 | While the leader drives: **Take over** from a second tab | leader agent prints `lost <rig> (control changed)` and idles within ~0.5 s (403 or `bound:false`); the new tab drives immediately; it can lend the same leader by clicking Drive |
| 4b | While the leader drives: **Start attempt** on a task, then ✓ Success | the attempt runs with YOU as operator while the leader drives (record source `remote`), episode saved — the leader never took your lease |
| 5 | As a non-holder: **E-STOP** | works without the lease — safety verbs bypass it |
| 6 | Redeploy mid-session | rig re-registers in seconds; operator re-claims (lease loss expected) |
| 7 | `POST /api/runs` (or any non-GET) against the hub API | 404 `read-only hub` — writes only ride the verb pipe |

Local prod-build twin of the deployment: `bun run build && PORT=3001 bun run hub:prod`.

## Regression suite (run after driver/web changes)

```sh
cd apps/web && bunx tsc --noEmit && bunx biome check src && bun run build
cd apps/driver && for f in *.py backends/*.py sources/*.py; do .venv/bin/python -c "import ast; ast.parse(open('$f').read())" || echo "FAIL $f"; done
# + sim smoke rows 2–8 above
```

Known gaps / by design:
- Real-mode video during record stays dark (the recorder owns the devices).
- Report cards for datasets NOT pushed to the Hub only render on the machine
  that recorded them (remote-parquet reads need the dataset on the Hub).
- Contract changes need a dev-server restart (the API handler survives HMR on purpose).

## 5 — Tasks + attempts (the crowdsourcing loop, sim-verifiable)

Setup as in the intro; paste the owner key into the drive page's owner panel.

| # | Step | Expect |
|---|------|--------|
| 1 | Drive page → "Rig owner — manage tasks" → paste key → create a task | task card appears (lobby too); wrong key shows `✗ wrong owner key` via lastCommandResult |
| 2 | Take control → Start attempt | REC pill within ~3 s (spin-up grace covers dataset create), countdown from the task's episodeSeconds |
| 3 | Drive during the attempt (jog pad) | input flows into the recording (record source = your teleop source) |
| 4 | ✓ Success | episode saved — `info.json total_episodes` +1, task title is the per-frame lerobot label; `.data/attempts.json` row {operator, outcome: success} |
| 5 | New attempt → ✗ Discard | episode count UNCHANGED; outcome `discarded` |
| 6 | Let one run out | lerobot timeout semantics auto-save; outcome `timeout` |
| 7 | Close the browser mid-attempt | after 30 s holder-loss: partial discarded, outcome `abandoned`, teleop NOT auto-restarted for a failed driver |
| 8 | Restart the hub mid-attempt | recording uninterrupted; tasks re-advertised (rev-echo); your page reclaims the lease and the attempt continues |

Curl equivalents live in the git history of this checklist (B-gate, commit
"tasks + attempts").
