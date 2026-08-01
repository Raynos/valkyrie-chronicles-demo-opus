# r25 audit — perf

**Verdict:** blocker

## Summary
The shipped configuration does not hold 60 fps anywhere, on an Apple M3 Pro (18-core GPU), in a small 1496x721 window. Played build, DPR 2, renderScale 1.0: action mode mean 20.7 ms / p99 22.8 ms (48 fps), command map 22.2 ms (45 fps), title orbit — the very first thing anyone sees — 23.1 ms (43 fps). Maximise the window to 1728x1080 CSS and it is 33.7 ms / 29 fps. The frame is purely fill-bound and fits T = 3.5 ms + 4.0 ms per megapixel of drawing buffer to within 0.4 ms across six measured points, so the shipped 4.31 Mpx buffer is 31% over the 60 fps budget and 126% over it maximised. finish_plan's P0 escape clause ("the passes deleted in P1 pay for it") is false by measurement: I priced every post pass and the whole stack minus the G-buffer prepass is only 4.9 ms of a 22.4 ms frame, and the prepass IS the ink. Only resolution pays. Second: there is no loading screen, and the first 2.7 s of boot is one unbroken synchronous main-thread block — the tab is frozen, not merely blank (Playwright could not service a screenshot request until 3.78 s). Production build reaches the title card at 3.53 s and action mode at 8.85 s with a bot pressing Enter every 350 ms. Third: there is no working degradation path — the pause menu's "Render Quality" option never calls the function written to implement it, there is no resolution option at all, and ?rs is a measured no-op on any 1x display. The good news is real: zero leaks over 60 s of live play, and the shader precompile behind the title card works exactly as documented.

## Do not touch (verified good)
1. THE SHADER PRECOMPILE (src/main.js:1109 precompilePlay). Measured: 89 programs in 794 ms (production) / 985 ms (dev), all of it behind the title card, and renderer.info.programs never grows during play (93, flat over 60 s). The round-21 problem it was written to solve is genuinely solved — there are no compile stalls in gameplay. Do not touch it.

2. NO LEAKS, ANYWHERE. 60 s of live action-mode play at the shipped setting, 7 samples: textures 89 -> 92 then flat, geometries 295 flat, programs 93 flat, scene.children 59 flat, JS heap 189.8 MB flat to the decimal. The fx pools are capacity-bounded (fx.js:502-610), the onomatopoeia canvases are cached per word (fx.js:1141-1164) and its sprites are disposed on expiry (fx.js:1197). No per-frame texture regeneration. This is a clean renderer and the audit found nothing to fix here.

3. THE r22 CADENCES ARE REAL AND CORRECTLY BUILT. Stats period 3 and shadow period 2 verified live (statsPeriod: 3, shadowPeriod: 2 in the played build, forced to 1 only under ?capture). Pushing shadow period 2 -> 4 buys 0.10 ms; the cadences are already at the point of diminishing returns. Do not spend a round here.

4. DRAW CALLS AND TRIANGLES ARE NOT THE PROBLEM AND MUST NOT BE "OPTIMISED". 400-550 draws, 1.1-2.2 M triangles. Overview (546 draws / 2.19 M tris) and firefight (423 draws / 2.01 M tris) render within 3% of each other at the same resolution, and halving the resolution triples the frame rate on both. Batching work would buy nothing measurable.

5. The pixelRatio() single-source-of-truth refactor (config.js:162-169) is the right shape — the fix below is three lines inside it precisely because that consolidation already happened.

## Findings

### [blocker | small | verified] Shipped renderScale 1.0 misses 60 fps in every camera on an M3 Pro, and by 2x when the window is maximised

**Location:** `src/core/config.js:58`

**Evidence:** Measured by me, headless chromium (--disable-frame-rate-limit, so rAF deltas are true production time), Apple M3 Pro / ANGLE Metal, PLAYED build (?pin, no ?capture, so shadow cadence 2 and stats cadence 3 are the shipped ones), deviceScaleFactor 2, interleaved renderScale arms in one browser session so GPU weather cancels.

1496x721 CSS = 2992x1442 buffer, ACTION MODE, 400 frames/arm x 4 clean reps (1600 samples/arm):
  rs=1.0 (SHIPPED)  min 18.1  mean 20.72  p50 20.7  p95 22.3  p99 22.8  max 23.5  -> 48 fps
  rs=0.75           min 10.8  mean 13.00  p50 13.0  p95 14.6  p99 15.0  max 15.1  -> 77 fps
  rs=0.5 (r23)      min 5.6   mean 7.80   p50 7.7   p95 9.2   p99 9.5   max 9.9   -> 128 fps
Same window, COMMAND MAP (300 frames x 4 reps): rs=1 mean 22.19-22.72 -> 44-45 fps.
Same window, TITLE ORBIT, i.e. the first thing any viewer sees (300 x 3): rs=1 mean 23.09-23.56 -> 43 fps.
1728x1080 CSS = 3456x2160 buffer, action mode (300 x 3): rs=1 mean 33.69/33.85/34.18, p99 36.5 -> 29 fps. rs=0.75 mean 20.1 -> 49 fps (still short). rs=0.5 mean 10.7 -> 94 fps.
Capture-posed heavy shots for cross-check (cadences forced to 1, so pessimistic), 400 x 3 clean reps: overview rs=1 mean 26.62/26.84, p99 30.1-30.6; firefight rs=1 mean 26.06/26.91.

The frame is purely fill-bound. Fitting all six played-build points gives T = 3.5 ms + 4.0 ms per megapixel of drawing buffer, and it predicts every measurement to within 0.4 ms: 1.078 Mpx -> 7.8 predicted vs 7.80 measured; 1.866 Mpx -> 11.0 vs 10.7; 2.42 Mpx -> 13.2 vs 13.00; 4.31 Mpx -> 20.7 vs 20.72; 7.46 Mpx -> 33.3 vs 33.69.

The 60 fps budget (16.67 ms) is therefore 3.29 Mpx, and a p99-safe budget (14.5 ms mean) is 2.75 Mpx. The shipped config draws 4.31 Mpx in a small window and 7.46 Mpx maximised. And this is an M3 Pro: a MacBook Air M1 (8 GPU cores vs 18) lands near 20 fps.

finish_plan.md P0's fallback ("the passes deleted in P1 pay for it; take the resolution over the effects") does not exist. I priced every pass at rs=1 in action mode, median p50 of 3 reps x 250 frames, base 22.40 ms: prepass off -4.90, contact off -2.00, grade off -1.40, shadow map off -0.60, bloom off -0.50, stats off -0.40, shadow period 2->4 -0.10. Everything except the G-buffer prepass totals 5.0 ms, and the prepass is what the contour ink reads. There is no 4 ms of expendable effect left to spend.

**Proposed fix:** Stop expressing the budget as a scale factor and express it as a pixel count, inside the one function that already owns this. In src/core/config.js replace the body of pixelRatio() (:162-169) with a budget cap:

  const BUDGET_PX = 3.0e6;   // ~15.5 ms on an M3 Pro by the measured fit
  const w = innerWidth, h = innerHeight;
  const cap = Math.sqrt(BUDGET_PX / Math.max(1, w * h));
  const authored = Math.min(dpr, CFG.render.maxPixelRatio, cap) * CFG.render.renderScale;
  return Math.max(0.5, authored * CFG.render.dynScale);

This gives 1.67 (rs-equivalent 0.83) at 1496x721 and 1.27 (rs-equivalent 0.63) at 1728x1080 — both land on ~3.0 Mpx, i.e. ~15.5 ms, i.e. 60 fps with p99 headroom, at every window size instead of only one. renderScale stays as the authored multiplier and ?rs stays as the override. Note this is NOT the round-21/22 dynamic ratchet the engine correctly retired (engine.js:107-137): the ratchet was a silent, drifting, self-degrading response to measured frame times and could never recover; this is a fixed function of window size, decided once at resize, and it never changes mid-session.

Also drop the Math.max(0.75, ...) floor to 0.5 (see the separate finding) so the cap can actually bind on a 1x display.

Visual cost, honestly: at 1496x721 this renders 1.67 device px per CSS px instead of 2.0 — a 17% linear resolution reduction, upscaled by the browser. That is a fraction of the 2.0 -> 1.0 halving that r24 P0 correctly identified as destroying 54% of local contrast, and it stays above the 1:1 line that r23 was sitting at.

**Acceptance test:** node /private/tmp/claude-501/-Users-raynos-projects-game-demos-valkyrie-chronicles-demo-opus/9bfd6309-a467-4f65-a389-55c29ed290ad/scratchpad/playperf.mjs --n 400 --reps 4 --scales 1
  and the same with --w 1728 --h 1080. PASS = mean <= 16.0 ms AND p99 <= 18.0 ms at BOTH window sizes, in action mode, with 4 reps agreeing to within 1 ms (disagreement means another agent was on the GPU — re-run, do not average). Then repeat with --mode command and --mode orbit; both must also be under 16.0 ms mean. Machine must be quiet: check `ps aux | grep -c '[c]hrome-headless-shell --type=gpu-process'` is 1 before starting.

### [blocker | medium | verified] No loading screen, and the first 2.7 s of boot is a frozen main thread, not merely a blank one

**Location:** `index.html:19`

**Evidence:** index.html:18-21 is a bare canvas plus an empty #hud div on a #17120e background. Nothing is drawn, and nothing says anything, until main.js has finished building the world.

Measured on the PRODUCTION build (dist, built 14:43 from the current tree, single 2.0 MB JS chunk / 612 KB gzipped, served by the running vite preview on :4173, i.e. no network latency at all):
     20 ms  navigation committed
   2752 ms  window.__ENGINE__ exists (module eval + world generation + 13 character rigs done)
   3508 ms  precompile: 89 programs in 794 ms
   3530 ms  TITLE CARD visible — the first thing a human sees
   8851 ms  action mode, in control of a soldier (bot pressing Enter every 350 ms, 14 presses)
Dev server for comparison: 4309 ms to title, 9791 ms to action, precompile 985 ms. So r22's "13.4 s from page load to playing" is now 8.9 s machine-paced; the claim holds as an upper bound for a human.

The 2.7 s is not just visually blank, it is a blocked main thread: a page.screenshot() request issued at t=500 ms could not be serviced until t=3775 ms. A real user gets an unresponsive tab. Confirmed by a CDP CPU profile of the boot (4515 ms window, 12866 samples at 200 us): only 370 ms of idle in the whole window. Self time by module — three.js 1619 ms (of which onFirstUse/shader compile 590 ms, getExtension 144 ms), actors/rig.js 557 ms (gauss 99, finish 80, bakeAO 74, skull 47), render/textures.js 550 ms (cellF1 Worley noise 268, wrap 96), native+GC 544 ms, world/layout.js 251 ms (polySDF 212), world/terrain.js 165 ms, core/rng.js 148 ms, world/textures.js 142 ms, world/vegetation.js 128 ms.

For a published demo this is the single biggest bounce risk in the build, and it is worse than these numbers over a real network: add ~1 s for 612 KB on a mid-tier connection, all of it also with nothing on screen.

**Proposed fix:** Two things, in this order.

(a) Put static markup in index.html:19 — before any JS runs — showing the title, an ink rule, and the word "Loading". It costs no JS and it converts 3.5 s of black into 3.5 s of a title card. Remove it from the DOM in playFlow() once the real title card mounts.

(b) Break the synchronous block so the progress text can actually advance. src/main.js:1056 `const S = buildSystems();` runs the whole world build in one turn. Make buildSystems an async generator or split it at its existing seams (lights -> World -> pipeline -> fx/physics -> Battle.setup -> ui, main.js:160-259), awaiting a rAF between stages and posting a stage name to the loading card. Each yield costs one frame; the profile says the four biggest stages are World/terrain+layout (~420 ms), render/textures.js procedural texture bakes (~550 ms), the 13 character rigs (~557 ms) and vegetation (~128 ms), so four or five yields turn a dead 2.7 s into a progress bar that moves five times.

Do NOT move the shader precompile earlier — it is already correctly placed behind the title card and is not part of the frozen window.

**Acceptance test:** node /private/tmp/claude-501/-Users-raynos-projects-game-demos-valkyrie-chronicles-demo-opus/9bfd6309-a467-4f65-a389-55c29ed290ad/scratchpad/loadprod.mjs (after `npx vite build`). PASS = (i) a screenshot taken at t=400 ms shows readable text, not a flat #17120e field; (ii) page.screenshot() issued at t=500 ms returns within 200 ms, proving the main thread is not blocked; (iii) the marks log still shows the title card at or before 4.0 s. Verify (ii) explicitly — it is the part that distinguishes a real fix from a static placeholder over a still-frozen tab.

### [major | small | verified] The pause menu's "Render Quality" option never calls the function that implements render quality, and there is no resolution option at all

**Location:** `src/ui/hud.js:3030`

**Evidence:** hud.js:3030 is the whole implementation: `if (key === 'quality') CFG.quality = ['Low','High','Ultra'].indexOf(value);`. It writes a number into config and stops.

CanvasRenderPipeline.setQuality() (canvasRenderPipeline.js:2965) is the function written to do this properly — it recompiles the composite/grade defines and calls MaterialRegistry.setQuality(). `grep -rn setQuality src/` returns exactly one call site: canvasRenderPipeline.js:2274, inside its own constructor. The menu never reaches it.

So everything expensive was baked before the menu existed: pipeline defines (:2212 this.quality = CFG.quality), material defines (materials.js:2175/:2410/:2686 read CFG.quality at build), shadow map size (lighting.js:378, world.js:153), terrain LOD (terrain.js:58), vegetation density (vegetation.js:430). The only live readers of CFG.quality after boot are fx.js particle counts (fx.js:501-1040). Choosing "Low" mid-session therefore changes nothing a frame-time meter can see. It is also constructed AFTER the pipeline (main.js:195 pipeline, :258 ui), so even the localStorage-restored value at :783 lands too late to matter next session.

And the option list itself (screens.js:748-754) contains Render Quality, Flourishes, Paper Grain, Music, Effects, Invert Aim — with no Resolution row. Resolution is the ONLY knob that moves this frame (see the pass-cost table in finding 1: everything except the prepass is 5.0 ms of a 22.4 ms frame), and it is the one thing the player cannot touch.

**Proposed fix:** Two edits.
(a) hud.js:3030 — route the option through the real implementation: `if (key === 'quality') { CFG.quality = i; S.pipeline?.setQuality(i); }` (the HUD needs a pipeline handle, or emit `ui:option` and have main.js call it — main.js already owns S). Then either make it honest or delete the row: setQuality cannot re-generate the terrain, vegetation or shadow map, so if the row stays, label it for what it now does.
(b) screens.js:748 — add the row that matters: `{ key: 'resolution', name: 'Resolution', values: ['Performance','Balanced','Native'], index: 1 }`, mapped to renderScale 0.6 / 0.8 / 1.0 (or to BUDGET_PX 2.0e6 / 3.0e6 / Infinity if finding 1's fix lands), applied via `CFG.render.renderScale = x; engine.onResize()` — which I verified works live: setting it at runtime and calling onResize() re-allocates every render target and changes the backing store immediately (measured 2992x1442 -> 2244x1081 -> 1496x721 within one session, hundreds of times, with no artefacts).

**Acceptance test:** Open the pause menu, set Render Quality to Low, and check `window.__ENGINE__.pipeline.quality === 0` and that renderer.info.programs has GROWN (setQuality recompiles). Then set Resolution to Performance and check `__ENGINE__.renderer.domElement.width` drops without a reload. Both are one page.evaluate each — no new harness needed.

### [major | small | verified] renderScale is a measured no-op on every 1x display, and the only remaining lever floors at 0.75

**Location:** `src/core/config.js:59`

**Evidence:** pixelRatio() = max(minPixelRatio, min(dpr, maxPixelRatio) * renderScale) then max(0.75, that * dynScale). With minPixelRatio = 1 (config.js:59), any dpr <= 1 makes the renderScale term collapse to the floor.

Measured end-to-end, one headless browser, reading renderer.getPixelRatio() and the canvas backing store on the live played build:
  deviceScaleFactor 2, no query     -> pr 2.00  buffer 2992x1442
  deviceScaleFactor 2, ?rs=0.5      -> pr 1.00  buffer 1496x721
  deviceScaleFactor 2, ?rs=0.25     -> pr 1.00  buffer 1496x721   (floored)
  deviceScaleFactor 1, no query     -> pr 1.00  buffer 1496x721
  deviceScaleFactor 1, ?rs=0.5      -> pr 1.00  buffer 1496x721   (NO-OP)
  deviceScaleFactor 1, ?rs=0.25     -> pr 1.00  buffer 1496x721   (NO-OP)
  deviceScaleFactor 1, ?ds=0.5      -> pr 0.75  buffer 1122x540
  deviceScaleFactor 1, ?ds=0.1      -> pr 0.75  buffer 1122x540   (floored, config.js:168)

So on a 1x display — the majority of Windows laptops and desktop monitors — the documented escape hatch does nothing at all, and the only lever that survives is an undocumented ?ds that bottoms out at 0.75 pixel ratio, i.e. 56% of the fill. On this M3 Pro that is fine; on the Intel Iris Xe class of machine a general player is likely to open a demo on, 0.75 is not enough of a step to recover a missed budget, and there is no lower gear at all. There is also no GPU detection and no startup calibration: CFG.quality is hard-defaulted to 2 (ultra) at config.js:6 for every machine that ever loads the page.

**Proposed fix:** config.js:59 — the comment at :46 justifies minPixelRatio as "so a 1x display is never rendered BELOW its own resolution". That was the right call when the alternative was a blurry default; it is the wrong call as a HARD floor on the manual override, because it means the manual override does not exist on half the world's displays. Keep 1 as the floor for the AUTHORED default and let an explicit ?rs / options choice go below it: compute `const floor = qs.has('rs') ? 0.5 : CFG.render.minPixelRatio;`. Then lower the absolute clamp at config.js:168 from 0.75 to 0.5 so ?ds has a lower gear too.
Separately, gate the default: read the WEBGL_debug_renderer_info string once at boot and start at BUDGET_PX 2.0e6 (or renderScale 0.75) on anything that is not a discrete/Apple-Silicon GPU. An honest lower default beats the silent ratchet the engine correctly deleted.

**Acceptance test:** node /private/tmp/claude-501/-Users-raynos-projects-game-demos-valkyrie-chronicles-demo-opus/9bfd6309-a467-4f65-a389-55c29ed290ad/scratchpad/rscheck.mjs — the table it prints must show deviceScaleFactor 1 + ?rs=0.5 producing a 748x360 backing store (not 1496x721), and deviceScaleFactor 1 + ?ds=0.5 producing pixel ratio 0.5. deviceScaleFactor 2 with no query must still be 2992x1442 (or whatever finding 1's budget cap produces) — the default must not regress.

### [minor | medium | likely] The G-buffer prepass is 4.9 ms — 22% of the frame — and one of its two full-resolution half-float attachments carries three 8-bit quantities

**Location:** `src/render/canvasRenderPipeline.js:3067`

**Evidence:** Pass cost at the shipped setting (rs=1, DPR2, 1496x721 CSS, played build, action mode), median p50 of 3 reps x 250 frames, each arm interleaved against a fresh baseline in one session:
  base              22.40 ms
  no-prepass        17.50 ms   -4.90   <-- the largest single item in the post stack
  no-contact        20.40 ms   -2.00
  no-grade          21.00 ms   -1.40
  shadow map off    21.80 ms   -0.60
  no-bloom          21.90 ms   -0.50
  no-stats          22.00 ms   -0.40
  shadow period 2->4 22.30 ms  -0.10

The prepass (:3061-3072) is a second full geometry pass at full resolution into an MRT with two RGBA16F attachments plus a depth buffer (_buildTargets, :2861-2871). At 2992x1442 that is 69 MB of colour attachment written per frame plus 17 MB of depth; at 3456x2160 the whole render-target set totals 360.8 MB (measured in-page: gbuf MRT x2 + depth, hdr + depth, comp and gradeRT are all full-resolution RGBA16F; aoRT is correctly half-res at 14.2 MB and the bloom chain is a negligible 4.8 MB).

Attachment 1 is documented at :2860 as "object id (rg) + outline weight (b)" — three quantities that are ids and a weight, carried in 16-bit float across a full-resolution surface. Attachment 0 (view normal xyz + linear depth w) genuinely needs the precision; attachment 1 plausibly does not.

**Proposed fix:** Change gbuf attachment 1 to RGBA8 (three.js supports per-attachment texture types on a WebGLRenderTarget with count: 2 by assigning textures[1].type / .format after construction, at :2872 where the loop already touches both textures). That halves 34.5 MB/frame of write bandwidth at 2992x1442. The object id is currently packed into two channels precisely because it needed range — check that the id encoding at the prepass material still round-trips through 8 bits before committing, and if it does not, encode the id as a normalised 16-bit pair across rg (which 8-bit channels can carry exactly as well as float16 can).

I did NOT measure the saving — I measured only that the whole prepass is 4.9 ms, so the ceiling on this is somewhere under half of that. Treat it as a lead, not a claim. Do it only after finding 1's pixel budget lands, and only if the budget is still tight; it is not a substitute for the resolution fix.

Do not simply run the prepass at half resolution: the composite reads it for the contour ink, and softening the ink is exactly the regression r24 spent its round undoing.

**Acceptance test:** node /private/tmp/claude-501/-Users-raynos-projects-game-demos-valkyrie-chronicles-demo-opus/9bfd6309-a467-4f65-a389-55c29ed290ad/scratchpad/passcost.mjs before and after. PASS requires BOTH: (i) base p50 drops by >= 1.0 ms across 3 agreeing reps, and (ii) `node tools/shoot.mjs --cold closeup` and `--cold overview` come back with ink% within 0.15 of the r24 numbers in finish_plan.md (3.37 overview / 4.01 closeup) — if the ink moves, the id encoding lost precision and the change is a loss regardless of the milliseconds.
