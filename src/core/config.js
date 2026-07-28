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

// Convenience: quality-indexed pick
export const byQ = (arr) => arr[Math.min(arr.length - 1, CFG.quality)];
