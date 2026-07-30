# Valkyrie Chronicles — project instructions

A ThreeJS tactical RPG (~56k lines) chasing the CANVAS-engine watercolour look of *Valkyria
Chronicles Remastered* (PS4). The work runs as a visual critique loop: render → harsh critic →
fix → re-render. `docs/RESUME.md` is the runbook, `docs/CRITIQUE_RUBRIC.md` is the critic's
brief and the record of dead ends, `docs/ARCHITECTURE.md` is the module map.

---

# RENDERING / SCREENSHOTS — read this before you render anything

## The commands

```bash
# ITERATE — ~1.6 s per shot. Starts the resident daemon on first use, reuses it forever.
node tools/shoot.mjs bridge                         # -> shots/bridge.png
node tools/shoot.mjs bridge /tmp/claude-501/b.png   # explicit out path
node tools/shoot.mjs tank,closeup,bridge            # several
node tools/shoot.mjs all                            # all twelve, ~18 s

# MEASURE — ~10 s per shot, byte-deterministic. For any number you QUOTE, and for
# any diff across rounds.
node tools/shoot.mjs --cold bridge

node tools/shoot.mjs --list         # shot names
node tools/shoot.mjs --verify tank  # assert a shot is reproducible on the fast path
node tools/shoot.mjs --stop         # kill the daemon
```

`npm run shoot` / `shoot:all` / `shoot:cold` / `renderd:stop` wrap the same thing.

The twelve shots: `overview command action aim firefight tank village closeup grass dusk
bridge squad`.

## The rules

- **There is ONE shot tool: `tools/shoot.mjs`.** `tools/shootBatch.mjs` is **deleted** — it was
  not the fast path, it cost the same 12.2 s/shot as the old `shoot.mjs`. If you find a
  reference to it anywhere, it is stale; fix it.
- **Never launch your own browser or Playwright instance.** Rendering is GPU-bound and
  serialises on one GPU. The daemon exists so many agents share one browser by queueing.
  Eight agents each booting chromium is 8 × 7 s of boot, 8 × the VRAM, and near-zero
  throughput gain (measured: load average 4.5, 9 chromium processes, renders slowed roughly
  in proportion).
- **Never start your own vite**, and **never kill vite**. `shoot.mjs`/`renderd.mjs` bring one
  up on 127.0.0.1:5173 if needed and deliberately leave it running. Vite transforms all 65 ES
  modules on first request; killing it makes the next render re-pay the whole cold transform.
- **Never pass `--wait`.** It is accepted and ignored. `--wait 0` and `--wait 3500` were
  measured byte-identical: `__READY__` *is* the settled frame.
- **Render your own frame. Never judge a pre-existing `shots/*.png`.** It costs 1.6 s. Round 15
  lost an entire agent's work reviewing a stale frame.

## Fast vs cold — which to use

| | resident (default) | `--cold` |
|---|---|---|
| cost | **1.6 s** | ~10 s |
| same shot twice | 0.000% differing, max delta 0 | 0.000%, max delta 0 |
| with another shot posed in between | 0.369% @ mean 5.7 LSB | n/a |
| vs the other mode | 67% of pixels @ **mean 1.71 LSB** | — |

- **Iterating** on geometry, a material, a shader → **resident**. A broad 1.7 LSB offset cannot
  mislead you about form, silhouette or hue, which move 10–40 LSB when they change at all.
- **Quoting a measurement in a critique, or diffing round N against N-1** → **`--cold`**. A
  cross-round regression smaller than the resident offset is unknowable — that is the trap that
  made rounds 1–8's regression claims worthless.

A resident world **cannot rewind stateful animation** (cloud drift, water surface, wind phase,
particle pools); a cold boot rebuilds it from a seed. That is the whole reason both modes exist.

## Why it is fast (and what was actually wrong)

Before: **both** harnesses cost ~12.4 s/shot, because both launched chromium, `goto`'d,
generated the world, compiled ~87 shaders, settled, screenshotted, and **threw the whole
browser away**. None of that cost is per-shot — shots differ only in camera, sun and unit
poses (a few hundred ms) against ~7 s of boot. `tools/renderd.mjs` keeps the browser and built
world resident and re-poses them per request.

| | before | after |
|---|---|---|
| one shot, warm | 12.5 s | **1.6 s** |
| twelve shots | 36.6 s | **18.2 s** |
| daemon boot (once per session) | — | 7.3 s |

Two pure-waste bugs removed along the way:
- `shootBatch` ran `server.kill()` on vite at exit, **poisoning the next render**.
- The settle ran a **fixed 120 frames** having converged at frame 14 — ~1.8 s/shot of provably
  identical output.

Do not "optimise" by reintroducing per-render browsers, and do not trust a stale claim about
harness cost — **benchmark it**. `docs/HARNESS.md` claimed "~6 s warm" for two rounds while the
real number was 12.5 s.

## Determinism contract — do not break these

- `main.js` runs capture mode on a **virtual clock** (`clock.getDelta = () => CAPTURE_DT`,
  1/60). Its rule is *identical shot name ⇒ identical frame count ⇒ identical pixels.*
- `captureFlow()` leaves `getDelta = () => 0` and `engine.paused = true` behind. The daemon's
  settle therefore runs at **dt = 0**. Do **not** "fix" this by running the clock: settling at
  dt = 1/60 with `engine.time` reset to 0 was measured at **76% of pixels differing** between
  two renders of the same shot, because resetting `engine.time` relabels the simulation without
  rewinding it.
- `engine.paused = true` before every screenshot is load-bearing. Without the frozen shutter
  two runs of the same harness differed by **8.44%** of pixels.
- The settle frame count must stay **fixed**, not convergence-driven — a convergence-driven
  stop makes the frame count a function of machine load.

## `resetShotState()` — keep it in sync

`captureShots.js` exports `resetShotState(ctx)` and calls it at the top of `runShot()`. It
resets modes (`exitAim()` before `exit()` — aim is a sub-state of action mode), `timeScale`,
phase, command mode, camera fov to the base 32, and `hideAll()`.

**If you add a shot that sets something which is not per-unit pose, it belongs in there.**

This is the correctness half of a resident renderer, not a nicety. Round 15: `aim` left
action-mode's over-the-shoulder camera latched, `tank` inherited it, and the shipped `tank`
plate measured mean 35.8 LSB from a cold render while matching the `aim` frame. A whole round of
running-gear work was reviewed on the wrong frame and scored as a failure. Only 7 of 12 shots
called `hideAll()`, so unit visibility leaked the same way.

`node tools/shoot.mjs --verify <shot>` renders a shot, poses a *different* shot, renders the
first again, and reports byte-equality — i.e. whether the reset covers everything that shot
mutates.

## Other measured harness facts

- **Dev server beats `vite preview`** for the edit→render→edit loop: preview loads ~0.4 s
  faster but `vite build` costs ~1.8 s after every edit.
- `tools/pxstats.mjs` measures a PNG (mean RGB, hue, darkest/brightest, histograms) and its
  `decodePng` is importable for writing throwaway diff scripts.
- Health gate after any batch of edits:
  ```bash
  find src -name '*.js' | xargs -n1 node --check
  npx vite build
  node tools/shoot.mjs all
  ```

---

# Inline vs subagent vs workflow

Pick by fit, not by ambition.

| Do it | When |
|---|---|
| **Inline** | Dependency chains (step N+1 needs N's result), diagnosis, small mechanical edits, tight edit→render→look loops. An agent's orientation cost is minutes — don't pay it to change a hex value. |
| **Subagents** | Genuinely independent work over disjoint inputs (N shots, N modules); context-heavy reads (4 MB PNGs); adversarial review, where independence *is* the value. |
| **Workflow** | Only for deterministic control flow you will re-run. One-shot fan-out → plain `Agent` calls; you stay in the loop and catch bad frames early. |

Measured on this repo: a 14-agent workflow round cost 71 min / 2.25M tokens and moved scores
3.7 → 4.3 (still REJECT), with 2 of 6 fix claims not landing. The same session's inline harness
work took ~25 min and got 7.4×. Fan-out cannot compress a chain.

But subagents caught what solo work missed: the corrupt `tank` frame and the ink-floor violet
regression. Keep adversarial verifiers.

# Faster rounds — the levers, in order

1. **No gate agent.** Build + parse + render is three shell commands (~25 s inline). As an agent
   it is a whole serial stage, and it once rendered all 12 shots twice.
2. **Bound every fix agent**: at most 4 render-check cycles, then report honestly. Unbounded
   "iterate until better" is where 20 minutes disappears.
3. **Pipeline, don't barrier.** Serial barriers make wall clock sum-of-slowest-per-stage.
4. **Render only the shot your finding names.** Not all 12.
5. **Re-verify only shots whose owning modules changed.** 2–3 shots per round, not 12.
6. **Effort tiers**: low for mechanical fixers (location already pinned), high only for critics
   and verifiers.
7. **Critique output must pin `file:line` + an acceptance test.** That is what makes the next
   round's fixer prompts cheap.

Concurrency cap here is 10 (12 cores − 2). Disjoint file ownership is mandatory for parallel
agents — concurrent edits to one module conflict and get reverted.

# Non-negotiables

- **The picture wins over the metric.** Every metric in `docs/CRITIQUE_RUBRIC.md` has been
  satisfied at least once without the picture improving. Read its "metric integrity" and
  dead-end sections before measuring. Never re-propose a ruled-out fix.
- **An honest miss beats a false claim.** A fix that did not land, reported as success, costs the
  next round a whole cycle.
- **Darkening a colour is not a luminance-only operation.** Re-author hue and chroma at the new
  luminance and measure there. See the round-15 ink-floor entry in the rubric.
