# Resuming after a laptop close / session loss

## What survives, what doesn't

| Thing | Survives lid close? |
|---|---|
| Everything under `src/`, `docs/`, `tools/` — the actual game | **Yes.** Agents write straight to disk. |
| Git history + any commit you made | **Yes.** |
| `shots/*.png` from the critic loop | **Yes.** |
| Workflow scripts (`~/.claude/projects/.../workflows/scripts/*.js`) | **Yes.** |
| Per-agent transcripts + `journal.jsonl` | **Yes.** |
| **In-flight workflow agents** | **No.** Sleep suspends the process; API calls in flight fail. |
| **`resumeFromRunId` cache** | **No.** It is same-session only. |
| Spawned `vite` / Playwright Chromium processes | **No.** They die or wake wedged. |

The important consequence: **you never lose finished work, only work an agent was mid-way
through when the lid closed.** An interrupted agent may leave a half-edited file, so always
`git status` on resume.

## Before you close the lid

```bash
cd /Users/raynos/projects/game-demos/valkyrie-chronicles-demo-opus
git add -A && git commit -m "wip: checkpoint before sleep"
```

That is the only thing that matters. If a workflow is running, you can also let it finish —
`/workflows` shows live progress — but committing first means an interrupted agent can't
lose you anything.

Optional: `caffeinate -dimsu` keeps the machine awake, but on Apple Silicon closing the lid
sleeps anyway unless you are in clamshell mode on external power + display.

## On resume

### 1. Check for half-written files

```bash
git status --short
npx vite build          # catches a truncated file instantly
find src -name '*.js' | xargs -n1 node --check
```

If a file is truncated or syntactically broken, `git checkout -- <file>` to roll it back to the
last commit and re-run whatever agent owned it.

### 2. Confirm the game still boots

```bash
node tools/shoot.mjs overview shots/overview.png --wait 3500
```

Exit 0 with an empty `errors` array = the build is healthy. Look at the PNG.

### 3. Restart the workflow

**Same session still alive** (Claude Code never quit) — cheapest path, replays completed
agents from cache and only re-runs what changed:

```
Workflow({ scriptPath: "<path printed when the workflow launched>",
           resumeFromRunId: "<run id printed when it launched>" })
```

**New session** (the usual case after a lid close) — the cache is gone, so re-run the script
fresh. Ask me to do it and name the phase you want, or just say:

> resume the Valkyrie build

and I will read `docs/ARCHITECTURE.md`, `docs/CRITIQUE_RUBRIC.md`, this file, and the current
`shots/` output, then pick up at the right phase. The scripts live in:

```
~/.claude/projects/-Users-raynos-projects-game-demos-valkyrie-chronicles-demo-opus/<session>/workflows/scripts/
```

Editing a script and re-invoking with `{scriptPath}` is the supported way to iterate — you do
not have to resend the whole thing.

### 4. Find out what a dead agent had actually done

Each workflow run has a transcript directory with one `{"type":"result"}` line per completed
agent:

```bash
cat ~/.claude/projects/-Users-raynos-*/*/subagents/workflows/wf_*/journal.jsonl \
  | node -e 'process.stdin.on("data",()=>{});' # or just read it
```

Read that before assuming an agent accomplished nothing — the file edits it made are already
on disk even if it never returned a report.

## After a REBOOT specifically

A reboot kills three things that are not on disk:

1. **The warm vite dev server on port 5173.** Restart it before any rendering, or every
   screenshot silently costs ~13 s extra:
   ```bash
   cd /Users/raynos/projects/game-demos/valkyrie-chronicles-demo-opus
   npx vite --host 127.0.0.1 --port 5173 --strictPort &
   ```
2. **Any headless Chromium** left over from the harness. They die cleanly; nothing to do.
3. **Any running workflow.** Its agents are gone. Files they had already written survive —
   `git status` will show them.

Then the standard checks: `git status --short`, `npx vite build`,
`find src -name '*.js' | xargs -n1 node --check`, and one render to confirm the game still boots:
```bash
node tools/shoot.mjs bridge shots/bridge.png
```

## Where it stands (round 25)

**Shippable-adjacent.** 65k lines, 61 modules. `node --check` clean, `vite build` clean, all 12
capture shots render with **zero console errors**. The mission is winnable and loseable, verified
by a scripted headless playthrough of all seven win/lose conditions across ~32k simulated frames.

### The three things a resumer most needs to know

1. **Run the nav acceptance test after ANY change to buildings, footprints or colliders.**
   Densifying the village in r25 sealed the Imperial flag into a 17-cell island and made the
   primary win condition physically unreachable — in a build that otherwise rendered and played.
   ```js
   vc.battle.nav.findPath({x: 2.75, z: 52.25},
                          vc.battle.camps.find((c) => c.id === 'imperial').pos, {}) !== null
   ```
   Objectives now carry a keep-clear radius in `world/structures.js`; do not remove it.

2. **The review loop lies in two specific ways, both now fixed but both worth knowing.** The
   resident path used to render the entire aim overlay at opacity 0 (a frozen CSS animation the
   daemon could never restart), and `dt = 0` freezes every `damp()`-driven HUD readout at whatever
   `resetShotState()` left in it. Anything that disagrees between `--cold` and the fast path is a
   harness artefact until proven otherwise.

3. **Read `docs/CRITIQUE_RUBRIC.md` before measuring anything.** It now records **ten** dead ends
   ruled out by measurement, including the r25 five: the p99 ceiling was two DOM `multiply` layers
   and not the shader; the crease term sees normals so zeroing an albedo map cannot remove a mark;
   the sky was pinned to paper by the falloff's depth term, which is why two separate re-authorings
   of the sky dome could not reach the page; and the "mesh cannot deform past here" wall recorded
   in `finish_plan.md` for two rounds never existed (probed 25,600 directions, clamp never hit).

### Verified good — do not churn these

The `command` map, the HUD's design vocabulary (a critic called it "in two places better than the
reference"), the book chrome from boot card to results screen, r23's aim-line convergence maths,
the CAST colour-identity table, and the margin drain — whose left-edge saturation ramp measures
0.08/0.10/0.24/0.39 against `vc-072`'s 0.07/0.09/0.17/0.25, the first thing this project has built
that measures like the reference.

### Open, measured, and honestly reported

- **Ink is 4.3–8.4% against the reference's 1.8–2.8.** Deleting the *entire* outline pass only
  moves `village` 8.68 → 6.30, so it is **not** linework — it is texture inside shadow masses.
  Do not re-try `outlineWidth`; that lever is ruled out.
- **`dusk` is over-inked (22%) and its near field is crushed.** Three agents each ruled out their
  own half (shot sun bearing, sky/light blend, composite near-field term). Cause still unlocated.
- **Faces read at closeup but are not yet drawn faces**, and hair is a solid mass rather than locks.
- **Frame budget** is calibrated per session (`calibrateBudget`, target 13.5 ms). Every number
  behind it was measured under another project's CPU load — re-measure on a quiet machine with
  `node tools/frametime.mjs`.

## Build phase order (so you know where to pick up)

1. ~~Core scaffold + contracts~~ — done, committed
2. ~~Subsystem build (7 parallel agents, 59 modules)~~ — done, committed `043c624`
3. ~~Integration: `main.js` + defects S1–S15, then the boot doctor~~ — done
4. ~~Harness performance + determinism~~ — done, `docs/HARNESS.md`
5. ~~Visual critique loop~~ — rounds 1–25. r25 = 8-concern audit + 3 fix waves + 5 blind critics;
   all findings and verdicts are in `docs/critiques/r25/`.
6. ~~Playtest / balance~~ — mission verified winnable and loseable headless (r25)
7. Publish pass — README, meta/social tags, favicon, loading screen and static `dist/` all done;
   remaining art work is the "Open" list above, not blockers to running it.
