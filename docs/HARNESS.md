# Screenshot harness — the resident renderer

## Use these commands

```bash
# Iterate. ~1.6 s per shot. Starts the render daemon on first use, reuses it after.
node tools/shoot.mjs bridge
node tools/shoot.mjs bridge /tmp/claude-501/b.png
node tools/shoot.mjs tank,closeup,bridge
node tools/shoot.mjs all                      # twelve shots, ~18 s warm

# Authoritative / byte-deterministic. ~11 s per shot. For numbers you QUOTE and
# for any diff across rounds.
node tools/shoot.mjs --cold bridge

node tools/shoot.mjs --list        # shot names
node tools/shoot.mjs --verify tank # prove a shot is reproducible on the fast path
node tools/shoot.mjs --stop        # kill the daemon
```

`npm run shoot`, `shoot:all`, `shoot:cold`, `renderd:stop` wrap the same thing.

Do **not** pass `--wait` (accepted and ignored — measured to buy nothing). Do **not**
start your own vite on your own port. Do **not** launch your own browser per render.

## Why it is fast now

Every earlier harness paid the same fixed cost on **every** render, and that cost dwarfed
the frame. Measured at 1920x1080 against a warm vite server, before this change:

| harness | one shot |
|---|---|
| `tools/shoot.mjs` (old) | **12.5 s** |
| `tools/shootBatch.mjs` (deleted) | **12.2 s** |

Both were the same number because both did the same thing: launch chromium, `goto`,
generate the world, compile ~87 shaders, settle, screenshot, **throw the whole browser
away**. The old version of this file claimed "~6 s warm"; that was stale by a wide margin.

None of that cost is per-shot — the shots differ only in camera, sun and unit poses, a few
hundred ms of work against ~7 s of boot. So `tools/renderd.mjs` keeps the browser and the
built world **resident**, and a request re-poses them:

| | before | after |
|---|---|---|
| one shot, warm | 12.5 s | **1.6 s** |
| twelve shots | 36.6 s | **17.6 s** (1.5 s/shot) |
| daemon boot (once per session) | — | 7.3 s |

The inner loop is what matters: an agent iterating on one material renders the same shot
twenty or thirty times, and that went from ~6 minutes of waiting to ~45 seconds.

Two smaller things were also pure waste, and are gone:

- **`shootBatch` killed the vite server on exit** (`server.kill()`), so a batch run
  *poisoned the next render*: vite transforms all 65 ES modules on first request, and the
  following `goto` re-paid the whole cold transform. Nothing kills vite now.
- **The batch settle ran a fixed 120 frames** having converged at frame 14 — ~106 frames,
  about 1.8 s per shot, of provably identical output.

## The determinism split — read this before quoting a number

Cold renders are **byte-identical** run to run: measured 0.000% of pixels differing, max
delta 0. That is because a cold boot rebuilds the world's *stateful* animation — cloud
drift, water surface, wind phase, particle pools — from a seed.

**A resident world cannot rewind that state**, and the attempt to fake it is instructive:

| resident settle | pixels differing, same shot twice |
|---|---|
| dt = 1/60 with `engine.time` reset to 0 | **76%** |
| dt = 0 (what we do) | **0.000%** back to back |

Running the clock is *worse*, because resetting `engine.time` only relabels the simulation,
it does not rewind it — a running settle advances clouds and water another N frames from
wherever the last shot left them, so every render lands somewhere new. The settle therefore
runs at dt = 0, which main.js's own FREEZE comment correctly notes is not perfectly inert
(foliage LOD re-streams per call, the shadow rig snaps, the material registry re-arms).

What that leaves, measured on `bridge`:

| comparison | result |
|---|---|
| resident, same shot back to back | **0.000%**, max delta 0 |
| resident, same shot with another shot posed in between | 0.369% @ mean 5.7 LSB |
| resident vs cold | 67% of pixels @ **mean 1.71 LSB** |

That last number looks alarming and is not — it is a broad, very low-amplitude tonal offset,
not a structural difference, and it agrees with the 63%-of-pixels->2-LSB figure the old batch
harness measured for the same reason. Form, silhouette and hue move by 10–40 LSB when they
change at all, so 1.7 LSB cannot mislead you about whether a mesh or material edit landed.

**The rule:**

- **Iterating** on geometry, a material, a shader → resident. 8x faster, and it cannot lie to
  you at the scale you are working at.
- **Quoting a measurement in a critique, or diffing this round against the last** → `--cold`.
  A cross-round regression smaller than the resident offset is unknowable, which is exactly
  the trap that made rounds 1–8's regression claims worthless (see below).

`--verify <shot>` renders a shot, poses a *different* shot, renders the first again, and
reports whether the two are byte-identical — i.e. whether `resetShotState()` covers
everything that shot mutates.

## State reset — the correctness half of going resident

A resident world accumulates state, and round 15 proved what that costs. Every shot was
rendered into one booted world, and a shot only set the state it cared about: `aim` took
`battle.actionMode` into over-the-shoulder aim and nothing put it back, so the **next** shot
inherited that camera. The shipped `tank` plate measured mean 35.8 LSB from a cold `tank`
render and matched the `aim` frame instead. An entire agent's running-gear work was reviewed
on the wrong frame and scored as a failure.

Only 7 of the 12 shots called `hideAll()`, so unit visibility leaked the same way.

`captureShots.js` now exports **`resetShotState(ctx)`** and calls it at the top of
`runShot()`: modes (`exitAim()` before `exit()`, since aim is a sub-state of action mode),
`timeScale`, phase, command mode, camera fov back to the base 32, and `hideAll()`. Keep it in
sync — **if a new shot sets something that is not per-unit pose, it belongs in there.**

Without that reset a resident renderer is not a speedup, it is a correctness bug.

## Still true: `--wait` buys nothing, and the shutter must be frozen

`--wait 0` and `--wait 3500` produced **byte-identical** frames (0.00% differing, max delta
0). `main.js` already holds frames until every render counter, the DOM label layer and the
pipeline's temporal DoF converge, so `__READY__` *is* the settled frame. The flag is accepted
and ignored so old commands do not break.

The engine is paused before every screenshot. Without that, two runs of the *same* harness
differed by **8.44% of pixels**, which means every "regression" smaller than that measured
across rounds 1–8 was inside the noise floor and unknowable. `engine.paused` skips the system
pass while still re-rendering, so the scene graph is provably constant at the shutter.

## Build + preview vs dev server

Benchmarked both. `vite preview` on the built bundle loads ~0.4 s faster than the dev server,
but `vite build` costs **1.8 s after every edit**. For the edit → render → edit loop the
**dev server wins**. Preview only pays off when rendering many shots without touching source.

## Concurrency — one daemon, not one browser per agent

Rendering is GPU-bound and serialises on one GPU. Four fix agents each spawning their own
vite server and chromium produced a load average of 4.5 with 9 chromium processes and 6 vite
servers, and each agent's renders slowed roughly in proportion — net throughput gain near
zero, memory cost 4x.

The daemon makes this a non-issue: it **serialises** requests (one page, so two concurrent
`/shoot` calls would pose over each other) and many agents share it safely by queueing. Eight
agents each booting chromium would be 8 × 7 s of boot and 8 × the VRAM, and they would
contend for the GPU anyway.
