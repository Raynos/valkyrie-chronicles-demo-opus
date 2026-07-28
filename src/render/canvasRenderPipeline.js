// src/render/canvasRenderPipeline.js
// -----------------------------------------------------------------------------
// The CANVAS-engine post stack. Call `pipeline.render(dt)` INSTEAD of
// `renderer.render(scene, camera)`.
//
//   1. G-BUFFER PREPASS  — MRT (view normal + linear depth | object id + line
//      weight). Each material supplies its own prepass variant so skinned
//      soldiers and wind-blown grass produce a G-buffer that matches the colour
//      pass exactly.
//   2. MAIN COLOUR PASS  — into a HalfFloat target so emissive/rim highlights
//      can exceed 1.0 and survive into bloom.
//   3. DEPTH OF FIELD    — quality 2 only; golden-angle bokeh gathered with a
//      scatter-as-gather weight so the background cannot bleed onto a sharp
//      foreground.
//   4. BLOOM             — CoD-style progressive down/up sample with a 13-tap
//      downsample (Karis-averaged on the first level) and a 9-tap tent upsample.
//   5. COMPOSITE         — bloom add, then the GRAPHITE OUTLINE drawn over the
//      top: depth (plane-fit, so grazing terrain doesn't false-positive), normal
//      and object-id discontinuities, sampled through a noise flow field so the
//      stroke wobbles, widened on silhouettes and thinned on interior creases,
//      textured with graphite grain, plus a faint offset sketch double-stroke.
//      Finally AERIAL PERSPECTIVE, applied on top of the linework so a hedgerow
//      at 150 m loses its pencil as well as its contrast.
//   6. GRADE + PAPER     — line-preserving FXAA, chromatic aberration, filmic
//      tonemap to a cream white point, split-tone, saturation shaping, paper
//      fibre multiply that peaks in the midtones, paper cockle, vignette.
// -----------------------------------------------------------------------------

import * as THREE from 'three';
import { CFG } from '../core/config.js';
import { Bus } from '../core/bus.js';
import { GLSL_HASH, GLSL_NOISE, GLSL_COLOR, GLSL_BANDS, GLSL_TONEMAP, FS_VERT } from './shaderLib.js';
import { getPaperTexture, getGrainTexture, getNoiseTexture } from './textures.js';
import { MaterialRegistry, getGenericPrepassMaterial, PALETTE } from './materials.js';

const HALF = THREE.HalfFloatType;

// See _bloom(): CFG's threshold is authored for a physical range we do not use.
const BLOOM_THRESHOLD_SCALE = 0.55;

// ------------------------------------------------------------- fullscreen
class FsQuad {
  constructor() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
    this.geometry = g;
    this.mesh = new THREE.Mesh(g, null);
    this.mesh.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.mesh);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }
  draw(renderer, material, target, clear = true) {
    this.mesh.material = material;
    renderer.setRenderTarget(target || null);
    const prevAuto = renderer.autoClear;
    renderer.autoClear = clear;
    renderer.render(this.scene, this.camera);
    renderer.autoClear = prevAuto;
  }
  dispose() { this.geometry.dispose(); }
}

function rt(w, h, opts = {}) {
  const t = new THREE.WebGLRenderTarget(w, h, Object.assign({
    type: HALF,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  }, opts));
  t.texture.colorSpace = THREE.NoColorSpace;
  for (const tex of t.textures) { tex.colorSpace = THREE.NoColorSpace; tex.generateMipmaps = false; }
  return t;
}

// ============================================================== SHADERS

const COMMON = GLSL_HASH + GLSL_NOISE + GLSL_COLOR;

// ---- bloom prefilter + downsample -------------------------------------------
const BLOOM_DOWN_FRAG = /* glsl */`
${COMMON}
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uThreshold;
uniform float uSoftKnee;
varying vec2 vUv;

vec3 prefilter(vec3 c) {
  float br = max(c.r, max(c.g, c.b));
  float knee = uThreshold * uSoftKnee + 1e-5;
  float rq = clamp(br - uThreshold + knee, 0.0, 2.0 * knee);
  rq = rq * rq / (4.0 * knee + 1e-5);
  float contrib = max(rq, br - uThreshold) / max(br, 1e-5);
  return c * contrib;
}

vec3 tap(vec2 uv) { return texture2D(tSrc, uv).rgb; }

void main() {
  vec2 t = uTexel;
  // 13-tap Jimenez downsample: 4 overlapping quads + a centre quad
  vec3 a = tap(vUv + t * vec2(-2.0,  2.0));
  vec3 b = tap(vUv + t * vec2( 0.0,  2.0));
  vec3 c = tap(vUv + t * vec2( 2.0,  2.0));
  vec3 d = tap(vUv + t * vec2(-2.0,  0.0));
  vec3 e = tap(vUv);
  vec3 f = tap(vUv + t * vec2( 2.0,  0.0));
  vec3 g = tap(vUv + t * vec2(-2.0, -2.0));
  vec3 h = tap(vUv + t * vec2( 0.0, -2.0));
  vec3 i = tap(vUv + t * vec2( 2.0, -2.0));
  vec3 j = tap(vUv + t * vec2(-1.0,  1.0));
  vec3 k = tap(vUv + t * vec2( 1.0,  1.0));
  vec3 l = tap(vUv + t * vec2(-1.0, -1.0));
  vec3 m = tap(vUv + t * vec2( 1.0, -1.0));

#ifdef VC_PREFILTER
  // Karis average the inner quad before thresholding — one stray HDR pixel
  // otherwise flickers as a firefly through the whole mip chain.
  vec3 g0 = (j + k + l + m) * 0.25;
  vec3 g1 = (a + b + d + e) * 0.25;
  vec3 g2 = (b + c + e + f) * 0.25;
  vec3 g3 = (d + e + g + h) * 0.25;
  vec3 g4 = (e + f + h + i) * 0.25;
  float w0 = 1.0 / (1.0 + vcLum(g0));
  float w1 = 1.0 / (1.0 + vcLum(g1));
  float w2 = 1.0 / (1.0 + vcLum(g2));
  float w3 = 1.0 / (1.0 + vcLum(g3));
  float w4 = 1.0 / (1.0 + vcLum(g4));
  float wsum = w0 * 0.5 + (w1 + w2 + w3 + w4) * 0.125;
  vec3 col = (g0 * w0 * 0.5 + g1 * w1 * 0.125 + g2 * w2 * 0.125 + g3 * w3 * 0.125 + g4 * w4 * 0.125) / max(wsum, 1e-5);
  col = prefilter(col);
#else
  vec3 col = e * 0.125;
  col += (a + c + g + i) * 0.03125;
  col += (b + d + f + h) * 0.0625;
  col += (j + k + l + m) * 0.125;
#endif
  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
}
`;

// ---- bloom upsample (9-tap tent, additively blended into the larger mip) -----
const BLOOM_UP_FRAG = /* glsl */`
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uRadius;
varying vec2 vUv;

void main() {
  vec2 t = uTexel * uRadius;
  vec3 c = texture2D(tSrc, vUv + vec2(-t.x,  t.y)).rgb * 1.0;
  c += texture2D(tSrc, vUv + vec2( 0.0,  t.y)).rgb * 2.0;
  c += texture2D(tSrc, vUv + vec2( t.x,  t.y)).rgb * 1.0;
  c += texture2D(tSrc, vUv + vec2(-t.x,  0.0)).rgb * 2.0;
  c += texture2D(tSrc, vUv).rgb * 4.0;
  c += texture2D(tSrc, vUv + vec2( t.x,  0.0)).rgb * 2.0;
  c += texture2D(tSrc, vUv + vec2(-t.x, -t.y)).rgb * 1.0;
  c += texture2D(tSrc, vUv + vec2( 0.0, -t.y)).rgb * 2.0;
  c += texture2D(tSrc, vUv + vec2( t.x, -t.y)).rgb * 1.0;
  gl_FragColor = vec4(c * (1.0 / 16.0), 1.0);
}
`;

// ---- contact shadow + ambient occlusion -------------------------------------
// Two screen-space terms, both read straight out of the G-buffer, both about
// ONE thing: making a figure sit ON the ground instead of in front of it.
//
//   .r  hemisphere occlusion (Alchemy estimator) — the general darkening in a
//       crease, at the root of a grass sward, where a wall meets a road.
//   .g  a short ray-march toward the sun — the hard little dark seam directly
//       under a boot or a track link. This exists because it is INDEPENDENT of
//       shadow-map resolution: a 0.28 m boot sole is below the filter width of
//       any single-cascade shadow map that also has to cover a valley, and that
//       is exactly why round 1's hero "cast no shadow whatsoever".
//
// Output is a visibility pair (1 = open sky). The composite turns it into a
// painted wash, not a grey multiply — see COMPOSITE_FRAG.
const CONTACT_FRAG = /* glsl */`
${COMMON}
uniform sampler2D tND;
uniform sampler2D tNoise;
uniform vec2  uResolution;     // of THIS target
uniform float uFar;
uniform float uTanHalfFov;
uniform float uAspect;
uniform vec3  uSunV;           // view-space unit vector TOWARD the sun
uniform float uAoRadius;       // metres
uniform float uRayLength;      // metres
uniform float uThickness;      // metres — how deep a hit still counts as a hit
varying vec2 vUv;

const int   AO_TAPS = 10;
const float GA = 2.39996323;

vec3 rayAt(vec2 uv) {
  vec2 n = uv * 2.0 - 1.0;
  return vec3(n.x * uTanHalfFov * uAspect, n.y * uTanHalfFov, -1.0);
}
vec2 uvOf(vec3 p) {
  float z = max(-p.z, 1e-3);
  return vec2(p.x / (z * uTanHalfFov * uAspect), p.y / (z * uTanHalfFov)) * 0.5 + 0.5;
}

void main() {
  vec4 nd = texture2D(tND, vUv);
  float lz = nd.a;
  // sky: fully open, and never let the ray-march use it as an occluder
  if (lz <= 0.0001 || length(nd.xyz) < 0.4) { gl_FragColor = vec4(1.0, 1.0, 0.0, 1.0); return; }

  vec3 P = rayAt(vUv) * (lz * uFar);
  vec3 N = normalize(nd.xyz);
  float z = -P.z;

  // Rotating the sample pattern by a LOW-FREQUENCY field rather than per-pixel
  // hash matters: the wash is quantised downstream, and a per-pixel rotation
  // would quantise into salt-and-pepper. Correlated over ~40 px it quantises
  // into blotches, which is what pigment does.
  vec2 sPx = vUv * uResolution;
  float phi = texture2D(tNoise, sPx / 41.0).r * 6.2831853;

  // ---- hemisphere occlusion ------------------------------------------------
  float rUv = uAoRadius * 0.5 / (uTanHalfFov * max(z, 0.30));
  float r2max = uAoRadius * uAoRadius * 1.8;
  float ao = 0.0;
  for (int i = 0; i < AO_TAPS; i++) {
    float fi = float(i) + 0.5;
    float rr = sqrt(fi / float(AO_TAPS));
    float a = fi * GA + phi;
    vec2 suv = vUv + vec2(cos(a) / uAspect, sin(a)) * rr * rUv;
    vec4 snd = texture2D(tND, suv);
    float slz = snd.a;
    float valid = step(0.0001, slz) * step(0.4, length(snd.xyz));
    vec3 v = rayAt(suv) * (slz * uFar) - P;
    float vv = dot(v, v);
    ao += max(0.0, dot(v, N) - z * 0.0018) / (vv + 0.02)
        * step(vv, r2max) * valid;
  }
  float vis = clamp(1.0 - (2.0 * uAoRadius / float(AO_TAPS)) * ao, 0.0, 1.0);

  // ---- contact ray-march toward the sun ------------------------------------
  // Only for surfaces that FACE the sun. A wall whose normal points away is
  // already on the dark side of its own terminator, and marching a ray out of
  // it just skims along inside the geometry and reports a hit at every step —
  // which stamped a full-strength second shadow over the entire shaded face of
  // the bridge. The N.L gate is what makes a screen-space contact term usable
  // at all; without it it is a back-face detector.
  float ndl = dot(N, uSunV);
  float occ = 0.0;
  if (ndl > 0.03) {
    float steps = 8.0;
    float stepLen = uRayLength / steps;
    float jit = texture2D(tNoise, sPx / 19.0 + 0.53).g;
    // Start off the surface by more than a depth texel's worth of slope, or a
    // grazing plane self-intersects on the very first step.
    float startOff = 0.010 + z * 0.0025 + (1.0 - ndl) * 0.030;
    vec3 rp = P + N * startOff + uSunV * stepLen * (0.30 + 0.70 * jit);
    for (int i = 0; i < 8; i++) {
      rp += uSunV * stepLen;
      vec2 suv = uvOf(rp);
      float inside = step(0.0, suv.x) * step(suv.x, 1.0) * step(0.0, suv.y) * step(suv.y, 1.0);
      vec4 snd = texture2D(tND, suv);
      float sz = snd.a * uFar;
      float diff = -rp.z - sz;                     // >0 = the ray is behind geometry
      float hit = smoothstep(0.018, 0.055, diff) * (1.0 - smoothstep(uThickness * 0.65, uThickness, diff));
      hit *= inside * step(0.0001, snd.a) * step(0.4, length(snd.xyz));
      occ = max(occ, hit * (1.0 - float(i) / steps * 0.5));
    }
    // fade the term out as the surface approaches its own terminator, where the
    // shading is taking over anyway
    occ *= smoothstep(0.03, 0.28, ndl);
  }
  // A contact seam is a near-field read. Past ~35 m it is smaller than a pixel
  // and all it can contribute is shimmer.
  occ *= 1.0 - smoothstep(26.0, 62.0, z);

  gl_FragColor = vec4(vis, 1.0 - occ, 0.0, 1.0);
}
`;

// ---- depth of field ---------------------------------------------------------
const DOF_FRAG = /* glsl */`
${COMMON}
uniform sampler2D tColor;
uniform sampler2D tND;
uniform vec2 uTexel;
uniform float uFar;
uniform float uFocus;       // metres
uniform float uRange;       // metres of acceptable sharpness either side
uniform float uMaxCoC;      // pixels
varying vec2 vUv;

float cocAt(vec2 uv) {
  float z = texture2D(tND, uv).a * uFar;
  if (z <= 0.0001) z = uFar;                       // sky
  float d = (z - uFocus) / max(uRange, 0.01);
  // asymmetric: foreground goes soft faster than background, as a long lens does
  d = d < 0.0 ? d * 1.7 : d;
  return clamp(abs(d), 0.0, 1.0) * uMaxCoC;
}

void main() {
  float coc = cocAt(vUv);
  vec3 sum = texture2D(tColor, vUv).rgb;
  float wsum = 1.0;
  if (coc > 0.6) {
    // golden-angle spiral: 16 taps give a clean circular bokeh with no rings
    const float GA = 2.39996323;
    for (int i = 0; i < 16; i++) {
      float fi = float(i) + 0.5;
      float r = sqrt(fi / 16.0);
      float a = fi * GA;
      vec2 off = vec2(cos(a), sin(a)) * r * coc * uTexel;
      vec3 s = texture2D(tColor, vUv + off).rgb;
      float sc = cocAt(vUv + off);
      // scatter-as-gather: a sharp foreground pixel must not be smeared by a
      // blurry background tap, but a blurry tap may bleed onto a blurry centre
      float w = clamp((sc - r * coc) * 2.0 + 1.0, 0.03, 1.0);
      sum += s * w;
      wsum += w;
    }
  }
  gl_FragColor = vec4(sum / wsum, 1.0);
}
`;

// ---- composite: bloom + graphite outline ------------------------------------
const COMPOSITE_FRAG = /* glsl */`
${COMMON}
${GLSL_BANDS}
uniform sampler2D tColor;
uniform sampler2D tBloom;
uniform sampler2D tND;
uniform sampler2D tMeta;
uniform sampler2D tGrain;
uniform sampler2D tNoise;
uniform sampler2D tContact;

uniform vec2  uTexel;
uniform vec2  uResolution;
uniform float uPixelRatio;
uniform float uFar;
uniform float uTanHalfFov;
uniform float uAspect;
uniform float uOutlineWidth;
uniform float uWobble;
uniform float uBloomStrength;
uniform float uHorizonLine;
uniform vec3  uInk;
uniform vec3  uBloomTint;

// ink recession
uniform float uInkFadeStart;  // metres — ink is full strength nearer than this
uniform float uInkFadeEnd;    // metres — and at its faintest past this

// contact wash
uniform float uAoStrength;
uniform float uContactStrength;
uniform vec3  uContactViolet;
uniform vec3  uInkFloor;

// aerial perspective
uniform mat4  uViewToWorld;
uniform vec3  uHazeColor;
uniform float uHazeDensity;   // 1/metres
uniform float uHazeStart;     // metres of clear air in front of the camera
uniform float uHazeRefK;      // ...or this fraction of the subject distance
uniform float uHazeMax;
uniform float uHazeHeight;    // metres of scale height above uHazeBase
uniform float uHazeBase;

varying vec2 vUv;

// view-space ray through a uv (z == -1 plane)
vec3 rayAt(vec2 uv) {
  vec2 ndc = uv * 2.0 - 1.0;
  return vec3(ndc.x * uTanHalfFov * uAspect, ndc.y * uTanHalfFov, -1.0);
}

// Plane-fit depth edge. Reconstruct the centre surface as a plane and ask what
// depth the neighbour SHOULD have if it were on that same plane. A steep floor
// seen at a grazing angle has a huge raw depth gradient but zero plane error —
// this is what stops the terrain from being scribbled all over.
float planeError(vec3 P, vec3 N, vec2 uvn, float lzN) {
  vec3 r = rayAt(uvn);
  float denom = dot(N, r);
  denom = abs(denom) < 1e-4 ? (denom < 0.0 ? -1e-4 : 1e-4) : denom;
  float t = dot(N, P) / denom;
  float expected = t / uFar;
  return abs(lzN - expected) * uFar;      // metres
}

struct Gb { vec3 n; float lz; vec2 id; float w; };

Gb sampleGb(vec2 uv) {
  vec4 nd = texture2D(tND, uv);
  vec4 mt = texture2D(tMeta, uv);
  Gb g;
  g.n = nd.xyz;
  g.lz = nd.w;
  g.id = mt.rg;
  g.w = mt.b;
  return g;
}

void main() {
  vec2 uv = vUv;
  vec3 color = texture2D(tColor, uv).rgb;

  // ---- bloom first: the linework is drawn ON TOP of the painted image, so it
  // must not be blurred into the glow.
  vec3 bloom = texture2D(tBloom, uv).rgb;
  color += bloom * uBloomStrength * uBloomTint;

  vec2 sPx = uv * uResolution;
  vec4 ndC = texture2D(tND, uv);
  float isSkyC = step(length(ndC.xyz), 0.4);
  float distC = ndC.a * uFar;

  // ---- how far away the SUBJECT is -----------------------------------------
  // Nine fixed taps over the middle of the frame, sky excluded. Every fragment
  // computes the same number, so this is one coherent fetch group, not a
  // dependent read.
  //
  // Aerial perspective and ink recession are both RELATIVE effects: a painter
  // draws whatever the picture is about crisply and lets everything behind it
  // recede. An absolute distance ramp cannot express that — tuned so a village
  // at 60 m recedes in the over-the-shoulder frame, it also greys out the whole
  // command plate, where the nearest ground is already 45 m away and the map is
  // supposed to read like a clean illustrated page.
  float refZ;
  {
    float s = 0.0, n = 0.0;
    for (int i = 0; i < 9; i++) {
      vec2 t = vec2(float(i - (i / 3) * 3) * 0.25 + 0.25, float(i / 3) * 0.22 + 0.28);
      vec4 d = texture2D(tND, t);
      float ok = step(0.4, length(d.xyz));
      s += d.a * uFar * ok; n += ok;
    }
    refZ = n > 0.5 ? s / n : 40.0;
  }
  float hazeStart = clamp(max(uHazeStart, refZ * uHazeRefK), uHazeStart, 90.0);
  float inkStart = max(uInkFadeStart, refZ * 0.85);
  float inkEnd = inkStart + max(8.0, uInkFadeEnd - uInkFadeStart);

  // ---- contact wash --------------------------------------------------------
  // Screen-space occlusion, PAINTED. A straight multiply would give the same
  // airbrushed grey ramp the critique called out on the cast shadows; instead
  // the occlusion is quantised into the same kind of stepped wash the surface
  // shading uses, with the step boundary dragged around by paper fibre, and it
  // is applied as a SHADE COLOUR (violet-cooled pigment) rather than a grey.
  {
    vec2 cs = texture2D(tContact, uv).rg;
    float occ = clamp((1.0 - cs.r) * uAoStrength + (1.0 - cs.g) * uContactStrength, 0.0, 1.0);
    occ *= 1.0 - isSkyC;
    if (occ > 0.004) {
      float f1 = vcFbm3(sPx / 33.0);
      float f2 = vcFbm3(sPx / 13.0 + 7.3);
      vec2 q = vcQuantiseBands(1.0 - occ, 3.0, 0.55, f1, f2);
      float wash = clamp(1.0 - q.x, 0.0, 1.0);
      // the wet rim of a drying wash dries darker than its middle
      wash = clamp(wash * (1.0 + q.y * 0.22), 0.0, 1.0);
      color = mix(color, vcShadowColour(color, uContactViolet, uInkFloor), wash * 0.9);
    }
  }

  // ---- flow-field wobble ---------------------------------------------------
  // Three octaves, and enough amplitude that the stroke visibly LEAVES the
  // geometric edge — a machine-traced contour is the loudest linework tell
  // there is. The long octave drifts the whole line, the short one gives it the
  // small tremor of a hand.
  vec2 flow = texture2D(tNoise, sPx / 215.0).rg - 0.5;
  flow += (texture2D(tNoise, sPx / 61.0 + 0.37).gb - 0.5) * 0.52;
  flow += (texture2D(tNoise, sPx / 17.0 + 0.71).br - 0.5) * 0.20;
  vec2 wuv = uv + flow * uTexel * uWobble * 6.2;

  Gb c = sampleGb(wuv);
  float isSky = step(length(c.n), 0.4);
  float distM = c.lz * uFar;

  vec3 P = rayAt(wuv) * (c.lz * uFar);
  vec3 N = normalize(c.n + vec3(0.0, 0.0, 1e-5));

  // ---- width: fat graphite on near silhouettes, hairline on interior creases
  // Depth is read in METRES, not in normalised depth — with uFar at 900 m the
  // old smoothstep(0.0, 0.14, lz) did not finish until 126 m, so a house at
  // 60 m still got a near-field stroke.
  float depthScale = mix(2.45, 0.55, smoothstep(3.5, 52.0, distM));
  float fat = uOutlineWidth * depthScale;
  // A crease offset below ~1 texel samples the same G-buffer texel twice and
  // reports no normal difference at all, so the hairline is made thin in INK
  // WEIGHT rather than in radius.
  float thin = max(1.0, uOutlineWidth * 0.42);

  vec2 oF = uTexel * fat;
  vec2 oT = uTexel * thin;

  // ---- silhouette term: depth discontinuity + object id break --------------
  // Eight taps on a circle rather than four on a square: the average of eight
  // binary id tests is a NINE-LEVEL coverage value, which is what anti-aliases
  // the stroke. The old 4-tap max() produced a hard 0/1 edge, i.e. the
  // stair-stepping the critique named.
  float sil = 0.0;
  float skyEdge = 0.0;
  float lineW = c.w;
  float silMag = 0.0;
  {
    float dAcc = 0.0, idAcc = 0.0, nbW = 0.0, skyN = 0.0, errMax = 0.0, nMax = 0.0;
    float tol = 0.030 + distM * 0.0115 + fat * 0.010;
    for (int i = 0; i < 8; i++) {
      float ang = float(i) * 0.7853981634 + 0.31;
      vec2 off = vec2(cos(ang), sin(ang)) * oF;
      Gb s = sampleGb(wuv + off);
      float e = planeError(P, N, wuv + off, s.lz);
      errMax = max(errMax, e);
      dAcc += smoothstep(tol, tol * 2.8, e);
      idAcc += step(0.006, length(s.id - c.id));
      nbW = max(nbW, s.w);
      skyN = max(skyN, step(length(s.n), 0.4));
      nMax = max(nMax, length(s.n - c.n));
    }
    float dEdge = clamp(dAcc * 0.125 * 2.2, 0.0, 1.0);

    // COPLANAR-JOIN SUPPRESSION. An id break with neither a depth step nor a
    // normal turn is two boxes of the same wall meeting flush — the bridge
    // barrel's "staircase of individually-outlined boxes". Gate the id term on
    // there actually being a discontinuity to draw.
    float idGate = max(smoothstep(tol * 0.55, tol * 2.2, errMax),
                       smoothstep(0.20, 0.72, nMax));
    float idE = clamp(idAcc * 0.125 * 2.2, 0.0, 1.0) * idGate;

    // The stroke belongs to the OUTLINED object, drawn just inside its own
    // silhouette; the far side gets only a faint outer halo. Taking a plain
    // max() here would draw the full line on both sides of every boundary,
    // which is what turns grass in front of a wall into black scribble.
    lineW = max(lineW, nbW * 0.42);

    // terrain silhouetted against the sky still wants a horizon stroke even
    // though the ground itself is not an outlined object
    skyEdge = skyN * (1.0 - isSky);

    sil = max(dEdge, idE * 0.92);
    // How big the jump is, i.e. how much pressure the pencil gets. A true
    // silhouette against distant ground is a hard press; a 4 cm step in a wall
    // is a light one.
    silMag = clamp(errMax / max(tol * 2.6, 1e-4), 0.0, 1.0);
  }

  // ---- crease term: normal discontinuity at a tight radius ----------------
  float crease = 0.0;
  {
    vec2 d1 = vec2(oT.x, oT.y);
    vec2 d2 = vec2(oT.x, -oT.y);
    vec3 n1 = texture2D(tND, wuv + d1).xyz;
    vec3 n2 = texture2D(tND, wuv - d1).xyz;
    vec3 n3 = texture2D(tND, wuv + d2).xyz;
    vec3 n4 = texture2D(tND, wuv - d2).xyz;
    float a = length(n1 - n2);
    float b = length(n3 - n4);
    float nd = sqrt(a * a + b * b);
    // Raised from 0.62: a near-coplanar pair of faces (a bevel, a shallow roof
    // hip, two boxes 5 degrees apart) was clearing the old threshold and got
    // the same weight as a real fold.
    crease = smoothstep(0.78, 1.45, nd) * mix(1.0, 0.12, smoothstep(2.5, 36.0, distM));
  }

  // ---- graphite tooth ------------------------------------------------------
  float grain = texture2D(tGrain, sPx / (256.0 * uPixelRatio) * 1.35).r;
  float grainFine = texture2D(tGrain, sPx / (256.0 * uPixelRatio) * 4.1 + 0.21).b;

  // Variable pressure. A silhouette with a big depth jump gets the full weight;
  // a shallow one gets a light stroke. Creases are hairlines: same radius,
  // barely any graphite, and broken up hard by the tooth so they read as a
  // pencil skipping over cold-press rather than a traced contour.
  float silLine = sil * mix(0.42, 1.0, silMag);
  float creaseLine = crease * 0.44 * mix(0.30, 1.0, grain);
  float line = max(silLine, creaseLine) * lineW * 2.0;
  line = max(line, skyEdge * uHorizonLine);
  line *= 1.0 - isSky;                     // never draw inside the sky itself

  line *= mix(0.42, 1.32, grain * 0.62 + grainFine * 0.38);

#ifdef VC_DOUBLE_STROKE
  // The sketch double-stroke: real VC linework has a fainter ghost line a
  // pixel or two off the main one, where the pencil was laid down twice.
  {
    vec2 dir = normalize(flow + vec2(0.31, -0.19));
    vec2 duv = wuv + dir * uTexel * (1.9 + 1.8 * grain);
    Gb g0 = sampleGb(duv);
    vec3 P2 = rayAt(duv) * (g0.lz * uFar);
    vec3 N2 = normalize(g0.n + vec3(0.0, 0.0, 1e-5));
    vec2 dd = vec2(oF.x, oF.y);
    float e = max(planeError(P2, N2, duv + dd, sampleGb(duv + dd).lz),
                  planeError(P2, N2, duv - dd, sampleGb(duv - dd).lz));
    float tol2 = 0.030 + g0.lz * uFar * 0.0115;
    float d2 = smoothstep(tol2, tol2 * 3.4, e) * g0.w * 2.0;
    line = max(line, d2 * 0.30 * mix(0.5, 1.2, grainFine));
  }
#endif

  // ---- ink recession -------------------------------------------------------
  // The round-1 pass shrank its SAMPLE OFFSET with depth but never its opacity,
  // so a house at 60 m carried linework as black as a soldier at 9 m and the
  // frame's depth cues ran backwards. Ink loses density with distance and, more
  // importantly, loses its BLACKNESS: far strokes are grey-violet, the colour
  // of the air they are seen through.
  float far01 = smoothstep(inkStart, inkEnd, distM);
  line *= mix(1.0, 0.18, far01);

  float a = clamp(line, 0.0, 1.0);
  // Graphite over a wash is never opaque black — it takes the value of what is
  // under it, which is why a pencil line on a lit surface reads warm.
  vec3 inkCol = mix(uInk, uHazeColor * 0.60, far01 * 0.9);
  vec3 ink = inkCol * (0.55 + 0.75 * vcLum(color));
  color = mix(color, min(color, ink), a);

  // ---- aerial perspective --------------------------------------------------
  // Applied AFTER the linework, on purpose: in a painting the pencil recedes
  // with everything else, so a hedgerow at 150 m must lose its outline as well
  // as its contrast. Skipping the sky keeps the dome's own gradient intact.
  {
    // Reconstruct world height so a hill top hazes less than the valley floor
    // it stands in — that vertical gradient is most of what reads as "air".
    vec3 vpos = rayAt(uv) * distC;
    float wy = (uViewToWorld * vec4(vpos, 1.0)).y;
    float hFall = exp(-max(wy - uHazeBase, 0.0) / max(uHazeHeight, 1.0));
    float haze = (1.0 - exp(-max(distC - hazeStart, 0.0) * uHazeDensity));
    haze *= mix(0.55, 1.0, hFall) * uHazeMax * (1.0 - isSkyC);
    // haze both LIGHTENS and WARMS; carrying a little of the pixel's own value
    // into the mix stops distant darks turning into flat grey cut-outs
    vec3 hz = uHazeColor * (0.86 + 0.30 * vcLum(color));
    color = mix(color, hz, clamp(haze, 0.0, 1.0));
  }

  gl_FragColor = vec4(color, 1.0);
}
`;

// ---- grade + paper ----------------------------------------------------------
const GRADE_FRAG = /* glsl */`
${COMMON}
${GLSL_TONEMAP}
uniform sampler2D tColor;
uniform sampler2D tPaper;
uniform vec2  uTexel;
uniform vec2  uResolution;
uniform float uPixelRatio;
uniform float uExposure;
uniform float uVignette;
uniform float uChroma;
uniform float uPaperStrength;
uniform float uSaturation;
uniform float uContrast;
uniform float uTime;
uniform vec3  uPaperWhite;
uniform vec3  uInkBlack;
uniform vec3  uShadowTint;
uniform vec3  uHighTint;
uniform vec3  uVignetteTint;
varying vec2 vUv;

float lumaOf(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

// FXAA-derived, but with a guard that refuses to blur a pixel that is much
// darker than its neighbourhood — i.e. a graphite line. Without this, AA turns
// crisp pencil work into grey mush, which is the single easiest way to lose
// the hand-drawn read.
vec3 vcAA(vec2 uv, vec2 texel) {
  vec3 rgbM  = texture2D(tColor, uv).rgb;
  vec3 rgbNW = texture2D(tColor, uv + vec2(-1.0, -1.0) * texel).rgb;
  vec3 rgbNE = texture2D(tColor, uv + vec2( 1.0, -1.0) * texel).rgb;
  vec3 rgbSW = texture2D(tColor, uv + vec2(-1.0,  1.0) * texel).rgb;
  vec3 rgbSE = texture2D(tColor, uv + vec2( 1.0,  1.0) * texel).rgb;

  float lM = lumaOf(rgbM);
  float lNW = lumaOf(rgbNW), lNE = lumaOf(rgbNE), lSW = lumaOf(rgbSW), lSE = lumaOf(rgbSE);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  float range = lMax - lMin;
  if (range < max(0.040, lMax * 0.150)) return rgbM;

  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
  float dirReduce = max((lNW + lNE + lSW + lSE) * 0.25 * 0.10, 1.0 / 128.0);
  float rcpMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
  dir = clamp(dir * rcpMin, -3.0, 3.0) * texel;

  vec3 rgbA = 0.5 * (texture2D(tColor, uv + dir * (1.0 / 3.0 - 0.5)).rgb +
                     texture2D(tColor, uv + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 rgbB = rgbA * 0.5 + 0.25 * (texture2D(tColor, uv + dir * -0.5).rgb +
                                   texture2D(tColor, uv + dir *  0.5).rgb);
  float lB = lumaOf(rgbB);
  vec3 res = (lB < lMin || lB > lMax) ? rgbA : rgbB;

  float lineness = clamp((lMax - lM) / max(range, 1e-4), 0.0, 1.0);
  return mix(res, rgbM, lineness * 0.62);
}

void main() {
  vec2 uv = vUv;
  vec2 d = uv - 0.5;
  float r2 = dot(d, d);

#ifdef VC_AA
  vec3 c = vcAA(uv, uTexel);
#else
  vec3 c = texture2D(tColor, uv).rgb;
#endif

#ifdef VC_CA
  // Radial chromatic fringing. The ramp is r^4, not linear: a shallow ramp puts
  // a visible cyan/yellow fringe on every hard edge across two thirds of the
  // frame, which on any dark silhouette reads as colour noise rather than as a
  // lens. Only the extreme corners should show it at all.
  // Halved again in round 2: on sub-pixel geometry (telegraph wires, grass
  // tips) the fringe stops reading as a lens and starts reading as a crawling
  // colour stipple, and it put saturated 176,38,41 pixels into the closeup.
  vec2 ca = d * uChroma * (0.01 + r2 * r2 * 2.0);
  float rr = texture2D(tColor, uv + ca).r;
  float bb = texture2D(tColor, uv - ca).b;
  c = vec3(mix(c.r, rr, 0.60), c.g, mix(c.b, bb, 0.60));
#endif

  // ---- tonemap to a cream white point --------------------------------------
  // The 1.10 pre-gain pairs with the raised white point in vcCanvasTonemap: it
  // keeps the midtones where they were while the shoulder gains headroom, which
  // is what stops a bright sky clipping to one flat cream slab.
  c = vcCanvasTonemap(c, uExposure * 1.10, uPaperWhite, uInkBlack, uContrast);

  // ---- split tone: warm brown-violet shadows, cream highlights --------------
  // Normalise both tints to unit luminance first — a split tone must move HUE,
  // not value. Tinting by a raw dark colour would drag the shadows back below
  // the warm brown-violet floor the tonemap just established.
  //
  // Keep this WEAK. It is the third violet term in the stack (after the shade
  // colour and the ambient tint in materials.js) and stacking three of them
  // multiplicatively is how 70% of the frame ended up lavender. The shadow tint
  // here must satisfy R >= B or the whole image reads cool.
  float l = lumaOf(c);
  vec3 sT = uShadowTint / max(lumaOf(uShadowTint), 1e-4);
  vec3 hT = uHighTint / max(lumaOf(uHighTint), 1e-4);
  c *= mix(sT, vec3(1.0), smoothstep(0.0, 0.46, l));
  c *= mix(vec3(1.0), hT, smoothstep(0.48, 1.0, l));

  // ---- saturation shaping: greens go dusty, ochres get lifted ---------------
  {
    vec3 hsv = vcRgb2Hsv(c);
    float dg = hsv.x - 0.295;                       // ~106 deg, foliage green
    float greenness = exp(-dg * dg / 0.0072);
    float dO = hsv.x - 0.095;                       // ~34 deg, ochre / umber
    float ochreness = exp(-dO * dO / 0.0052);
    // Gallia is green countryside. Take the electric edge off a video-game
    // green, do not launder it out of the palette entirely.
    hsv.y *= 1.0 - greenness * 0.11;
    hsv.y *= 1.0 + ochreness * 0.10;
    hsv.z *= 1.0 + ochreness * 0.030;
    hsv.y = clamp(hsv.y * uSaturation, 0.0, 1.0);
    c = vcHsv2Rgb(hsv);
  }

  // ---- paper ---------------------------------------------------------------
  vec2 pUv = uv * uResolution / (512.0 * uPixelRatio);
  vec4 paper = texture2D(tPaper, pUv);

  // strongest in the midtones, gone in blown highlights AND in the deep darks
  float mid = 1.0 - abs(l * 2.0 - 1.0);
  mid = pow(clamp(mid, 0.0, 1.0), 0.75);
  float fibre = 1.0 + (paper.r - 0.60) * 1.15;
  c *= mix(1.0, fibre, uPaperStrength * mid);

  // large-scale cockle: the buckle of a sheet that has been wetted and dried
  float cockle = texture2D(tPaper, uv * vec2(uResolution.x / uResolution.y, 1.0) * 0.55 + 0.21).b;
  c *= 1.0 + (cockle - 0.5) * 0.10 * uPaperStrength;

  // ---- vignette (warm umber, never a neutral grey wash) --------------------
  // The HUE shift stays; the VALUE crush is nearly gone. A 26% corner darkening
  // is a lens artefact, and a page of gouache has no lens — what a painted page
  // does have is warmer, slightly duller corners where the wash was laid last.
  float vig = 1.0 - uVignette * pow(clamp(r2 * 2.0, 0.0, 1.0), 1.25);
  vec3 vT = uVignetteTint / max(lumaOf(uVignetteTint), 1e-4);
  c *= mix(vT, vec3(1.0), vig);
  c *= mix(0.93, 1.0, vig);

  // 8-bit dither so the big flat washes do not band on the way out
  float dith = (vcHash21(gl_FragCoord.xy + fract(uTime) * 61.3) - 0.5) / 255.0;
  c += dith;

  gl_FragColor = vec4(max(c, vec3(0.0)), 1.0);
  #include <colorspace_fragment>
}
`;

// ================================================================ PIPELINE

export class CanvasRenderPipeline {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;

    this.quality = CFG.quality;
    this.time = 0;
    this.enabled = true;
    this.autoUpdateMaterials = true;
    this.lightRig = null;

    // Depth of field. Deliberately small, and it runs AFTER the ink (see
    // render()). Round 1 blurred the wash and left the linework razor-sharp on
    // top of it, which is a thing no painting can do and was the single tell
    // that lost the command frame.
    this.dof = { enabled: false, focus: 18, range: 22, maxCoC: 2.2 };
    this._dofBlend = 0;

    this.clearColor = new THREE.Color(0xb9b39a);

    this._quad = new FsQuad();
    this._meshes = [];
    this._restoreMat = [];
    this._restoreVis = [];
    this._idCounter = 0;
    this._bloomKey = '';
    this._sunSearch = 0;
    this._prevClear = new THREE.Color();

    const size = renderer.getSize(new THREE.Vector2());
    this.width = Math.max(1, size.x);
    this.height = Math.max(1, size.y);
    this.dpr = renderer.getPixelRatio();
    this.bw = Math.max(1, Math.round(this.width * this.dpr));
    this.bh = Math.max(1, Math.round(this.height * this.dpr));

    this._buildMaterials();
    this._buildTargets();
    this.setQuality(this.quality);

    // Command mode is a MAP. Valkyria Chronicles draws it as a flat illustrated
    // plate with everything legible; the round-1 build put 6.5 px of bokeh over
    // the whole valley there and it was the frame's blind-test tell. The only
    // place a focus falloff belongs is the over-the-shoulder action camera, and
    // even there it is a hairline.
    this._offPhase = Bus.on('phase:change', ({ to }) => {
      this.dof.enabled = (to === 'action');
    });
  }

  // ------------------------------------------------------------- materials
  _buildMaterials() {
    const paper = getPaperTexture();
    const grain = getGrainTexture();
    const noise = getNoiseTexture();

    this.mDown = new THREE.ShaderMaterial({
      uniforms: {
        tSrc: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uThreshold: { value: CFG.render.bloomThreshold },
        uSoftKnee: { value: 0.62 },
      },
      vertexShader: FS_VERT, fragmentShader: BLOOM_DOWN_FRAG,
      depthTest: false, depthWrite: false, name: 'vcBloomDown',
    });
    this.mPrefilter = this.mDown.clone();
    this.mPrefilter.defines = { VC_PREFILTER: '' };
    this.mPrefilter.uniforms.uThreshold = this.mDown.uniforms.uThreshold;
    this.mPrefilter.name = 'vcBloomPrefilter';

    this.mUp = new THREE.ShaderMaterial({
      uniforms: {
        tSrc: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uRadius: { value: 1 + CFG.render.bloomRadius },
      },
      vertexShader: FS_VERT, fragmentShader: BLOOM_UP_FRAG,
      depthTest: false, depthWrite: false,
      blending: THREE.AdditiveBlending, transparent: true,
      name: 'vcBloomUp',
    });

    this.mContact = new THREE.ShaderMaterial({
      uniforms: {
        tND: { value: null }, tNoise: { value: noise },
        uResolution: { value: new THREE.Vector2() },
        uFar: { value: this.camera.far },
        uTanHalfFov: { value: 0.3 },
        uAspect: { value: 1.6 },
        uSunV: { value: new THREE.Vector3(0.35, 0.6, 0.72) },
        uAoRadius: { value: 0.50 },
        uRayLength: { value: 0.42 },
        uThickness: { value: 0.30 },
      },
      vertexShader: FS_VERT, fragmentShader: CONTACT_FRAG,
      depthTest: false, depthWrite: false, name: 'vcContact',
    });

    this.mDof = new THREE.ShaderMaterial({
      uniforms: {
        tColor: { value: null }, tND: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uFar: { value: this.camera.far },
        uFocus: { value: 18 }, uRange: { value: 22 }, uMaxCoC: { value: 2.2 },
      },
      vertexShader: FS_VERT, fragmentShader: DOF_FRAG,
      depthTest: false, depthWrite: false, name: 'vcDof',
    });

    this.mComposite = new THREE.ShaderMaterial({
      uniforms: {
        tColor: { value: null }, tBloom: { value: null },
        tND: { value: null }, tMeta: { value: null },
        tGrain: { value: grain }, tNoise: { value: noise },
        tContact: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uResolution: { value: new THREE.Vector2() },
        uPixelRatio: { value: this.dpr },
        uFar: { value: this.camera.far },
        uTanHalfFov: { value: 0.3 },
        uAspect: { value: 1.6 },
        uOutlineWidth: { value: CFG.render.outlineWidth },
        uWobble: { value: CFG.render.outlineWobble },
        uBloomStrength: { value: CFG.render.bloomStrength },
        uHorizonLine: { value: 0.52 },
        uInk: { value: new THREE.Color(0x35292b) },
        uBloomTint: { value: new THREE.Color(0xffdcae) },
        uInkFadeStart: { value: 16 },
        uInkFadeEnd: { value: 78 },
        uAoStrength: { value: 0.62 },
        uContactStrength: { value: 0.70 },
        // The contact wash is skylight-only pigment, same violet the surface
        // shaders use for shade, so a boot seam and a cast shadow agree.
        uContactViolet: { value: new THREE.Color(0x6c6a86) },
        uInkFloor: { value: PALETTE.inkFloor.clone() },
        uViewToWorld: { value: new THREE.Matrix4() },
        // Warm straw-grey: the air over Gallia in the afternoon, not blue
        // distance fog. Aerial perspective in gouache lightens AND warms.
        uHazeColor: { value: new THREE.Color(0xd7cbac) },
        // Round 1 measured 0.22 haze at 60 m, which is why the village read
        // SHARPER than the 9 m hero. Air is thicker than that and it starts
        // much closer to the eye.
        uHazeDensity: { value: 0.0175 },
        uHazeStart: { value: 9 },
        uHazeRefK: { value: 0.80 },
        uHazeMax: { value: 0.70 },
        uHazeHeight: { value: 34 },
        uHazeBase: { value: 0 },
      },
      vertexShader: FS_VERT, fragmentShader: COMPOSITE_FRAG,
      depthTest: false, depthWrite: false, name: 'vcComposite',
    });

    this.mGrade = new THREE.ShaderMaterial({
      uniforms: {
        tColor: { value: null }, tPaper: { value: paper },
        uTexel: { value: new THREE.Vector2() },
        uResolution: { value: new THREE.Vector2() },
        uPixelRatio: { value: this.dpr },
        uExposure: { value: CFG.render.exposure },
        uVignette: { value: CFG.render.vignette },
        uChroma: { value: CFG.render.chroma },
        uPaperStrength: { value: CFG.render.paperStrength },
        uSaturation: { value: 1.04 },
        uContrast: { value: 0.34 },
        uTime: { value: 0 },
        uPaperWhite: { value: new THREE.Color(0xfff6e4) },
        uInkBlack: { value: PALETTE.inkFloor.clone() },
        // Warm brown-violet, R > B. The old 0xa79ec8 normalised to a
        // (1.01, 0.96, 1.21) multiplier — a 21% blue lift over everything below
        // half value, i.e. most of the frame.
        uShadowTint: { value: new THREE.Color(0xb3a5ac) },
        uHighTint: { value: new THREE.Color(0xfff0d2) },
        uVignetteTint: { value: new THREE.Color(0x8a6f63) },
      },
      vertexShader: FS_VERT, fragmentShader: GRADE_FRAG,
      depthTest: false, depthWrite: false, name: 'vcGrade',
    });
  }

  // --------------------------------------------------------------- targets
  _buildTargets() {
    this._disposeTargets();
    const w = this.bw, h = this.bh;

    // MRT G-buffer. Attachment 0: view normal (xyz) + linear depth (w, 0..1).
    // Attachment 1: object id (rg) + outline weight (b).
    this.gbuf = new THREE.WebGLRenderTarget(w, h, {
      count: 2,
      type: HALF,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    for (const t of this.gbuf.textures) { t.colorSpace = THREE.NoColorSpace; t.generateMipmaps = false; }

    this.hdr = rt(w, h, { depthBuffer: true });
    this.dofRT = rt(w, h);
    this.comp = rt(w, h);

    // Contact / AO. Half res below ultra — the term is a soft wash and the
    // bilinear upsample doubles as its blur. At ultra it runs full res so the
    // seam under a boot stays a seam.
    const aoDiv = this.quality >= 2 ? 1 : 2;
    this.aoRT = rt(Math.max(2, Math.floor(w / aoDiv)), Math.max(2, Math.floor(h / aoDiv)));

    // bloom chain
    const startDiv = this.quality <= 0 ? 4 : 2;
    const maxMips = this.quality <= 0 ? 4 : (this.quality === 1 ? 5 : 6);
    this._bloomKey = `${w}x${h}:${startDiv}:${maxMips}:${aoDiv}`;
    this.bloomMips = [];
    let bwv = Math.max(2, Math.floor(w / startDiv));
    let bhv = Math.max(2, Math.floor(h / startDiv));
    for (let i = 0; i < maxMips; i++) {
      if (bwv < 4 || bhv < 4) break;
      this.bloomMips.push(rt(bwv, bhv));
      bwv = Math.max(2, Math.floor(bwv / 2));
      bhv = Math.max(2, Math.floor(bhv / 2));
    }

    const u = this.mComposite.uniforms;
    u.uTexel.value.set(1 / w, 1 / h);
    u.uResolution.value.set(w, h);
    u.uPixelRatio.value = this.dpr;
    u.tND.value = this.gbuf.textures[0];
    u.tMeta.value = this.gbuf.textures[1];
    u.tContact.value = this.aoRT.texture;

    const k = this.mContact.uniforms;
    k.tND.value = this.gbuf.textures[0];
    k.uResolution.value.set(this.aoRT.width, this.aoRT.height);

    const g = this.mGrade.uniforms;
    g.uTexel.value.set(1 / w, 1 / h);
    g.uResolution.value.set(w, h);
    g.uPixelRatio.value = this.dpr;

    this.mDof.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.mDof.uniforms.tND.value = this.gbuf.textures[0];

    MaterialRegistry.setResolution(w, h, this.dpr);
    // publish the G-buffer so FX soft-particles can depth-fade for free
    MaterialRegistry.uniforms.uDepthTex.value = this.gbuf.textures[0];
  }

  _disposeTargets() {
    this.gbuf?.dispose();
    this.hdr?.dispose();
    this.dofRT?.dispose();
    this.comp?.dispose();
    this.aoRT?.dispose();
    if (this.bloomMips) for (const m of this.bloomMips) m.dispose();
    this.bloomMips = null;
  }

  setSize(w, h) {
    this.width = Math.max(1, w);
    this.height = Math.max(1, h);
    this.dpr = this.renderer.getPixelRatio();
    this.bw = Math.max(1, Math.round(this.width * this.dpr));
    this.bh = Math.max(1, Math.round(this.height * this.dpr));
    this._buildTargets();
  }

  /** 0 = low, 1 = high, 2 = ultra. Genuinely drops work, not just constants. */
  setQuality(level) {
    this.quality = Math.max(0, Math.min(2, level | 0));
    CFG.quality = this.quality;
    MaterialRegistry.setQuality(this.quality);

    const comp = this.mComposite;
    const grade = this.mGrade;
    const cd = {};
    const gd = {};
    if (this.quality >= 1) cd.VC_DOUBLE_STROKE = '';
    gd.VC_AA = '';
    if (this.quality >= 1) gd.VC_CA = '';
    comp.defines = cd; comp.needsUpdate = true;
    grade.defines = gd; grade.needsUpdate = true;

    // low quality trades bloom fidelity for bandwidth
    this.mUp.uniforms.uRadius.value = (1 + CFG.render.bloomRadius) * (this.quality <= 0 ? 0.8 : 1);

    // only pay for a target rebuild if the target shapes actually changed
    const startDiv = this.quality <= 0 ? 4 : 2;
    const maxMips = this.quality <= 0 ? 4 : (this.quality === 1 ? 5 : 6);
    const aoDiv = this.quality >= 2 ? 1 : 2;
    if (this._bloomKey !== `${this.bw}x${this.bh}:${startDiv}:${maxMips}:${aoDiv}`) this._buildTargets();
  }

  setFocus(distance, range) {
    this.dof.focus = distance;
    if (range !== undefined) this.dof.range = range;
  }

  /** Convenience: focus on a world point (e.g. the selected unit). */
  setFocusFromPoint(p) {
    this.camera.getWorldPosition(_v);
    this.dof.focus = _v.distanceTo(p);
  }

  setLightRig(rig) {
    this.lightRig = rig;
    // The rig fits its shadow frustum to the real view frustum; it needs the
    // camera to do that, and the pipeline is the one place that reliably has
    // both objects.
    rig?.setCamera?.(this.camera);
  }

  // ============================================================ frame

  render(dt) {
    const r = this.renderer;
    if (!this.enabled) { r.setRenderTarget(null); r.render(this.scene, this.camera); return; }

    this.time += dt;
    this.mGrade.uniforms.uTime.value = this.time;

    if (this.autoUpdateMaterials) {
      if (!this.lightRig && (this._sunSearch-- <= 0)) { this._sunSearch = 30; this._findSun(); }
      MaterialRegistry.update(dt, this.camera, this.lightRig);
    }

    const cam = this.camera;
    cam.updateMatrixWorld();
    const compU = this.mComposite.uniforms;
    const aspect = cam.aspect || (this.bw / this.bh);
    const tanH = Math.tan(THREE.MathUtils.degToRad(cam.fov || 45) * 0.5);
    compU.uFar.value = cam.far;
    compU.uAspect.value = aspect;
    compU.uTanHalfFov.value = tanH;
    compU.uViewToWorld.value.copy(cam.matrixWorld);
    this.mDof.uniforms.uFar.value = cam.far;

    // The contact pass needs the key direction in VIEW space, and the haze
    // wants to know what time of day it is — both come off the rig.
    const ku = this.mContact.uniforms;
    ku.uFar.value = cam.far;
    ku.uAspect.value = aspect;
    ku.uTanHalfFov.value = tanH;
    _m4.copy(cam.matrixWorld).invert();
    if (this.lightRig?.sunDirection) this.lightRig.sunDirection(_v);
    else if (this.lightRig?.isDirectionalLight) {
      _v.copy(this.lightRig.position).sub(this.lightRig.target.position).normalize();
    } else _v.set(0.35, 0.62, 0.70);
    ku.uSunV.value.copy(_v).transformDirection(_m4);
    this._updateHaze();

    const sm = r.shadowMap;
    const prevAutoShadow = sm.autoUpdate;
    sm.autoUpdate = false;
    sm.needsUpdate = false;

    r.getClearColor(this._prevClear);
    const prevClearAlpha = r.getClearAlpha();
    const prevToneMapping = r.toneMapping;
    r.toneMapping = THREE.NoToneMapping;

    // ---------------------------------------------------- 1. G-buffer prepass
    // The G-buffer must clear to normal=(0,0,0), depth=1 so that "no geometry"
    // is unambiguously sky. A scene background colour would clear it to garbage,
    // so it is parked for the duration of the pass.
    const prevBg = this.scene.background;
    this.scene.background = null;
    this._prepassBegin();
    r.setClearColor(0x000000, 1);
    r.setRenderTarget(this.gbuf);
    r.clear(true, true, false);
    r.render(this.scene, cam);
    this._prepassEnd();
    this.scene.background = prevBg;

    // ------------------------------------------- 2. contact shadow / occlusion
    // Reads only the G-buffer, so it runs before the colour pass and its result
    // is ready for the composite. This is what grounds a figure regardless of
    // what the shadow map can resolve.
    this._quad.draw(r, this.mContact, this.aoRT, true);

    // ---------------------------------------------------- 3. main colour pass
    sm.needsUpdate = true;                  // shadow maps refresh exactly once
    r.setClearColor(this.clearColor, 1);
    r.setRenderTarget(this.hdr);
    r.clear(true, true, false);
    r.render(this.scene, cam);
    sm.needsUpdate = false;

    // ---------------------------------------------------- 4. bloom
    this._bloom(this.hdr.texture);

    // ---------------------------------------------------- 5. composite
    compU.tColor.value = this.hdr.texture;
    compU.tBloom.value = this.bloomMips.length ? this.bloomMips[0].texture : this.hdr.texture;
    compU.uOutlineWidth.value = CFG.render.outlineWidth;
    compU.uWobble.value = CFG.render.outlineWobble;
    compU.uBloomStrength.value = CFG.render.bloomStrength;
    this._quad.draw(r, this.mComposite, this.comp, true);

    let gradeTex = this.comp.texture;

    // ---------------------------------------------------- 6. depth of field
    // AFTER the ink. Blurring the wash and leaving the graphite sharp on top of
    // it is physically impossible on paper and reads instantly as a post stack;
    // out-of-focus pencil has to go soft with the pigment it was drawn over.
    const wantDof = this.quality >= 2 && this.dof.enabled;
    this._dofBlend += ((wantDof ? 1 : 0) - this._dofBlend) * Math.min(1, dt * 4);
    if (this.quality >= 2 && this._dofBlend > 0.02) {
      const u = this.mDof.uniforms;
      u.tColor.value = gradeTex;
      u.uFocus.value = this.dof.focus;
      u.uRange.value = this.dof.range;
      u.uMaxCoC.value = this.dof.maxCoC * this._dofBlend;
      this._quad.draw(r, this.mDof, this.dofRT, true);
      gradeTex = this.dofRT.texture;
    }

    // ---------------------------------------------------- 7. grade + paper
    const gu = this.mGrade.uniforms;
    gu.tColor.value = gradeTex;
    gu.uExposure.value = CFG.render.exposure;
    gu.uVignette.value = CFG.render.vignette;
    gu.uChroma.value = CFG.render.chroma;
    gu.uPaperStrength.value = CFG.render.paperStrength;
    this._quad.draw(r, this.mGrade, null, true);

    r.setRenderTarget(null);
    r.setClearColor(this._prevClear, prevClearAlpha);
    r.toneMapping = prevToneMapping;
    sm.autoUpdate = prevAutoShadow;
  }

  /**
   * Keep the aerial-perspective colour agreeing with the sky it fades into.
   *
   * The haze is authored as a warm straw-grey — that is the Gallia afternoon,
   * and it must stay the anchor, because a haze taken straight off the light
   * colours goes cool and blue and drags the whole palette with it. What the
   * rig contributes is only the DRIFT: a lean toward the key's hue so a low
   * evening sun stains the distance, and a value scale so dusk does not haze
   * out to daylight cream.
   */
  _updateHaze() {
    const rig = this.lightRig;
    const sun = rig?.sun || (rig?.isDirectionalLight ? rig : null);
    if (!sun) return;
    const u = this.mComposite.uniforms.uHazeColor.value;
    u.copy(HAZE_BASE).lerp(sun.color, 0.28);
    const li = THREE.MathUtils.clamp((sun.intensity || 2.1) / 2.1, 0.40, 1.05);
    u.multiplyScalar(0.56 + 0.48 * li);
  }

  /** Fallback so the shading still knows where the sun is if nobody told us. */
  _findSun() {
    let found = null;
    this.scene.traverse((o) => {
      if (!found && o.isDirectionalLight && o.visible) found = o;
    });
    if (found) this.lightRig = found;
  }

  // ----------------------------------------------------------------- bloom
  _bloom(srcTex) {
    const mips = this.bloomMips;
    if (!mips || !mips.length) return;
    const r = this.renderer;

    // downsample: source -> mip0 (with threshold) -> mip1 -> ...
    this.mPrefilter.uniforms.tSrc.value = srcTex;
    this.mPrefilter.uniforms.uTexel.value.set(1 / this.bw, 1 / this.bh);
    // Our scene values are stylised, not physical: a lit surface sits around
    // 0.2 and only the sky and rim highlights pass 0.7, so the authored
    // threshold caught nothing but the sky and the bloom read as absent. Scale
    // it into the range the NPR shading actually produces so cream highlights
    // bleed the way gouache does.
    this.mPrefilter.uniforms.uThreshold.value = CFG.render.bloomThreshold * BLOOM_THRESHOLD_SCALE;
    this._quad.draw(r, this.mPrefilter, mips[0], true);

    for (let i = 1; i < mips.length; i++) {
      const src = mips[i - 1];
      this.mDown.uniforms.tSrc.value = src.texture;
      this.mDown.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
      this._quad.draw(r, this.mDown, mips[i], true);
    }

    // upsample with additive tent blending, coarse -> fine
    for (let i = mips.length - 1; i > 0; i--) {
      const src = mips[i];
      this.mUp.uniforms.tSrc.value = src.texture;
      this.mUp.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
      this._quad.draw(r, this.mUp, mips[i - 1], false);
    }
  }

  // --------------------------------------------------------------- prepass
  _prepassBegin() {
    const meshes = this._meshes;
    const restoreMat = this._restoreMat;
    const restoreVis = this._restoreVis;
    meshes.length = 0; restoreMat.length = 0; restoreVis.length = 0;

    const generic = getGenericPrepassMaterial();

    this.scene.traverseVisible((o) => {
      if (o.isPoints || o.isSprite || o.isLine) {
        o.visible = false; restoreVis.push(o);
        return;
      }
      if (!o.isMesh) return;

      const src = o.material;
      if (!src) { o.visible = false; restoreVis.push(o); return; }

      // A multi-material mesh still needs correct depth for the outline to
      // occlude properly — the generic G-buffer material covers every group.
      const multi = Array.isArray(src);
      const ud = (multi ? (src[0] && src[0].userData) : src.userData) || {};
      // A cutout material's shadow has to be cut out too. three cannot detect
      // that from a ShaderMaterial (our texture is a uniform, not `.map`), so
      // it would stamp the solid quad of every leaf card into the shadow map.
      // materials.js builds the matching depth variant; hand it to three here,
      // where we are already walking every visible mesh. This runs BEFORE the
      // prepass-eligibility test on purpose — casting a shadow and appearing in
      // the outline G-buffer are unrelated questions.
      const wantDepth = (!multi && ud.vcShadowDepth) || undefined;
      if (o.customDepthMaterial !== wantDepth &&
          (wantDepth || o.customDepthMaterial?.userData?.vcIsShadowDepth)) {
        o.customDepthMaterial = wantDepth;
      }

      const skip = ud.vcNoPrepass === true || o.userData.noPrepass === true ||
                   (!multi && src.transparent === true && !ud.vcPrepass) ||
                   (!multi && src.depthWrite === false);
      if (skip) { o.visible = false; restoreVis.push(o); return; }

      // per-object outline weight for the id buffer
      let want = o.userData.outline;
      if (want === undefined) want = ud.vcOutline;
      if (want === undefined) want = true;      // foreign meshes default to outlined
      const widthMul = o.userData.outlineWidth !== undefined
        ? o.userData.outlineWidth
        : (ud.vcOutlineWidth !== undefined ? ud.vcOutlineWidth : 1);
      o.userData.__vcMetaW = want ? Math.max(0.05, Math.min(1, widthMul * 0.5)) : 0;

      this._ensureHook(o);

      restoreMat.push(o, src);
      o.material = (!multi && ud.vcPrepass) || generic;
      meshes.push(o);
    });
  }

  _prepassEnd() {
    const rm = this._restoreMat;
    for (let i = 0; i < rm.length; i += 2) rm[i].material = rm[i + 1];
    rm.length = 0;
    const rv = this._restoreVis;
    for (let i = 0; i < rv.length; i++) rv[i].visible = true;
    rv.length = 0;
  }

  // Per-object id + line weight has to reach the shared prepass material as a
  // uniform. onBeforeRender fires immediately before setProgram for this draw,
  // and setProgram honours `uniformsNeedUpdate` per draw call, so this is a
  // correct (if unusual) way to get per-object data through a shared material.
  _ensureHook(o) {
    // Re-wrap if another system has replaced onBeforeRender since we hooked —
    // silently losing the hook would make this object inherit whatever id the
    // previously drawn mesh wrote, and the outline weights would go wrong.
    if (o.onBeforeRender === o.userData.__vcHookFn) return;

    if (o.userData.__vcIdR === undefined) {
      // `userData.vcGroupId` lets a builder declare that several meshes are ONE
      // drawn object — the eight boxes of a bridge pier, the four walls of a
      // house — so the id-break term draws no line where they meet. Without it
      // every sub-box gets its own contour and an arch reads as a stack of
      // laminated slabs. Any integer will do; equal ids share a stroke.
      const gid = o.userData.vcGroupId;
      const id = (Number.isFinite(gid) ? (gid | 0) : (++this._idCounter)) * 37 + 11;
      o.userData.__vcIdR = ((id & 255) + 1) / 256;
      o.userData.__vcIdG = (((id >> 8) & 255) + 1) / 256;
    }

    const prev = o.onBeforeRender;
    const hook = function vcMetaHook(renderer, scene, camera, geometry, material, group) {
      if (prev) prev.call(this, renderer, scene, camera, geometry, material, group);
      if (!material || !material.userData || material.userData.vcIsPrepass !== true) return;
      const um = material.uniforms.uMeta;
      if (!um) return;
      um.value.set(this.userData.__vcIdR, this.userData.__vcIdG, this.userData.__vcMetaW || 0, 1);
      material.uniformsNeedUpdate = true;
    };
    o.onBeforeRender = hook;
    o.userData.__vcHookFn = hook;
  }

  dispose() {
    this._offPhase?.();
    this._disposeTargets();
    this._quad.dispose();
    this.mDown.dispose(); this.mPrefilter.dispose(); this.mUp.dispose();
    this.mContact.dispose();
    this.mDof.dispose(); this.mComposite.dispose(); this.mGrade.dispose();
  }
}

const _v = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const HAZE_BASE = new THREE.Color(0xd7cbac);

export default CanvasRenderPipeline;
