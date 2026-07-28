// Integration layer between src/world and src/render/materials.js.
//
// The architecture contract says every world mesh must use a material from
// `src/render/materials.js` so the NPR look and the outline pass stay coherent.
// This module does exactly that — but it *probes* the returned material for the
// features the world actually needs (vertex colours, instancing, alpha-tested
// maps, wind) and, if a feature is missing, substitutes a locally-authored
// CANVAS-style material that definitely has it. That keeps the battlefield
// renderable while src/render is still in flight, and costs nothing once the
// real materials support the features.
//
// The local material is not a placeholder: it is MeshLambertMaterial patched
// through onBeforeCompile, which buys instancing / skinning / shadow maps /
// vertex colours / fog from three for free, and then replaces the lighting
// composition entirely with quantised watercolour bands, pencil hatching and
// paper grain.

import * as THREE from 'three';
import * as Mats from '../render/materials.js';
import { CFG } from '../core/config.js';
// ONE substrate for the whole frame. The world used to synthesise its own
// paper here; two different sheets under one painting is a tell all by itself,
// and the render module's is now the isotropic cold-press build.
import { getPaperTexture } from '../render/textures.js';

// ---------------------------------------------------------------------------
// palette — the whole world draws from this
// ---------------------------------------------------------------------------

export const PALETTE = {
  // ground — Gallia is green. These are the pigments BEFORE the NPR lit
  // transform, which rotates ~26% toward straw and lifts value by 1.42; a
  // khaki albedo comes out of that as desert sand, so the pasture greens are
  // authored deliberately deeper and more saturated than they should look.
  grass: 0x5e7440,
  grassDry: 0x8d8d56,
  grassDark: 0x3f5433,
  grassLush: 0x4c6b3c,
  dirt: 0x967c4e,
  dirtDark: 0x715a37,
  mud: 0x5b5140,
  rock: 0x928c80,
  sand: 0xc2ad83,
  // architecture
  stucco: 0xd6cab0,
  stuccoWarm: 0xd9c49c,
  stuccoGrey: 0xbfb8a8,
  // Pantile is DUSTY BRICK. Round 1 authored these hot enough that they came
  // out at HSV sat 0.59-0.62, val 0.88 on screen while the rest of the frame sat
  // at 0.09-0.40 — the roofs were the highest-chroma object in every shot and
  // pulled the eye clean off the action.
  tileA: 0x8e5340,
  tileB: 0x9c6248,
  tileDark: 0x74392c,
  // Masonry is a WARM grey. Authoring it cool (0x9a9296, blue over green) is how
  // the bridge and every retaining wall came out as a lavender slab — the
  // coldest thing in frame and off the palette. Let vcShadowColour supply the
  // violet where the light actually falls away.
  //
  // Lifted in round 3: at 0xa39a8c the lit parapet still only reached L 152 and
  // measured hue 306 — the whole structure was sitting in the shade washes, so
  // there was no lit band on it anywhere and the ashlar coursing rendered as a
  // flat lavender engraving on ~25% of the firefight frame. A limestone parapet
  // in full sun is a light warm grey; author it as one.
  stone: 0xbdb09a,
  stoneWarm: 0xc0b096,
  brick: 0xa15b46,
  timber: 0x7d5c3c,
  timberDark: 0x5b4229,
  plaster: 0xcfc4ae,
  // materiel
  burlap: 0xb09a6c,
  steel: 0x7c7a80,
  steelDark: 0x565059,
  olive: 0x6c7050,
  rust: 0x8d5a3c,
  crate: 0x9a7c4e,
  // vegetation
  leafOak: 0x53692f,
  leafPoplar: 0x62793a,
  leafWillow: 0x738345,
  leafDark: 0x38492a,
  wheat: 0xb9a565,
  wheatDark: 0x8f7c48,
  reed: 0x7d8a4a,
  bark: 0x7a6349,
  barkPale: 0x9a8a6f,
  flowerA: 0xd6c268,
  flowerB: 0xc4736c,
  flowerC: 0xcfcbb6,
  // atmosphere
  shadowViolet: 0x4a3f52,
  darkest: 0x3a2f33,
  cream: 0xf3e8cf,
  // The sky must sit tonally BELOW the terrain's cream highlights or the whole
  // upper half of the frame clips to white through the bloom and the grade.
  skyHorizon: 0xa9b2a4,
  skyZenith: 0x5f8098,
  skyGold: 0xd9c599,
  haze: 0xb0b6a8,
  // The post grade lifts dark values toward a warm ink floor, which desaturates
  // anything that sits deep in the toe — a "correct" dark teal river comes out
  // of it as wet tarmac. These are authored light and saturated on purpose.
  water: 0x5d8574,
  waterDeep: 0x466c67,
  foam: 0xe8e4d6,
};

// ---------------------------------------------------------------------------
// shared lighting state (World owns the actual lights and writes these)
// ---------------------------------------------------------------------------

export const WorldLighting = {
  sunDir: new THREE.Vector3(0.42, 0.72, 0.55).normalize(),
  sunColor: new THREE.Color(0xfff0d2),
  sunIntensity: 2.35,
  skyColor: new THREE.Color(0xa8bcc4),
  groundColor: new THREE.Color(0x6a5c4c),
  windDir: new THREE.Vector2(0.86, 0.5).normalize(),
  windStrength: 1,
  time: 0,
};

/** Mean radiance of the key light, matching three's Lambert BRDF normalisation. */
function sunLum() {
  const c = WorldLighting.sunColor;
  return ((c.r + c.g + c.b) / 3) * WorldLighting.sunIntensity / Math.PI;
}

// ---------------------------------------------------------------------------
// GLSL: the CANVAS composition, shared by every fallback material
// ---------------------------------------------------------------------------

const NPR_PARS = /* glsl */ `
uniform float uWTime;
uniform float uBands;
uniform float uEdge;
uniform float uBleed;
uniform float uHatch;
uniform float uPaper;
uniform float uRim;
uniform float uSunLum;
uniform vec3  uLitTint;
uniform vec3  uMidTint;
uniform vec3  uShadeTint;
uniform vec3  uFloorCol;
uniform sampler2D uPaperTex;

// Quantiser. The boundary is HARD — uEdge is a few hundredths of a band, not a
// third of one — and the irregularity comes from WARPING the band coordinate
// before the floor, so the whole edge moves off the geometric iso-line instead
// of being feathered into the gradient it was supposed to destroy. The warp
// argument wants a low-frequency field (30-60 screen px lobes); a
// high-frequency one dissolves the plateau, which is what round 1 measured.
float bandify(float s, float warp) {
  float sc = clamp(s, 0.0, 1.35) * uBands + warp * uBands;
  float f  = floor(sc);
  float fr = sc - f;
  return (f + smoothstep(0.5 - uEdge, 0.5 + uEdge, fr)) / uBands;
}
`;

// Replaces <opaque_fragment>. NOTE: `outgoingLight` is already declared by the
// Lambert shader immediately above this include — it must be ASSIGNED here,
// never redeclared, or the whole world fails to compile. Every local below is
// np-prefixed for the same reason: this code is injected into a scope full of
// three's own identifiers.
const NPR_BODY = /* glsl */ `
  vec3 npBase = diffuseColor.rgb;
  float npLum = max(1e-4, dot(npBase, vec3(0.33333)));

  // Recover the FULL diffuse response — direct AND indirect — from three's
  // Lambert accumulation:
  //   directDiffuse = sunColor * NdotL * shadow * diffuse / PI
  // Quantising the direct term alone and then letting the unbanded hemisphere
  // term back in afterwards is what dissolved every plateau in round 1: the
  // measured shadow ramp came out as a continuous 80->164 gradient. The whole
  // lighting value goes into the quantiser and the banded result is what gets
  // written; nothing is re-added after it.
  float npShade = dot(reflectedLight.directDiffuse + reflectedLight.indirectDiffuse,
                      vec3(0.33333)) / (npLum * uSunLum);
  npShade = clamp(npShade, 0.0, 1.35);

  vec2 npPx = gl_FragCoord.xy;
  // ~55 px wet-edge lobes plus a ~160 px swell. Low frequency on purpose: a
  // high-frequency warp does not bleed, it dissolves.
  float npFibre = texture2D(uPaperTex, npPx * 0.0182).r;
  float npFibre2 = texture2D(uPaperTex, npPx * 0.0073 + vec2(0.37, 0.61)).r;
  float npSwell = texture2D(uPaperTex, npPx * 0.0062 + vec2(0.71, 0.13)).b;
  float npWarp = ((npFibre - 0.5) * 0.65 + (npSwell - 0.5) * 0.35) * uBleed;

  float npQ = bandify(npShade, npWarp);

  // Warm in light, violet-blue in shade. Never grey, never black.
  vec3 npShadeCol = mix(npBase * uShadeTint, uShadeTint, 0.55);
  // blue must lead red in the shaded wash — the CANVAS rule round 1 failed
  npShadeCol.b = max(npShadeCol.b, npShadeCol.r * 1.10);
  vec3 npMidCol   = npBase * uMidTint;
  vec3 npLitCol   = npBase * uLitTint + vec3(0.045, 0.038, 0.022);
  vec3 npCol = mix(npShadeCol, npMidCol, smoothstep(0.05, 0.58, npQ));
  npCol = mix(npCol, npLitCol, smoothstep(0.52, 1.0, npQ));

  // Rim: a thin straw-coloured halo where the surface turns away, stepped so
  // it reads as a drawn highlight rather than a fresnel gradient.
  vec3 npView = normalize(vViewPosition);
  float npFres = 1.0 - clamp(dot(normalize(normal), npView), 0.0, 1.0);
  float npRim = smoothstep(0.62, 0.94, npFres) * uRim * (0.25 + 0.75 * npQ);
  npCol += npRim * vec3(0.40, 0.33, 0.20);

  // Pencil hatching, screen-space aligned, only in the lower bands. The stroke
  // phase is jittered by paper fibre so the lines waver like a real hand.
  // Gated on the BAND INDEX, not on a continuous ramp: a band is a flat wash,
  // so its hatching goes in at one weight across the whole wash and stops dead
  // at the wet edge. The old smoothstep gate let the same stripe ride the lit
  // stucco at a fraction of an amplitude, which reads as a printed screen.
  float npBi = npQ * uBands;
  float npHatchAmt = uHatch * (1.0 - smoothstep(0.85, 1.75, npBi));
  if (npHatchAmt > 0.001) {
    float npWob = (npFibre2 - 0.5) * 6.5;
    float npL1 = sin((npPx.x * 0.819 + npPx.y * 0.574) * 0.52 + npWob);
    float npHatch = smoothstep(0.24, 0.72, npL1);
    // cross-hatch the darkest band only
    float npDeep = 1.0 - smoothstep(0.05, 0.95, npBi);
    float npL2 = sin((npPx.x * 0.966 - npPx.y * 0.259) * 0.47 - npWob * 0.8);
    npHatch = mix(npHatch, max(npHatch, smoothstep(0.24, 0.72, npL2)), npDeep);
    npCol *= 1.0 - npHatchAmt * npHatch * 0.42;
  }

  // Paper grain. Kept small: the frame already gets its cold-press tooth from
  // the grade pass, and a 26% multiply here would flatten every plateau the
  // quantiser just built.
  //
  // The window is evaluated on the DISPLAY value, not on a linear one. Round 2
  // used 1 - abs(l*2-1) on a linear luminance, which peaks at a display value
  // of 0.73 — a highlight — and rolls off through the true midtones, i.e. it is
  // loudest exactly where the rubric says the grain must vanish.
  float npDisp = pow(clamp(npQ, 0.0, 1.0), 0.4545);
  float npMid = smoothstep(0.06, 0.26, npDisp) * (1.0 - smoothstep(0.52, 0.82, npDisp));
  npCol *= mix(1.0, 0.93 + npFibre2 * 0.14, uPaper * npMid);

  // Lift the black point to a warm brown-violet.
  npCol = uFloorCol + npCol * (1.0 - uFloorCol);

  outgoingLight = npCol;
  #ifdef OPAQUE
  diffuseColor.a = 1.0;
  #endif
  gl_FragColor = vec4( outgoingLight, diffuseColor.a );
`;

const WIND_PARS = /* glsl */ `
uniform float uWTime;
uniform vec2  uWindDir;
uniform float uWindStrength;
uniform float uWindSpeed;
uniform float uWindHeight;
uniform vec2  uFade;
uniform float uStiff;
`;

// Appended AFTER <project_vertex>: recompute the clip position with the vertex
// pushed through a world-space wind field and shrunk toward its instance origin
// beyond the fade distance. Additive, so it survives whatever three's own
// project chunk does.
const WIND_BODY = /* glsl */ `
  {
    vec4 _wp = modelMatrix * vec4(transformed, 1.0);
    vec4 _wb = modelMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    #ifdef USE_INSTANCING
      _wp = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
      _wb = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    #endif
    float _h = clamp(position.y / uWindHeight, 0.0, 1.0);
    _h = pow(_h, uStiff);
    float _ph = _wb.x * 0.31 + _wb.z * 0.26;
    float _g  = sin(uWTime * uWindSpeed + _ph);
    float _g2 = sin(uWTime * uWindSpeed * 0.43 + _ph * 2.7 + 1.7);
    // Gust front: a slow wave crossing the field so the whole meadow ripples.
    float _gust = 0.55 + 0.45 * sin(uWTime * 0.27 - (_wb.x * uWindDir.x + _wb.z * uWindDir.y) * 0.055);
    float _amt = uWindStrength * _h * (0.55 + 0.30 * _g + 0.15 * _g2) * _gust;
    _wp.xyz += vec3(uWindDir.x, 0.0, uWindDir.y) * _amt;
    _wp.y -= abs(_amt) * 0.22;                    // bending shortens the blade
    float _d = distance(_wb.xyz, cameraPosition);
    float _f = 1.0 - smoothstep(uFade.x, uFade.y, _d);
    _wp.xyz = mix(_wb.xyz, _wp.xyz, _f);
    mvPosition = viewMatrix * _wp;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

// ---------------------------------------------------------------------------
// fallback material factory
// ---------------------------------------------------------------------------

const _fallbacks = new Set();

function nprUniforms(opts) {
  return {
    uWTime: { value: 0 },
    uBands: { value: opts.bands ?? CFG.render.bands ?? 4 },
    // A HARD boundary (0.055 of a band) with a WIDE warp (0.30 of a band). The
    // old 0.16/0.075 pair was exactly backwards and smeared every plateau.
    uEdge: { value: opts.edge ?? 0.055 },
    uBleed: { value: opts.bleed ?? 0.30 },
    uHatch: { value: opts.hatch ?? CFG.render.hatchStrength ?? 0.6 },
    uPaper: { value: opts.paper ?? CFG.render.paperStrength ?? 0.42 },
    uRim: { value: opts.rim ?? 0.5 },
    uSunLum: { value: sunLum() },
    uLitTint: { value: new THREE.Color(opts.litTint ?? 0xfff2d8) },
    uMidTint: { value: new THREE.Color(opts.midTint ?? 0xd8cfc0) },
    uShadeTint: { value: new THREE.Color(opts.shadeTint ?? 0x4b4270) },
    uFloorCol: { value: new THREE.Color(opts.floorCol ?? 0x231d26) },
    uPaperTex: { value: getPaperTexture() },
  };
}

// Reads the terrain's pre-baked per-vertex albedo instead of the `color`
// attribute (which the terrain uses for its splat).
const ALBEDO_VS_PARS = 'attribute vec3 aAlbedo;\nvarying vec3 vAlbedo;';
const ALBEDO_FS_PARS = 'varying vec3 vAlbedo;';

function makeFallbackSurface(opts = {}) {
  const m = new THREE.MeshLambertMaterial({
    color: opts.color ?? 0xffffff,
    map: opts.map || null,
    vertexColors: opts.vertexColors ?? false,
    side: opts.side ?? THREE.FrontSide,
    transparent: opts.transparent ?? false,
    opacity: opts.opacity ?? 1,
    alphaTest: opts.alphaTest ?? 0,
    flatShading: opts.flatShading ?? false,
    depthWrite: opts.depthWrite ?? true,
    fog: false,
  });
  const u = nprUniforms(opts);
  m.userData.uniforms = u;
  m.userData.wind = !!opts.wind;
  m.userData.baseWind = opts.windStrength ?? 0.16;
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + NPR_PARS)
      .replace('#include <opaque_fragment>', NPR_BODY);
    if (opts.albedoAttr) {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n' + ALBEDO_VS_PARS)
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vAlbedo = aAlbedo;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + ALBEDO_FS_PARS)
        .replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.rgb *= vAlbedo;');
    }
    if (opts.wind) {
      Object.assign(shader.uniforms, {
        uWindDir: { value: WorldLighting.windDir },
        uWindStrength: { value: opts.windStrength ?? 0.16 },
        uWindSpeed: { value: opts.windSpeed ?? 1.7 },
        uWindHeight: { value: opts.windHeight ?? 1.0 },
        uStiff: { value: opts.stiffness ?? 1.6 },
        uFade: { value: new THREE.Vector2(opts.fadeStart ?? 1e5, opts.fadeEnd ?? 1e6) },
      });
      u.uWindDir = shader.uniforms.uWindDir;
      u.uWindStrength = shader.uniforms.uWindStrength;
      u.uFade = shader.uniforms.uFade;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n' + WIND_PARS)
        .replace('#include <project_vertex>', '#include <project_vertex>\n' + WIND_BODY);
    }
    m.userData.shader = shader;
  };
  // Distinct cache key so three does not share a program between wind and
  // non-wind variants of the same Lambert configuration.
  m.customProgramCacheKey = () =>
    `world-npr:${opts.wind ? 1 : 0}:${opts.albedoAttr ? 1 : 0}`;
  _fallbacks.add(m);
  return m;
}

// ---------------------------------------------------------------------------
// feature probing
// ---------------------------------------------------------------------------

function isRawShader(m) {
  return m instanceof THREE.ShaderMaterial || m instanceof THREE.RawShaderMaterial;
}

/**
 * Does `m` actually support the features we need? Built-in-derived materials
 * always do (three's chunk system handles them); a bespoke ShaderMaterial only
 * does if its source references the relevant plumbing.
 */
function supports(m, needs) {
  if (!m || !m.isMaterial) return false;
  if (!isRawShader(m)) return true;
  const vs = m.vertexShader || '';
  const fs = m.fragmentShader || '';
  for (const n of needs) {
    if (n === 'vertexColors' && !(fs.includes('vColor') || fs.includes('vertexColor'))) return false;
    if (n === 'instancing' && !vs.includes('instanceMatrix')) return false;
    if (n === 'map' && !(fs.includes('sampler2D') && (fs.includes('map') || fs.includes('Map')))) return false;
    if (n === 'alphaTest' && !fs.includes('discard')) return false;
    if (n === 'wind' && !(vs.includes('wind') || vs.includes('Wind'))) return false;
  }
  return true;
}

function tryRender(fn, opts, needs) {
  if (typeof fn !== 'function') return null;
  let m = null;
  try {
    m = fn(opts);
  } catch (e) {
    console.warn('[world] materials.js factory threw, using local NPR material', e);
    return null;
  }
  if (!supports(m, needs)) {
    m?.dispose?.();
    return null;
  }
  // Feed through the flags three needs regardless of who authored the shader.
  if (opts.vertexColors !== undefined) m.vertexColors = opts.vertexColors;
  if (opts.side !== undefined) m.side = opts.side;
  if (opts.transparent !== undefined) m.transparent = opts.transparent;
  if (opts.alphaTest) m.alphaTest = opts.alphaTest;
  if (opts.depthWrite !== undefined) m.depthWrite = opts.depthWrite;
  return m;
}

// ---------------------------------------------------------------------------
// public factories
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// surface archetypes
// ---------------------------------------------------------------------------
// Pigment character per material family. Round 2 scored `materials` 3-5 on
// every shot with the same note each time — "untextured primitives", "one flat
// lavender-grey stucco fill", "a flat field with scattered light rectangles",
// "flat lavender poles" — and the cause was always that nothing moved the BAND
// DRIVE across the object, so the whole thing landed inside one wash.
//
// These presets feed src/render/materials.js's pigment structure: a per-block
// tonal offset for anything laid in courses, and a circumferential fissure field
// for anything cylindrical. Both go into the drive, so they express themselves
// as patches of the neighbouring wash with their own wet edge, which is how a
// painted wall or a painted trunk is actually built up.
//
// Pass `surface: '<name>'` to makeSurfaceMaterial; any explicit opt overrides.
export const SURFACE_PIGMENT = {
  //            block m  tone  fissure  freq   other
  masonry:  { blockSize: 0.42, blockTone: 0.115, pigLevels: 15 },
  brick:    { blockSize: 0.16, blockTone: 0.085, pigLevels: 15 },
  stucco:   { blockSize: 0, blockTone: 0, pigLevels: 13, grain: 0.55, blotch: 1.35 },
  tile:     { blockSize: 0.15, blockTone: 0.095, pigLevels: 14 },
  timber:   { fissure: 0.075, fissureFreq: 3.4, pigLevels: 13 },
  bark:     { fissure: 0.135, fissureFreq: 2.6, pigLevels: 12, curvature: 0.22 },
  metal:    { pigLevels: 12, grain: 0.25 },
  cloth:    { pigLevels: 12, grain: 0.38 },
};

/**
 * Opaque surface: buildings, props, bridges, tree trunks.
 *
 * opts: { color, map, vertexColors, side, roughness, hatch, rim, flatShading,
 *         outline, transparent, alphaTest,
 *
 *         surface,        one of SURFACE_PIGMENT — pigment character preset
 *
 *   ...and the full band-quantiser set, all forwarded straight through to
 *   src/render/materials.js (they used to be unreachable from here, which is
 *   why callers were reaching into `mat.uniforms` by hand):
 *         bands, bandBleed, wrap, contrast, lightBias, shadeCool, wetPx,
 *         keyGain, fillGain, violet, cream, driveRange, curvature,
 *         pigQ, pigLevels, grain, blockSize, blockTone, fissure, fissureFreq,
 *         blotch, blotchScale, toothScale, spec, weave, mapFlat, mapDrive,
 *         shadowSoften, subsurface, hatchSpacing }
 */
const NPR_FORWARD = [
  'bands', 'bandBleed', 'wrap', 'contrast', 'lightBias', 'shadeCool', 'wetPx',
  'keyGain', 'fillGain', 'violet', 'cream', 'driveRange', 'curvature',
  'pigQ', 'pigLevels', 'grain', 'blockSize', 'blockTone', 'fissure', 'fissureFreq',
  'blotch', 'blotchScale', 'toothScale', 'spec', 'weave', 'mapFlat', 'mapDrive',
  'shadowSoften', 'subsurface', 'hatchSpacing', 'emissive', 'emissiveIntensity',
];

function forwardNpr(dst, opts) {
  const preset = opts.surface ? SURFACE_PIGMENT[opts.surface] : null;
  if (preset) Object.assign(dst, preset);
  for (const k of NPR_FORWARD) if (opts[k] !== undefined) dst[k] = opts[k];
  return dst;
}

export function makeSurfaceMaterial(opts = {}) {
  const needs = ['vertexColors'];
  if (opts.instanced) needs.push('instancing');
  if (opts.map) needs.push('map');
  if (opts.alphaTest) needs.push('alphaTest');
  const m =
    tryRender(Mats.makeCanvasMaterial, forwardNpr({
      color: opts.color ?? 0xffffff,
      map: opts.map || null,
      // World geometry carries world-scaled triplanar UVs already (worldUV),
      // so the material must not re-tile them.
      mapRepeat: [1, 1],
      roughness: opts.roughness ?? 0.9,
      hatch: opts.hatch ?? 1,
      rim: opts.rim ?? 0.5,
      paper: opts.paper ?? 1,
      instanced: !!opts.instanced,
      vertexColors: opts.vertexColors ?? true,
      side: opts.side ?? THREE.FrontSide,
      transparent: !!opts.transparent,
      alphaTest: opts.alphaTest ?? 0,
      outline: opts.outline ?? true,
      outlineWidth: opts.outlineWidth ?? CFG.render.outlineWidth,
    }, opts), needs) || makeFallbackSurface({ ...opts, vertexColors: opts.vertexColors ?? true });
  return m;
}

/**
 * Terrain.
 *
 * The geometry's `color` attribute carries the terrain generator's fully baked
 * per-vertex ALBEDO — the four-way material mix, field patchwork, shell
 * scorching and horizon AO, all in one linear colour. That is the mode
 * src/render/materials.js calls VC_VCOL_ALBEDO: it trusts the attribute for hue
 * and keeps only the *modulation* its procedural layers produce, which is what
 * gives the ground close-range tooth without letting a procedural slope/noise
 * guess repaint a hand-authored valley.
 *
 * (The alternative, VC_SPLAT_VCOL, hands the shader the raw weights and throws
 * the baked colour away — which is why the ground used to read as one uniform
 * ochre wash regardless of what the generator had painted.)
 */
export function makeTerrainSurfaceMaterial(opts = {}) {
  const m =
    tryRender(Mats.makeTerrainMaterial, forwardNpr({
      splatFromVertexColor: false,
      vertexColors: true,
      grass: opts.grass ?? PALETTE.grass,
      dirt: opts.dirt ?? PALETTE.dirt,
      rock: opts.rock ?? PALETTE.rock,
      mud: opts.mud ?? PALETTE.mud,
      // Mud is authored by the splat; give the shader's own height term a sane
      // waterline too so shorelines agree even if the splat is ignored.
      mudLevel: opts.mudLevel ?? 3.1,
      mudFade: 1.6,
      rockSlope: 0.40,
      // ~1.0 m detail tile so the ground has real tooth at walking distance,
      // over a ~36 m macro octave that breaks up the tiling from the air.
      detailScale: 0.95,
      detailScale2: 0.028,
      macroScale: 0.021,
      hatch: opts.hatch ?? 0.85,
      bands: CFG.render.bands,
      outline: false,
      color: 0xffffff,
    }, opts), ['vertexColors']) ||
    makeFallbackSurface({
      color: 0xffffff,
      vertexColors: true,
      hatch: opts.hatch ?? 0.5,
      rim: 0.12,
      bands: (CFG.render.bands ?? 4) + 1,
      edge: 0.2,
      bleed: 0.1,
    });
  return m;
}

/**
 * Wind-animated alpha-tested foliage: grass blades, leaf cards, wheat, reeds.
 * opts adds: { windStrength, windSpeed, windHeight, stiffness, fadeStart, fadeEnd }
 */
export function makeFoliageMaterial(opts = {}) {
  const needs = ['alphaTest', 'wind'];
  if (opts.instanced) needs.push('instancing');
  const m =
    tryRender(Mats.makeGrassMaterial, forwardNpr({
      // src/render's grass material names its knobs rootColor/tipColor/sway/
      // bladeHeight; ours are colour/windStrength/windHeight. Send both so
      // whichever factory answers gets what it understands.
      rootColor: opts.rootColor ?? opts.color ?? 0xffffff,
      tipColor: opts.tipColor ?? opts.color ?? 0xffffff,
      bladeHeight: opts.windHeight ?? 1.0,
      sway: (opts.windStrength ?? 0.16) * 1.9,
      variation: opts.variation ?? 0.22,
      color: opts.color ?? 0xffffff,
      map: opts.map || null,
      instanced: !!opts.instanced,
      vertexColors: opts.vertexColors ?? true,
      alphaTest: opts.alphaTest ?? 0.42,
      side: THREE.DoubleSide,
      wind: opts.windStrength ?? 0.16,
      windSpeed: opts.windSpeed ?? 1.7,
      fadeStart: opts.fadeStart ?? 1e5,
      fadeEnd: opts.fadeEnd ?? 1e6,
      rim: opts.rim ?? 1.2,
      hatch: opts.hatch ?? 0.35,
      subsurface: opts.subsurface ?? 0.55,
    }, opts), needs) ||
    makeFallbackSurface({
      ...opts,
      wind: true,
      side: THREE.DoubleSide,
      alphaTest: opts.alphaTest ?? 0.42,
      transparent: false,
      vertexColors: opts.vertexColors ?? true,
      hatch: opts.hatch ?? 0.3,
      rim: opts.rim ?? 0.85,
    });
  return m;
}

// ---------------------------------------------------------------------------
// per-frame uniform drive
// ---------------------------------------------------------------------------

/**
 * Advance the locally-authored materials. `MaterialRegistry.update` from
 * src/render is intentionally NOT called here — the render pipeline owns it,
 * and calling it twice would double-integrate its clock.
 */
export function updateWorldMaterials(dt) {
  WorldLighting.time += dt;
  const t = WorldLighting.time;
  const lum = sunLum();
  for (const m of _fallbacks) {
    const u = m.userData.uniforms;
    if (!u) continue;
    u.uWTime.value = t;
    u.uSunLum.value = lum;
  }
}

/** Set the global wind gain (0..2); vegetation reads it through the uniform. */
export function setWindGain(g) {
  WorldLighting.windStrength = g;
  for (const m of _fallbacks) {
    const u = m.userData.uniforms;
    if (u?.uWindStrength && m.userData.baseWind !== undefined) {
      u.uWindStrength.value = m.userData.baseWind * g;
    }
  }
  // Bespoke materials from src/render expose the same knob if they have one.
  if (Mats.MaterialRegistry && typeof Mats.MaterialRegistry.setWind === 'function') {
    Mats.MaterialRegistry.setWind(g);
  }
}

export function disposeWorldMaterials() {
  for (const m of _fallbacks) m.dispose();
  _fallbacks.clear();
}
