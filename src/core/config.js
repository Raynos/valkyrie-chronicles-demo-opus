// Global tunables. Quality 0 = low, 1 = high, 2 = ultra.

const qs = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');

export const CFG = {
  quality: qs.has('q') ? parseInt(qs.get('q'), 10) : 2,
  debug: qs.has('debug'),
  seed: qs.has('seed') ? parseInt(qs.get('seed'), 10) : 20250728,

  // deterministic capture mode for the visual-critic harness
  capture: qs.has('capture'),
  captureShot: qs.get('shot') || null,

  // ?pin — veto vite's HMR *full reload* for the life of the page.
  //
  // A played-build harness (perf, playtest, AI-behaviour) has to hold one live
  // session for minutes. Any other agent editing any module in that window makes
  // vite's HMR client fall back to `location.reload()`, which silently restarts
  // the game from the title card in the middle of the measurement — round 21 saw
  // 14 of them in one 190 s session, and round 22's first perf run recorded a
  // 4025 ms frame and then measured the pre-battle orbit while believing it was
  // measuring action mode. `?capture` already vetoes this (pinModulesForCapture
  // in main.js); ?pin is the same veto for the played build, where there is no
  // shot to protect but a whole run to protect instead.
  pinModules: qs.has('pin'),

  render: {
    maxPixelRatio: 2,

    // ROUND 21 — the frame is fill-bound, and nothing else about it comes close.
    // Measured in play at 1600x900 CSS on a 2x display (3200x1800 drawing
    // buffer), everything on, GPU-synced per frame:
    //
    //   pixelRatio 2.0   58.4 ms   17 fps
    //   pixelRatio 1.4   33.6 ms   30 fps
    //   pixelRatio 1.0   22.1 ms   45 fps
    //   pixelRatio 0.75  16.2 ms   62 fps
    //
    // which fits T = 10.0 ms + 12.1 ms * ratio^2 to within 0.6 ms at every
    // point: a ~10 ms fixed cost (draw calls, vertex work, the shadow map) and
    // a fill cost that is quadratic in the pixel ratio. Rendering four device
    // pixels per CSS pixel therefore costs 36 ms a frame and buys resolution
    // that the paper substrate, the wash quantiser and the AA in the grade all
    // work to hide. renderScale multiplies the ratio the renderer actually
    // uses; minPixelRatio floors it so a 1x display is never rendered BELOW
    // its own resolution (0.5 * 1 would be a genuine blur, 0.5 * 2 is not).
    //
    // 0.5 on a 2x display = one device pixel per CSS pixel = 22.1 ms before the
    // round-21 cuts, ~17 ms after. On a 1x display it is a no-op.
    // Override with ?rs=<n> — ?rs=1 restores the old 2x behaviour.
    // ROUND 24 — 0.5 -> 1.0. Measured live at devicePixelRatio 2 (the only place
    // it is not a no-op): the canvas backing store was 1496 px for a 1496 px CSS
    // width, i.e. the game rendered at half the screen's linear resolution and the
    // browser upscaled it. That cost 54% of the frame's local contrast (mean
    // |Laplacian| 18.69 -> 8.68). The capture harness always shoots at
    // deviceScaleFactor 1, so twenty-three rounds of critique were run on plates
    // that could not show the defect. Override with ?rs=<n>.
    // ROUND 25 — renderScale is no longer the thing that decides the resolution;
    // budgetPx below is. It survives as the AUTHORED multiplier on top of the
    // budget (and as what ?rs writes), so 1.0 means "as many pixels as the budget
    // allows" and the quality menu can still scale the whole thing by hand.
    renderScale: 1.0,
    minPixelRatio: 1,

    // ROUND 25 — THE BUDGET IS A PIXEL COUNT, NOT A SCALE FACTOR.
    //
    // A scale factor holds 60 fps at exactly one window size. Measured on this
    // M3 Pro (18-core), played build, DPR 2, four interleaved 400-frame reps per
    // arm, the frame is purely fill-bound and fits
    //
    //     T = 3.5 ms + 4.0 ms per megapixel of DRAWING BUFFER
    //
    // to within 0.4 ms at every one of six points (1.078 Mpx -> 7.80 measured vs
    // 7.8 predicted; 2.42 -> 13.00 vs 13.2; 4.31 -> 20.72 vs 20.7; 7.46 -> 33.69
    // vs 33.3). So renderScale 1.0 in a 1496x721 window draws 4.31 Mpx = 20.7 ms
    // = 48 fps, and the SAME setting maximised to 1728x1080 draws 7.46 Mpx =
    // 33.7 ms = 29 fps. One number cannot be right for both.
    //
    // 16.67 ms is 3.29 Mpx by that fit. 3.0e6 is ~15.5 ms, i.e. 60 fps with p99
    // headroom, and it is a fixed function of the window size — decided once at
    // resize and never changed mid-session.
    //
    // THIS IS NOT THE ROUND-21/22 DYNAMIC RATCHET (see Engine.setDynScale for the
    // measurements that killed that). The ratchet responded to observed frame
    // times, drifted silently downward and could never recover. This is a pure
    // function of innerWidth * innerHeight.
    //
    // Nor is it a licence to delete effects instead: every post pass was priced
    // at rs=1 against a 22.40 ms base, and the whole stack MINUS the G-buffer
    // prepass is 5.0 ms (contact 2.0, grade 1.4, shadow map 0.6, bloom 0.5, stats
    // 0.4, shadow cadence 0.1) — and the prepass IS the contour ink. Only
    // resolution pays. Override with ?px=<pixels>, or 0/Infinity to disable.
    budgetPx: 3.0e6,

    // Scaled by boot calibration on a machine slower than the one above; see
    // calibrateBudget(). Never raised above 1.
    budgetCal: 1,
    // ROUND 22 — pinned at 1 and no longer written by anything. This used to be
    // the dynamic-resolution ratchet's lever; the ratchet is retired (see
    // Engine.setDynScale for the measurements that killed it). The knob survives
    // only as the multiplier ?ds=<n> writes, so a machine that genuinely cannot
    // hold the budget still has a way down that is a DECISION rather than a drift.
    dynScale: 1,

    // ROUND 21 TRIED 4096 -> 2048 at ultra AND PUT IT BACK. Turning the sun's
    // shadow off entirely saves 4.8 ms of a 58.4 ms frame, which reads like a
    // 16.7 M-sample shadow map being the problem — but measured head to head on
    // the shipped renderer, interleaved so GPU contention cancels, 4096 and 2048
    // are 66.3 ms and 66.0 ms at pixel ratio 2 and 31.2 ms and 31.4 ms at pixel
    // ratio 1: the same number twice, both times. That 4.8 ms is the PER-FRAGMENT
    // shadow lookup in the colour pass, not the rasterisation of the map, and
    // halving the map does nothing for it while costing real crispness in every
    // cast shadow. Do not re-propose this.
    shadowMapSize: [1024, 2048, 4096],
    // CANVAS-engine NPR parameters
    outlineWidth: 1.35,
    outlineWobble: 0.55,
    paperStrength: 0.42,
    // ROUND 24 - 0.62 -> 0.18. This drives the SURFACE hatch in materials.js.
    // The grade's full-screen hatch is off entirely; the real game hatches
    // sparsely in shadowed planes only (docs/reference/vc-088.jpg).
    hatchStrength: 0.18,
    bloomStrength: 0.52,
    bloomRadius: 0.62,
    bloomThreshold: 0.72,
    // ROUND 22 — the bloom chain's shape, and the smallest of the round's three
    // cuts. It used to start at half the buffer with six mips at ultra, so at
    // 1512x945 the first mip was 756x472 — and the first mip is where nearly all
    // of a dual-filter chain's cost lives.
    //
    // MEASURED, GPU-synced on a live command view with the resolution pinned,
    // 9 interleaved rounds: switching this pair alone from (2, 6) to (4, 5) took
    // the frame from 28.5 ms to 27.8 ms. 0.7 ms. That is the honest number; the
    // chain's TOTAL cost bracketed at 2.4 ms, so ÷4 hands back about a third of
    // it and the rest is the upsample and the composite's read, which are not
    // resolution-bound in the same way.
    //
    // The coarsest mip is 23x14 either way, so the bleed's RADIUS in screen space
    // is unchanged — what is gone is fine structure INSIDE the glow, which the
    // wash quantiser in the composite was already collapsing into three steps.
    // Checked on cold bridge/closeup/action plates: the frame's mean RGB moves by
    // at most 1.5 LSB and the plates are indistinguishable side by side, with the
    // ÷4 version very slightly crisper for having less bloom veil over the darks.
    bloomStartDiv: 4,
    bloomMips: 5,
    vignette: 0.34,
    chroma: 0.0016,
    // ROUND 24 - 1.06 -> 0.90. Measured on the CENTRE 50% box (i.e. excluding the
    // drawing falloff's drained margin) the demo sat uniformly ~20% brighter than
    // the reference: p50 122 vs 98-99, p1 42 vs 33-34, p0.1 34 vs 20-22. It was
    // never a black-point clamp - the whole midtone was lifted.
    exposure: 0.84,
    bands: 4,
  },

  gameplay: {
    cpPerTurn: 7,
    apScout: 900,
    apShock: 600,
    apLancer: 450,
    apEngineer: 750,
    apSniper: 500,
    interceptRange: 22,
    interceptCone: Math.PI * 0.55,
    aimSlowFactor: 0.35,
  },

  camera: {
    fov: 34,
    near: 0.15,
    far: 900,
  },
};

/**
 * Has the resolution been chosen BY HAND — by a query flag or by the player in
 * the options menu?
 *
 * It decides whether minPixelRatio applies. The comment on minPixelRatio ("so a
 * 1x display is never rendered BELOW its own resolution") is right as a default
 * and wrong as a hard floor on a manual override: measured, `?rs=0.5` and even
 * `?rs=0.25` on a deviceScaleFactor-1 display both produced a 1496x721 backing
 * store — exactly the same as no query at all. The documented escape hatch did
 * nothing at all on the majority of the world's displays.
 */
let explicitScale = qs.has('rs') || qs.has('ds') || qs.has('px');

if (qs.has('rs')) {
  const rs = parseFloat(qs.get('rs'));
  if (Number.isFinite(rs) && rs > 0) CFG.render.renderScale = rs;
}
if (qs.has('px')) {
  const px = parseFloat(qs.get('px'));
  if (Number.isFinite(px) && px > 0) CFG.render.budgetPx = px;
  else if (qs.get('px') === '0' || qs.get('px') === 'off') CFG.render.budgetPx = Infinity;
}
if (qs.has('mpr')) {
  const m = parseFloat(qs.get('mpr'));
  if (Number.isFinite(m) && m > 0) CFG.render.minPixelRatio = m;
}
if (qs.has('ds')) {
  const d = parseFloat(qs.get('ds'));
  if (Number.isFinite(d) && d > 0) CFG.render.dynScale = Math.min(1, d);
}

// Convenience: quality-indexed pick
export const byQ = (arr) => arr[Math.min(arr.length - 1, CFG.quality)];

/**
 * The pixel ratio the renderer should actually run at.
 *
 * ONE place computes this. Before round 21 the constructor and onResize each
 * inlined `Math.min(devicePixelRatio, maxPixelRatio)`, so there was no code path
 * — config, query string or ratchet — that could turn the resolution down, and
 * the game's only answer to a missed frame budget was to start deleting its own
 * art direction. See CFG.render.renderScale for the measurements.
 */
export const pixelRatio = () => {
  const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
  const w = typeof innerWidth === 'number' ? innerWidth : 1920;
  const h = typeof innerHeight === 'number' ? innerHeight : 1080;

  // The budget cap, expressed back in pixel-ratio terms. See CFG.render.budgetPx.
  const budget = CFG.render.budgetPx * CFG.render.budgetCal;
  const cap = budget > 0 && Number.isFinite(budget)
    ? Math.sqrt(budget / Math.max(1, w * h))
    : Infinity;

  const authored = Math.min(dpr, CFG.render.maxPixelRatio, cap) * CFG.render.renderScale;
  // minPixelRatio is the DEFAULT floor, not an absolute one — and it must never
  // fight the budget, or a big window on a 1x display would be pinned at native
  // resolution and blow straight through the frame budget it was just given.
  const floor = explicitScale ? 0.5 : Math.min(CFG.render.minPixelRatio, cap);
  // 0.5 (not the old 0.75) is the absolute bottom: 0.75 is only 56% of the fill,
  // which is not a big enough step for an integrated-GPU machine to recover a
  // missed budget, and there was no lower gear at all.
  return Math.max(0.5, Math.max(floor, authored) * CFG.render.dynScale);
};

/**
 * Drawing-buffer budgets the options menu offers, in pixels.
 *
 * Balanced is the authored default (~15.5 ms on an M3 Pro by the fit above).
 * Performance is ~9.9 ms — the setting for an integrated GPU. Native disables
 * the cap entirely and renders one buffer pixel per device pixel, up to
 * maxPixelRatio; on a retina display in a large window that is the 30 fps the
 * shipped r24 build had, chosen on purpose instead of by accident.
 */
export const RESOLUTION_BUDGETS = {
  Performance: 1.6e6,
  Balanced: 3.0e6,
  Native: Infinity,
};
export const RESOLUTION_NAMES = Object.keys(RESOLUTION_BUDGETS);

/** The options menu picking a resolution. The caller must call engine.onResize(). */
export function setResolutionBudget(nameOrPx) {
  const px = typeof nameOrPx === 'number' ? nameOrPx : RESOLUTION_BUDGETS[nameOrPx];
  if (px === undefined) return false;
  CFG.render.budgetPx = px;
  CFG.render.budgetCal = 1;      // a hand-picked budget is not second-guessed
  explicitScale = true;
  return true;
}

/** Which named preset the live budget corresponds to, for restoring the menu. */
export function resolutionName() {
  const px = CFG.render.budgetPx;
  return RESOLUTION_NAMES.find((n) => RESOLUTION_BUDGETS[n] === px) || null;
}

/**
 * ONE-SHOT boot calibration for machines that are not the machine this was tuned
 * on. Deliberately not the retired ratchet: it runs exactly once, it can only
 * ever REDUCE the budget, and it is a throughput measurement rather than a
 * missed-frame count.
 *
 * The fit T = a + b*Mpx makes this a division. Given a measured mean frame time
 * at a known buffer size, the fill rate b is (T - a) / Mpx, and the buffer that
 * costs `targetMs` is (targetMs - a) / b. An M3 Pro measures b ~= 4.0 ms/Mpx and
 * lands on cal = 1; an 8-core M1 or an Iris Xe measures 2-3x that and steps down.
 *
 * @returns {number} the calibration factor that was applied (1 = no change).
 */
/*
 * TARGET 13.5 ms, NOT 15.5 — measured, r25. See tools/frametime.mjs.
 *
 * 15.5 leaves 1.2 ms of headroom under a 16.7 ms vsync budget, and rAF quantises:
 * a frame that misses vsync does not cost 17 ms, it costs 33.3. Measured at DPR 2
 * on a 1496x840 CSS viewport (300 frames x 3 reps, 120-frame warmup discarded):
 * mean 16.34 ms, median 15.7, p95 32.1, p99 33.5 — the mean sat ON budget while
 * 35-45% of frames spilled onto the next vsync. That bimodal 16.7/33.3 signature
 * is what running exactly at the edge looks like, and a player sees it wobble even
 * though the mean reports 61 fps.
 *
 * finish_plan P0's "take the resolution over the effects" still governs the choice
 * between resolution and post-processing; it does not oblige us to spend the last
 * millimetre of resolution on a frame rate that visibly stutters.
 *
 * WHY 13.5 AND NOT LOWER, recorded so the next round does not re-derive it: at a
 * 12.5 ms target this same machine calibrated straight down to `cal`'s 0.34 floor
 * (a 1347x756 buffer, ratio 0.90). That is a real quality cost and it was driven
 * by contention, not by the GPU — the three reps at that identical buffer measured
 * 11.5 / 22.6 / 26.2 ms, an 87 fps run and two 40 fps runs at the SAME pixel count.
 *
 * MEASUREMENT CAVEAT, stated plainly: every number above was taken with another
 * project's two headless chromiums pinned at ~100% CPU on this machine (load
 * average 3.9-5.2). They are pessimistic and their spread is external. This should
 * be re-run on a quiet machine before anyone tunes it further — which is exactly
 * why the budget is CALIBRATED per-session rather than hardcoded: on the player's
 * machine `fill` is measured there, and a lower fill keeps proportionally more
 * resolution automatically.
 */
export function calibrateBudget(meanMs, bufferPx, { targetMs = 13.5, fixedMs = 3.5 } = {}) {
  if (!(meanMs > 0) || !(bufferPx > 0) || explicitScale) return 1;
  const mpx = bufferPx / 1e6;
  const fill = (meanMs - fixedMs) / mpx;              // ms per megapixel, this GPU
  if (!(fill > 0.2)) return 1;                        // implausible: leave it alone
  const wantMpx = (targetMs - fixedMs) / fill;
  // Only ever down, and never below a third of the authored budget — past that
  // the picture is worse than the frame rate is good, and finish_plan's P0 rule
  // ("take the resolution over the effects") stops paying.
  const cal = Math.max(0.34, Math.min(1, (wantMpx * 1e6) / CFG.render.budgetPx));
  CFG.render.budgetCal = cal;
  return cal;
}
