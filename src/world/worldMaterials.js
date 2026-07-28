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
import { paperTexture } from './textures.js';

// ---------------------------------------------------------------------------
// palette — the whole world draws from this
// ---------------------------------------------------------------------------

export const PALETTE = {
  // ground
  grass: 0x7d8a55,
  grassDry: 0x9aa065,
  grassDark: 0x5f6f47,
  dirt: 0xa78b5c,
  dirtDark: 0x8a6f47,
  mud: 0x6f5e46,
  rock: 0x938c94,
  sand: 0xc2ad83,
  // architecture
  stucco: 0xd6cab0,
  stuccoWarm: 0xd9c49c,
  stuccoGrey: 0xbfb8a8,
  tileA: 0xb15c42,
  tileB: 0xc4794f,
  tileDark: 0x8d4636,
  stone: 0x9a9296,
  stoneWarm: 0xa79a8c,
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
  leafOak: 0x6d7c48,
  leafPoplar: 0x7b8a4f,
  leafWillow: 0x869053,
  wheat: 0xc4a860,
  wheatDark: 0xa08744,
  reed: 0x8d9159,
  bark: 0x6b5741,
  barkPale: 0x8b7a63,
  flowerA: 0xd9c25f,
  flowerB: 0xc9736f,
  flowerC: 0xd8d2c2,
  // atmosphere
  shadowViolet: 0x4a3f52,
  darkest: 0x3a2f33,
  cream: 0xf3e8cf,
  skyHorizon: 0xb9c4bd,
  skyZenith: 0x8aa2ab,
  skyGold: 0xe4d3a8,
  water: 0x5e7a78,
  waterDeep: 0x40575c,
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

// Soft quantiser: floor() with a smoothstep across each boundary so the band
// edge "bleeds" the way a wet wash does against dry paper, and the boundary
// itself is warped by paper fibre so it is never a straight contour line.
float bandify(float s, float warp) {
  float sc = (s + warp) * uBands;
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

  // Recover (N.L * shadow) from three's Lambert accumulation:
  //   directDiffuse = sunColor * NdotL * shadow * diffuse / PI
  // Valid while the scene has exactly one directional light, which is how
  // World sets it up (it adopts an existing 'sun' rather than adding a second).
  float npShade = dot(reflectedLight.directDiffuse, vec3(0.33333)) / (npLum * uSunLum);
  npShade = clamp(npShade, 0.0, 1.35);

  vec2 npPx = gl_FragCoord.xy;
  float npFibre = texture2D(uPaperTex, npPx * 0.0021).r;
  float npFibre2 = texture2D(uPaperTex, npPx * 0.0073 + vec2(0.37, 0.61)).r;

  float npQ = bandify(npShade, (npFibre - 0.5) * uBleed);

  // Warm in light, violet-blue in shade. Never grey, never black.
  vec3 npShadeCol = mix(npBase * uShadeTint, uShadeTint, 0.30);
  vec3 npMidCol   = npBase * uMidTint;
  vec3 npLitCol   = npBase * uLitTint + vec3(0.045, 0.038, 0.022);
  vec3 npCol = mix(npShadeCol, npMidCol, smoothstep(0.0, 0.52, npQ));
  npCol = mix(npCol, npLitCol, smoothstep(0.48, 1.0, npQ));

  // Rim: a thin straw-coloured halo where the surface turns away, stepped so
  // it reads as a drawn highlight rather than a fresnel gradient.
  vec3 npView = normalize(vViewPosition);
  float npFres = 1.0 - clamp(dot(normalize(normal), npView), 0.0, 1.0);
  float npRim = smoothstep(0.62, 0.94, npFres) * uRim * (0.25 + 0.75 * npQ);
  npCol += npRim * vec3(0.40, 0.33, 0.20);

  // Pencil hatching, screen-space aligned, only in the lower bands. The stroke
  // phase is jittered by paper fibre so the lines waver like a real hand.
  float npHatchAmt = uHatch * smoothstep(0.66, 0.10, npQ);
  if (npHatchAmt > 0.001) {
    float npWob = (npFibre2 - 0.5) * 5.0;
    float npL1 = sin((npPx.x * 0.7071 + npPx.y * 0.7071) * 0.52 + npWob);
    float npHatch = smoothstep(0.10, 0.78, npL1);
    // cross-hatch the darkest band only
    float npDeep = smoothstep(0.34, 0.04, npQ);
    float npL2 = sin((npPx.x * 0.7071 - npPx.y * 0.7071) * 0.49 - npWob * 0.8);
    npHatch = mix(npHatch, max(npHatch, smoothstep(0.10, 0.78, npL2)), npDeep);
    npCol *= 1.0 - npHatchAmt * npHatch * 0.42;
  }

  // Paper grain bites hardest through the midtones and disappears in the
  // highlights, exactly like pigment sitting in the tooth of cold-press stock.
  float npMid = 1.0 - abs(npQ * 2.0 - 1.0);
  npCol *= mix(1.0, 0.74 + npFibre * 0.52, uPaper * npMid);

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
    uEdge: { value: opts.edge ?? 0.16 },
    uBleed: { value: opts.bleed ?? 0.075 },
    uHatch: { value: opts.hatch ?? CFG.render.hatchStrength ?? 0.6 },
    uPaper: { value: opts.paper ?? CFG.render.paperStrength ?? 0.42 },
    uRim: { value: opts.rim ?? 0.5 },
    uSunLum: { value: sunLum() },
    uLitTint: { value: new THREE.Color(opts.litTint ?? 0xfff2d8) },
    uMidTint: { value: new THREE.Color(opts.midTint ?? 0xd8cfc0) },
    uShadeTint: { value: new THREE.Color(opts.shadeTint ?? 0x584a63) },
    uFloorCol: { value: new THREE.Color(opts.floorCol ?? 0x241d21) },
    uPaperTex: { value: paperTexture(512, 77) },
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

/**
 * Opaque surface: buildings, props, bridges, tree trunks.
 * opts: { color, map, vertexColors, side, roughness, hatch, rim, flatShading,
 *         outline, transparent, alphaTest }
 */
export function makeSurfaceMaterial(opts = {}) {
  const needs = ['vertexColors'];
  if (opts.instanced) needs.push('instancing');
  if (opts.map) needs.push('map');
  if (opts.alphaTest) needs.push('alphaTest');
  const m =
    tryRender(Mats.makeCanvasMaterial, {
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
    }, needs) || makeFallbackSurface({ ...opts, vertexColors: opts.vertexColors ?? true });
  return m;
}

/**
 * Terrain. The geometry's `color` attribute is a vec4 SPLAT
 * (r grass, g dirt, b rock, a mud) because that is the channel layout
 * src/render/materials.js reads under VC_SPLAT_VCOL; `aAlbedo` carries the
 * fully-baked colour for the fallback path.
 */
export function makeTerrainSurfaceMaterial(opts = {}) {
  const m =
    tryRender(Mats.makeTerrainMaterial, {
      splatFromVertexColor: true,
      vertexColors: true,
      grass: opts.grass ?? PALETTE.grass,
      dirt: opts.dirt ?? PALETTE.dirt,
      rock: opts.rock ?? PALETTE.rock,
      mud: opts.mud ?? PALETTE.mud,
      // Mud is authored by the splat; give the shader's own height term a sane
      // waterline too so shorelines agree even if the splat is ignored.
      mudLevel: opts.mudLevel ?? 3.1,
      mudFade: 1.6,
      rockSlope: 0.42,
      hatch: opts.hatch ?? 0.85,
      bands: CFG.render.bands,
      outline: false,
      color: 0xffffff,
    }, ['vertexColors']) ||
    makeFallbackSurface({
      color: 0xffffff,
      vertexColors: false,
      albedoAttr: true,
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
    tryRender(Mats.makeGrassMaterial, {
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
    }, needs) ||
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
