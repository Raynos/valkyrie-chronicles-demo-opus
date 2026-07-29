# Screenshot harness — how to render fast, and why it used to be slow

## Use these commands

```bash
# ONE server for the whole session. Start it once, leave it up.
npx vite --host 127.0.0.1 --port 5173 --strictPort &

# One shot (authoritative). ~6 s warm, byte-identical run to run.
node tools/shoot.mjs tank shots/tank.png

# All twelve shots (one boot, re-posed in-page). ~40 s total, ~3.3 s/shot.
node tools/shootBatch.mjs all --out shots
```

Do **not** pass `--wait`. Do **not** start your own server on your own port.
Do **not** create a git worktree with a copied `node_modules` unless you are
genuinely running an isolated competing implementation.

## Measured cost, 1920x1080

| stage | before | after |
|---|---|---|
| chromium launch | 118 ms | 118 ms |
| `goto` | 3.3 s | 2.6-3.2 s |
| boot → `__READY__` | **13.1 s** | **3.1-3.5 s** |
| post-`__READY__` wait | 2.5-3.5 s | **0** |
| screenshot encode | 2.1 s | 0.3 s |
| **total per shot** | **18.8 s** | **~6 s** (8-9 s under load) |
| **twelve shots** | **~226 s** | **~40 s** |

## The three things that were wrong

**1. The harness killed its own dev server after every screenshot.**
Vite transforms all 64 ES modules on first request. A freshly spawned server has
a cold transform cache, so every single render re-paid ~13 s of work that a warm
server answers from memory. `shoot.mjs` now leaves the server up; the next
invocation finds it via `portOpen()` and reuses it. Pass `--kill-server` if you
really want a clean process tree.

**2. `--wait 3500` bought nothing.** Measured: `--wait 0` and `--wait 3500`
produce **byte-identical** frames (0.00% of pixels differing, max delta 0).
`main.js` already holds frames until every render counter, the DOM label layer
and the pipeline's temporal DoF have converged — `__READY__` *is* the settled
frame. The default is now 0.

**3. The frame was not frozen, so captures were not reproducible.**
The game keeps animating after `__READY__` (wind, cloud drift, water, particles),
so the frame depended on when the shutter landed. Two runs of the *same* harness
differed by **8.44% of pixels** — which means every "regression" smaller than
that measured across rounds 1-8 was inside the noise floor and unknowable.
`shoot.mjs` now sets `engine.paused = true` before the screenshot. Two runs in
separate browser launches now measure **0.00% differing, max delta 0**.
Pass `--no-freeze` if you are deliberately capturing motion.

## Batch mode caveat

`tools/shoot.mjs` is **authoritative**. `tools/shootBatch.mjs` boots once and
re-poses the existing world via `runShot()`, which is 4x cheaper per shot but is
**not equivalent**: shots leave residual world state (every shot calls `setSun`,
only some call `hideAll`), so frames after the first differ from their cold-boot
equivalent — measured at **63% of pixels >2 LSB**. Use batch for iteration and
for regenerating the whole set; re-render with `shoot.mjs` before reporting a
measured result or a regression.

## Build + preview vs dev server

Benchmarked both. `vite preview` on the built bundle loads ~0.4 s faster than the
dev server, but `vite build` costs **1.8 s after every edit**. For the
edit → render → edit loop the **dev server wins**. Preview only pays off when
rendering many shots without touching source.

## Parallelism does not help rendering

Rendering is GPU-bound and serialises on one GPU. Four fix agents each spawning
their own vite server and chromium produced a load average of 4.5 with 9 chromium
processes and 6 vite servers, and each agent's renders slowed roughly in
proportion — net throughput gain near zero, memory cost 4x. Prefer two concurrent
agents sharing one warm server over four with their own.
