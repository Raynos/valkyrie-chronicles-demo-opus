// Global tunables. Quality 0 = low, 1 = high, 2 = ultra.

const qs = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');

export const CFG = {
  quality: qs.has('q') ? parseInt(qs.get('q'), 10) : 2,
  debug: qs.has('debug'),
  seed: qs.has('seed') ? parseInt(qs.get('seed'), 10) : 20250728,

  // deterministic capture mode for the visual-critic harness
  capture: qs.has('capture'),
  captureShot: qs.get('shot') || null,

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
    // Runtime-only emergency knob, driven by the dynamic-resolution ratchet in
    // main.js. Authored policy lives in renderScale; this is what a machine that
    // still cannot hold the budget gets to turn down, and the product is floored
    // at 0.75 device pixels per CSS pixel because below that the ink lines start
    // to break up and the cure is worse than the disease.
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
