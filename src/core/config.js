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
    renderScale: 0.5,
    minPixelRatio: 1,
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
    hatchStrength: 0.62,
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
    exposure: 1.06,
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

if (qs.has('rs')) {
  const rs = parseFloat(qs.get('rs'));
  if (Number.isFinite(rs) && rs > 0) CFG.render.renderScale = rs;
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
  const authored = Math.max(
    CFG.render.minPixelRatio,
    Math.min(dpr, CFG.render.maxPixelRatio) * CFG.render.renderScale,
  );
  return Math.max(0.75, authored * CFG.render.dynScale);
};
