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

## Where the visual loop currently stands (round 15 in flight)

**The r14 pole fix worked and should not be revisited.** Looking at `shots/bridge.png` after r14:
the violet/lavender shade family is *gone*, lit surfaces kept their own hue, and cast shadows
survived. Five rounds of "shade is violet" is closed. The mechanism that fixed it — the pole is a
DIRECTION the deepest wash turns toward by a bounded amount, not a paint substituted for the
pigment's chromaticity, and the 242..290 degree clamp is deleted — is documented in
`render/lighting.js` above `SHADE_RAMP`. Leave it alone.

**The defect ranking that replaced it**, from reading the four r14 frames directly (not from a
metric):

1. **Characters read as wooden mannequins.** A flat rectangular torso slab with straight vertical
   sides, boxy shoulder pads, untapered tube limbs with no elbow or knee break, hands as pale
   pebble clumps. Visible in every character shot and it is the single most damning tell. This is
   geometry (`actors/rig.js`), not shading.
2. **The Edelweiss does not read as a tank** (`actors/tank.js`) — a scatter of flat tan and olive
   plates with a floating gun tube and no running gear at all: no road wheels, no track run, no
   sprocket, no fender line.
3. **Albedo mottle is doing form's job.** The uniform reads as camouflage rather than one dyed
   serge; masonry reads as lichen mottle rather than cut stone. This is the exact trap the
   "metric integrity" section below warns about, arrived at from a different direction.
4. **A global haze veil compresses the whole frame into midtones** — almost no near-ink darks
   anywhere, so nothing snaps. Aerial perspective belongs on the *distant* planes only.
5. **The bridge has no coursing** — no voussoirs radiating around the arch heads, no string
   course, no coping, and a parapet top edge that is a perfectly straight ruled line across the
   full frame (reads as CAD, not as drawn).
6. Distant figures at `overview` scale are featureless olive lozenges — they read as skittles.
7. Water is an over-saturated mint green, and reads inconsistently between the arch openings and
   the open channel (`world/water.js` — not yet assigned to a round).

`overview` is currently the strongest plate: foliage, hatching, aerial perspective and composition
genuinely work there. Its weakness is the washed-out left half and the skittle figures.

## Historical: where round 14 stood

**Playable and rendering:** 36.5k lines, full BLiTZ battle system, 12 deterministic capture shots
at 72–189 fps, zero console errors. `docs/HARNESS.md` explains the ~3× render speedup and why
frames are now byte-deterministic (which is what makes regression diffs meaningful).

**Verified working:** cast shadows (under-arch water 67 LSB below open water, from an *inverted*
−9.6 several commits ago), the lit tank, hatching in shadowed masses, hands with legible fingers,
a tunic that reads as cloth rather than camouflage, composition 7–8, palette 7–8.

**The open defect, precisely located.** Shade hue is dominated by the ambient "pole" colour in
`render/lighting.js`, so every surface shades to roughly the same tint regardless of its albedo.
Sweeping the pole's chroma gives moss green (99°) → teal grey (163°) → blue-violet (192°); none is
right, because the fix is to reduce **how much** the pole glazes over albedo, not to pick a better
pole colour. The acceptance test is that stone, grass and cloth must shade to three *different*
hues. Full detail in `docs/CRITIQUE_RUBRIC.md`'s last three sections.

**Also open:** the face is drawn but not modelled (no zygomatic arch for a terminator to fall
under); the lancer's arm in `tank`; characters don't band at `overview` scale; ~half of character
footprints lack contact darkening.

**Read `docs/CRITIQUE_RUBRIC.md` before measuring anything.** Its last three sections record how
these metrics have been gamed and how they have misled — including five dead ends already ruled
out by measurement, so no round re-tests them.

## Build phase order (so you know where to pick up)

1. ~~Core scaffold + contracts~~ — done, committed
2. ~~Subsystem build (7 parallel agents, 59 modules)~~ — done, committed `043c624`
3. ~~Integration: `main.js` + defects S1–S15, then the boot doctor~~ — done
4. ~~Harness performance + determinism~~ — done, `docs/HARNESS.md`
5. Visual critique loop: shoot → harsh critic → fix → re-shoot, per `docs/CRITIQUE_RUBRIC.md` —
   *in progress, round 14*
6. Playtest / balance / performance pass — not started
