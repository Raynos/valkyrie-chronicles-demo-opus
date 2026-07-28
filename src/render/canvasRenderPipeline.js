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
//   6. GRADE + PAPER     — line-preserving FXAA, chromatic aberration, filmic
//      tonemap to a cream white point, split-tone, saturation shaping, paper
//      fibre multiply that peaks in the midtones, paper cockle, vignette.
// -----------------------------------------------------------------------------

import * as THREE from 'three';
import { CFG } from '../core/config.js';
import { Bus } from '../core/bus.js';
import { GLSL_HASH, GLSL_NOISE, GLSL_COLOR, GLSL_TONEMAP, FS_VERT } from './shaderLib.js';
import { getPaperTexture, getGrainTexture, getNoiseTexture } from './textures.js';
import { MaterialRegistry, getGenericPrepassMaterial, PALETTE } from './materials.js';

const HALF = THREE.HalfFloatType;

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
uniform sampler2D tColor;
uniform sampler2D tBloom;
uniform sampler2D tND;
uniform sampler2D tMeta;
uniform sampler2D tGrain;
uniform sampler2D tNoise;

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

  // ---- flow-field wobble ---------------------------------------------------
  vec2 sPx = uv * uResolution;
  vec2 flow = texture2D(tNoise, sPx / 190.0).rg - 0.5;
  flow += (texture2D(tNoise, sPx / 47.0 + 0.37).gb - 0.5) * 0.42;
  vec2 wuv = uv + flow * uTexel * uWobble * 3.4;

  Gb c = sampleGb(wuv);
  float isSky = step(length(c.n), 0.4);

  vec3 P = rayAt(wuv) * (c.lz * uFar);
  vec3 N = normalize(c.n + vec3(0.0, 0.0, 1e-5));

  // ---- width: fat graphite on near silhouettes, fine line far away ---------
  float depthScale = mix(2.05, 0.62, smoothstep(0.0, 0.14, c.lz));
  float fat = uOutlineWidth * depthScale;
  float thin = uOutlineWidth * 0.72;

  vec2 oF = uTexel * fat;
  vec2 oT = uTexel * thin;

  // ---- silhouette term: depth discontinuity + object id break --------------
  float sil = 0.0;
  float skyEdge = 0.0;
  float lineW = c.w;
  {
    vec2 d1 = vec2(oF.x, oF.y);
    vec2 d2 = vec2(oF.x, -oF.y);
    Gb s1 = sampleGb(wuv + d1);
    Gb s2 = sampleGb(wuv - d1);
    Gb s3 = sampleGb(wuv + d2);
    Gb s4 = sampleGb(wuv - d2);

    float e1 = planeError(P, N, wuv + d1, s1.lz);
    float e2 = planeError(P, N, wuv - d1, s2.lz);
    float e3 = planeError(P, N, wuv + d2, s3.lz);
    float e4 = planeError(P, N, wuv - d2, s4.lz);
    float err = max(max(e1, e2), max(e3, e4));

    // tolerance grows with distance so far-away geometry does not smear
    float tol = 0.030 + c.lz * uFar * 0.0115 + fat * 0.010;
    float dEdge = smoothstep(tol, tol * 3.4, err);

    float idE = 0.0;
    idE = max(idE, step(0.006, length(s1.id - c.id)));
    idE = max(idE, step(0.006, length(s2.id - c.id)));
    idE = max(idE, step(0.006, length(s3.id - c.id)));
    idE = max(idE, step(0.006, length(s4.id - c.id)));

    // The stroke belongs to the OUTLINED object, drawn just inside its own
    // silhouette; the far side gets only a faint outer halo. Taking a plain
    // max() here would draw the full line on both sides of every boundary,
    // which is what turns grass in front of a wall into black scribble.
    float nbW = max(max(s1.w, s2.w), max(s3.w, s4.w));
    lineW = max(lineW, nbW * 0.42);

    // terrain silhouetted against the sky still wants a horizon stroke even
    // though the ground itself is not an outlined object
    float skyN = max(max(step(length(s1.n), 0.4), step(length(s2.n), 0.4)),
                     max(step(length(s3.n), 0.4), step(length(s4.n), 0.4)));
    skyEdge = skyN * (1.0 - isSky);

    sil = max(dEdge, idE * 0.92);
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
    // fade creases out with distance — an interior fold at 80 m is not drawn
    crease = smoothstep(0.62, 1.32, nd) * mix(1.0, 0.15, smoothstep(0.03, 0.28, c.lz));
  }

  float line = max(sil, crease * 0.66) * lineW * 2.0;
  line = max(line, skyEdge * uHorizonLine);
  line *= 1.0 - isSky;                     // never draw inside the sky itself

  // ---- graphite tooth ------------------------------------------------------
  float grain = texture2D(tGrain, sPx / (256.0 * uPixelRatio) * 1.35).r;
  float grainFine = texture2D(tGrain, sPx / (256.0 * uPixelRatio) * 4.1 + 0.21).b;
  line *= mix(0.52, 1.30, grain * 0.65 + grainFine * 0.35);

#ifdef VC_DOUBLE_STROKE
  // The sketch double-stroke: real VC linework has a fainter ghost line a
  // pixel or two off the main one, where the pencil was laid down twice.
  {
    vec2 dir = normalize(flow + vec2(0.31, -0.19));
    vec2 duv = wuv + dir * uTexel * (1.7 + 1.4 * grain);
    Gb g0 = sampleGb(duv);
    vec3 P2 = rayAt(duv) * (g0.lz * uFar);
    vec3 N2 = normalize(g0.n + vec3(0.0, 0.0, 1e-5));
    vec2 dd = vec2(oF.x, oF.y);
    float e = max(planeError(P2, N2, duv + dd, sampleGb(duv + dd).lz),
                  planeError(P2, N2, duv - dd, sampleGb(duv - dd).lz));
    float tol2 = 0.030 + g0.lz * uFar * 0.0115;
    float d2 = smoothstep(tol2, tol2 * 3.4, e) * g0.w * 2.0;
    line = max(line, d2 * 0.34 * mix(0.6, 1.2, grainFine));
  }
#endif

  float a = clamp(line, 0.0, 1.0);
  // Graphite over a wash is never opaque black — it takes the value of what is
  // under it, which is why a pencil line on a lit surface reads warm.
  vec3 ink = uInk * (0.55 + 0.75 * vcLum(color));
  color = mix(color, min(color, ink), a);

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
  // radial chromatic fringing, essentially absent at the centre
  vec2 ca = d * uChroma * (0.12 + r2 * 1.7);
  float rr = texture2D(tColor, uv + ca).r;
  float bb = texture2D(tColor, uv - ca).b;
  c = vec3(mix(c.r, rr, 0.85), c.g, mix(c.b, bb, 0.85));
#endif

  // ---- tonemap to a cream white point --------------------------------------
  c = vcCanvasTonemap(c, uExposure, uPaperWhite, uInkBlack);

  // ---- split tone: warm brown-violet shadows, cream highlights --------------
  // Normalise both tints to unit luminance first — a split tone must move HUE,
  // not value. Tinting by a raw dark colour would drag the shadows back below
  // the warm brown-violet floor the tonemap just established.
  float l = lumaOf(c);
  vec3 sT = uShadowTint / max(lumaOf(uShadowTint), 1e-4);
  vec3 hT = uHighTint / max(lumaOf(uHighTint), 1e-4);
  c *= mix(sT, vec3(1.0), smoothstep(0.0, 0.55, l));
  c *= mix(vec3(1.0), hT, smoothstep(0.48, 1.0, l));

  // ---- saturation shaping: greens go dusty, ochres get lifted ---------------
  {
    vec3 hsv = vcRgb2Hsv(c);
    float dg = hsv.x - 0.295;                       // ~106 deg, foliage green
    float greenness = exp(-dg * dg / 0.0072);
    float dO = hsv.x - 0.095;                       // ~34 deg, ochre / umber
    float ochreness = exp(-dO * dO / 0.0052);
    hsv.y *= 1.0 - greenness * 0.26;
    hsv.y *= 1.0 + ochreness * 0.13;
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
  float vig = 1.0 - uVignette * pow(clamp(r2 * 2.0, 0.0, 1.0), 1.25);
  vec3 vT = uVignetteTint / max(lumaOf(uVignetteTint), 1e-4);
  c *= mix(vT, vec3(1.0), vig);
  c *= mix(0.74, 1.0, vig);

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

    // depth of field — the command-mode camera turns this on
    this.dof = { enabled: false, focus: 18, range: 22, maxCoC: 6.5 };
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

    // The command phase is a considered, map-reading view — shallow depth of
    // field there and nowhere else reads as "illustration plate" rather than
    // "camera trick".
    this._offPhase = Bus.on('phase:change', ({ to }) => {
      this.dof.enabled = (to === 'command');
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

    this.mDof = new THREE.ShaderMaterial({
      uniforms: {
        tColor: { value: null }, tND: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uFar: { value: this.camera.far },
        uFocus: { value: 18 }, uRange: { value: 22 }, uMaxCoC: { value: 6.5 },
      },
      vertexShader: FS_VERT, fragmentShader: DOF_FRAG,
      depthTest: false, depthWrite: false, name: 'vcDof',
    });

    this.mComposite = new THREE.ShaderMaterial({
      uniforms: {
        tColor: { value: null }, tBloom: { value: null },
        tND: { value: null }, tMeta: { value: null },
        tGrain: { value: grain }, tNoise: { value: noise },
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
        uSaturation: { value: 0.95 },
        uTime: { value: 0 },
        uPaperWhite: { value: new THREE.Color(0xfff6e4) },
        uInkBlack: { value: PALETTE.inkFloor.clone() },
        uShadowTint: { value: new THREE.Color(0xa79ec8) },
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

    // bloom chain
    const startDiv = this.quality <= 0 ? 4 : 2;
    const maxMips = this.quality <= 0 ? 4 : (this.quality === 1 ? 5 : 6);
    this._bloomKey = `${w}x${h}:${startDiv}:${maxMips}`;
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

    // only pay for a target rebuild if the bloom chain shape actually changed
    const startDiv = this.quality <= 0 ? 4 : 2;
    const maxMips = this.quality <= 0 ? 4 : (this.quality === 1 ? 5 : 6);
    if (this._bloomKey !== `${this.bw}x${this.bh}:${startDiv}:${maxMips}`) this._buildTargets();
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

  setLightRig(rig) { this.lightRig = rig; }

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
    compU.uFar.value = cam.far;
    compU.uAspect.value = cam.aspect || (this.bw / this.bh);
    compU.uTanHalfFov.value = Math.tan(THREE.MathUtils.degToRad(cam.fov || 45) * 0.5);
    this.mDof.uniforms.uFar.value = cam.far;

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

    // ---------------------------------------------------- 2. main colour pass
    sm.needsUpdate = true;                  // shadow maps refresh exactly once
    r.setClearColor(this.clearColor, 1);
    r.setRenderTarget(this.hdr);
    r.clear(true, true, false);
    r.render(this.scene, cam);
    sm.needsUpdate = false;

    let colorTex = this.hdr.texture;

    // ---------------------------------------------------- 3. depth of field
    const wantDof = this.quality >= 2 && this.dof.enabled;
    this._dofBlend += ((wantDof ? 1 : 0) - this._dofBlend) * Math.min(1, dt * 4);
    if (this.quality >= 2 && this._dofBlend > 0.02) {
      const u = this.mDof.uniforms;
      u.tColor.value = colorTex;
      u.uFocus.value = this.dof.focus;
      u.uRange.value = this.dof.range;
      u.uMaxCoC.value = this.dof.maxCoC * this._dofBlend;
      this._quad.draw(r, this.mDof, this.dofRT, true);
      colorTex = this.dofRT.texture;
    }

    // ---------------------------------------------------- 4. bloom
    this._bloom(colorTex);

    // ---------------------------------------------------- 5. composite
    compU.tColor.value = colorTex;
    compU.tBloom.value = this.bloomMips.length ? this.bloomMips[0].texture : colorTex;
    compU.uOutlineWidth.value = CFG.render.outlineWidth;
    compU.uWobble.value = CFG.render.outlineWobble;
    compU.uBloomStrength.value = CFG.render.bloomStrength;
    this._quad.draw(r, this.mComposite, this.comp, true);

    // ---------------------------------------------------- 6. grade + paper
    const gu = this.mGrade.uniforms;
    gu.tColor.value = this.comp.texture;
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
    this.mPrefilter.uniforms.uThreshold.value = CFG.render.bloomThreshold;
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
      const id = (++this._idCounter) * 37 + 11;   // spread ids so neighbours differ
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
    this.mDof.dispose(); this.mComposite.dispose(); this.mGrade.dispose();
  }
}

const _v = new THREE.Vector3();

export default CanvasRenderPipeline;
