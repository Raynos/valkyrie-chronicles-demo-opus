// src/render/fx.js
// -----------------------------------------------------------------------------
// Battlefield VFX, painted rather than photographed.
//
// Every system is ONE draw call: a single instanced quad (or box) whose entire
// simulation lives in the vertex shader. The CPU writes four vec4s at spawn and
// then never touches the particle again — no per-frame loops, no allocation, no
// sorting cost. Dead instances collapse to a degenerate clip position.
//
// The look rules matter as much as the plumbing:
//   * Smoke is NOT a soft photoreal puff. It is a lumpy watercolour blob whose
//     alpha is quantised into three painted lobes with a bleeding rim, shaded in
//     two bands off a fake spherical normal so it billows.
//   * Muzzle flash is a cream star hot enough (>1 in the HDR target) to blow
//     out through the bloom chain.
//   * Tracers are short warm streaks, stretched in view space along travel.
//   * Impacts spit graphite-dark debris and warm sparks that arc under gravity.
//
// Soft-particle depth fade reads the pipeline's G-buffer through the shared
// MaterialRegistry uniforms, so it costs nothing extra.
// -----------------------------------------------------------------------------

import * as THREE from 'three';
import { CFG } from '../core/config.js';
import { Bus } from '../core/bus.js';
import { GLSL_HASH, GLSL_NOISE, GLSL_COLOR, GLSL_BANDS } from './shaderLib.js';
import { getFlashTexture, getSparkTexture } from './textures.js';
import { MaterialRegistry } from './materials.js';

const FX_COMMON = GLSL_HASH + GLSL_NOISE + GLSL_COLOR + GLSL_BANDS;

// Depth fade + view helpers shared by every particle fragment shader.
const FX_DEPTH = /* glsl */`
uniform sampler2D uDepthTex;
uniform vec2 uResolution;
uniform float uFar;
uniform float uHasDepth;
float vcSoftFade(float viewZ, float range) {
  if (uHasDepth < 0.5) return 1.0;
  vec2 suv = gl_FragCoord.xy / uResolution;
  float sceneZ = texture2D(uDepthTex, suv).a * uFar;
  if (sceneZ <= 0.0001) sceneZ = uFar;
  return clamp((sceneZ - viewZ) / max(range, 0.01), 0.0, 1.0);
}
`;

// ---------------------------------------------------------------- pool base
class Pool {
  constructor(capacity) {
    this.capacity = capacity;
    this.head = 0;
    this.live = 0;
    this.dirty = false;
    this.origin = new Float32Array(capacity * 4);   // pos.xyz, birth
    this.vel = new Float32Array(capacity * 4);      // vel.xyz, life
    this.params = new Float32Array(capacity * 4);   // size0, size1, seed, spin
    this.tint = new Float32Array(capacity * 4);     // rgb, alpha
  }

  alloc() {
    const i = this.head;
    this.head = (this.head + 1) % this.capacity;
    if (this.live < this.capacity) this.live++;
    this.dirty = true;
    return i;
  }

  build(geometry) {
    const a = (arr) => {
      const at = new THREE.InstancedBufferAttribute(arr, 4);
      at.setUsage(THREE.DynamicDrawUsage);
      return at;
    };
    this.aOrigin = a(this.origin);
    this.aVel = a(this.vel);
    this.aParams = a(this.params);
    this.aTint = a(this.tint);
    geometry.setAttribute('aOrigin', this.aOrigin);
    geometry.setAttribute('aVel', this.aVel);
    geometry.setAttribute('aParams', this.aParams);
    geometry.setAttribute('aTint', this.aTint);
    geometry.instanceCount = 0;
  }

  flush(geometry) {
    if (this.dirty) {
      this.aOrigin.needsUpdate = true;
      this.aVel.needsUpdate = true;
      this.aParams.needsUpdate = true;
      this.aTint.needsUpdate = true;
      this.dirty = false;
    }
    geometry.instanceCount = this.live;
  }
}

function billboardQuad() {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
  ]), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

// A stubby brass case: an 8-sided prism with a rim, ~11 mm long.
function casingGeo() {
  const g = new THREE.InstancedBufferGeometry();
  const seg = 7, len = 0.011, r = 0.0042;
  const pos = [], nor = [], idx = [];
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    const cx = Math.cos(a), cz = Math.sin(a);
    // rim, body, taper to the mouth
    pos.push(cx * r * 1.18, -len * 0.5, cz * r * 1.18); nor.push(cx, -0.2, cz);
    pos.push(cx * r, -len * 0.28, cz * r); nor.push(cx, 0, cz);
    pos.push(cx * r * 0.94, len * 0.5, cz * r * 0.94); nor.push(cx, 0.15, cz);
  }
  for (let i = 0; i < seg; i++) {
    const a = i * 3, b = (i + 1) * 3;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
    idx.push(a + 1, b + 1, a + 2, b + 1, b + 2, a + 2);
  }
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
  g.setIndex(idx);
  return g;
}

// =============================================================== SMOKE / DUST
const SMOKE_VERT = /* glsl */`
${GLSL_HASH}
attribute vec4 aOrigin;
attribute vec4 aVel;
attribute vec4 aParams;
attribute vec4 aTint;

uniform float uTime;
uniform float uBuoyancy;
uniform float uDrag;

varying vec2 vUv;
varying float vAge;
varying float vSeed;
varying float vAlpha;
varying float vViewZ;
varying vec3 vTint;
varying float vT;

void main() {
  float age = uTime - aOrigin.w;
  float life = max(aVel.w, 1e-3);
  float t = age / life;
  if (t < 0.0 || t >= 1.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vAlpha = 0.0; vUv = vec2(0.0); vAge = 0.0; vSeed = 0.0; vViewZ = 1.0; vTint = vec3(0.0); vT = 1.0;
    return;
  }

  // analytic exponential drag + buoyant rise; no CPU integration anywhere
  float k = max(uDrag, 1e-3);
  float travel = (1.0 - exp(-k * age)) / k;
  vec3 p = aOrigin.xyz + aVel.xyz * travel;
  p.y += uBuoyancy * age * age * 0.5 * aParams.z;

  // a slow lateral curl so the column does not rise like a piston
  float sw = aParams.z * 43.7;
  p.x += sin(age * 1.35 + sw) * 0.10 * age;
  p.z += cos(age * 1.11 + sw * 1.7) * 0.10 * age;

  float size = mix(aParams.x, aParams.y, pow(t, 0.55));

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float rot = aParams.w * age + aParams.z * 6.2831;
  float cr = cos(rot), sr = sin(rot);
  vec2 q = position.xy * size;
  mv.xy += vec2(q.x * cr - q.y * sr, q.x * sr + q.y * cr);

  gl_Position = projectionMatrix * mv;
  vUv = uv;
  vAge = age;
  vSeed = aParams.z;
  vT = t;
  vViewZ = -mv.z;
  vTint = aTint.rgb;
  // fade in fast, out slow — a puff is born already opaque
  vAlpha = aTint.a * smoothstep(0.0, 0.10, t) * (1.0 - smoothstep(0.45, 1.0, t));
}
`;

const SMOKE_FRAG = /* glsl */`
${FX_COMMON}
${FX_DEPTH}
uniform vec3 uLit;
uniform vec3 uShade;
uniform vec3 uSunDirV;
uniform float uLumps;

varying vec2 vUv;
varying float vAge;
varying float vSeed;
varying float vAlpha;
varying float vViewZ;
varying vec3 vTint;
varying float vT;

void main() {
  vec2 c = vUv * 2.0 - 1.0;
  float r = length(c);
  if (r > 1.02) discard;

  // cauliflower silhouette that keeps evolving as the puff ages
  float lump = vcFbm3(c * 1.75 + vSeed * 13.0 + vAge * 0.30);
  float fine = vcFbm2(c * 4.1 + vSeed * 7.0 - vAge * 0.18);
  float edge = 0.52 + (lump - 0.5) * 0.62 * uLumps;
  float d = 1.0 - smoothstep(edge, 1.0, r);
  d *= mix(0.78, 1.12, fine);

  // Quantise the density into painted lobes — the hard-ish stepped rim is the
  // whole difference between gouache smoke and a photoreal sprite.
  vec2 q = vcQuantiseBands(clamp(d, 0.0, 1.0), 3.0, 1.6, lump, fine);
  float a = q.x * vAlpha;
  a *= vcSoftFade(vViewZ, 0.9);
  if (a < 0.008) discard;

  // fake spherical normal -> two-band volume shading
  vec3 n = normalize(vec3(c, sqrt(max(0.0, 1.0 - min(r * r, 1.0))) + 0.25));
  float ndl = dot(n, uSunDirV) * 0.5 + 0.5;
  vec2 sb = vcQuantiseBands(ndl, 3.0, 1.35, fine, lump);

  vec3 col = mix(uShade, uLit, sb.x) * vTint;
  col *= 1.0 - q.y * 0.28;                 // pigment pooled at the lobe rim
  col *= mix(1.0, 0.82, vT);               // cools and greys as it disperses

  gl_FragColor = vec4(col, a);
}
`;

// ================================================================ FLASH / GLOW
const FLASH_VERT = /* glsl */`
attribute vec4 aOrigin;
attribute vec4 aVel;
attribute vec4 aParams;
attribute vec4 aTint;
uniform float uTime;
varying vec2 vUv;
varying float vAlpha;
varying vec3 vTint;
varying float vViewZ;

void main() {
  float age = uTime - aOrigin.w;
  float life = max(aVel.w, 1e-4);
  float t = age / life;
  if (t < 0.0 || t >= 1.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vAlpha = 0.0; vUv = vec2(0.0); vTint = vec3(0.0); vViewZ = 1.0;
    return;
  }
  vec3 p = aOrigin.xyz + aVel.xyz * age;
  // a flash punches out instantly then collapses
  float size = aParams.x * (1.0 + 2.2 * t) * (1.0 - t * t);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float rot = aParams.z * 6.2831;
  float cr = cos(rot), sr = sin(rot);
  vec2 q = position.xy * size;
  mv.xy += vec2(q.x * cr - q.y * sr, q.x * sr + q.y * cr);
  gl_Position = projectionMatrix * mv;
  vUv = uv;
  vViewZ = -mv.z;
  vTint = aTint.rgb;
  vAlpha = aTint.a * pow(1.0 - t, 1.6);
}
`;

const FLASH_FRAG = /* glsl */`
${FX_DEPTH}
uniform sampler2D uMap;
varying vec2 vUv;
varying float vAlpha;
varying vec3 vTint;
varying float vViewZ;
void main() {
  vec4 tx = texture2D(uMap, vUv);
  float a = max(tx.r, max(tx.g, tx.b)) * vAlpha;
  if (a < 0.004) discard;
  // deliberately over 1.0 so the bloom chain blows it out to cream
  gl_FragColor = vec4(vTint * a * 2.6, a * vcSoftFade(vViewZ, 0.35));
}
`;

// ============================================================ TRACER / SPARK
// Both are view-space stretched quads; sparks additionally fall under gravity.
const STREAK_VERT = /* glsl */`
attribute vec4 aOrigin;
attribute vec4 aVel;
attribute vec4 aParams;
attribute vec4 aTint;
uniform float uTime;
uniform float uGravity;
varying vec2 vUv;
varying float vAlpha;
varying vec3 vTint;
varying float vViewZ;

void main() {
  float age = uTime - aOrigin.w;
  float life = max(aVel.w, 1e-4);
  float t = age / life;
  if (t < 0.0 || t >= 1.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vAlpha = 0.0; vUv = vec2(0.0); vTint = vec3(0.0); vViewZ = 1.0;
    return;
  }

  float g = uGravity * aParams.w;
  vec3 head = aOrigin.xyz + aVel.xyz * age + vec3(0.0, -0.5 * g * age * age, 0.0);
  float back = min(aParams.x, length(aVel.xyz) * min(age, 0.05));
  vec3 tail = head - normalize(aVel.xyz + vec3(0.0, -g * age, 1e-5)) * max(back, 0.02);

  vec3 hv = (modelViewMatrix * vec4(head, 1.0)).xyz;
  vec3 tv = (modelViewMatrix * vec4(tail, 1.0)).xyz;

  vec3 mid = mix(tv, hv, position.x + 0.5);
  vec2 axis = hv.xy - tv.xy;
  float al = length(axis);
  axis = al > 1e-5 ? axis / al : vec2(1.0, 0.0);
  vec2 perp = vec2(-axis.y, axis.x);
  mid.xy += perp * position.y * aParams.y * 2.0;

  gl_Position = projectionMatrix * vec4(mid, 1.0);
  vUv = vec2(position.x + 0.5, position.y + 0.5);
  vViewZ = -mid.z;
  vTint = aTint.rgb;
  vAlpha = aTint.a * (1.0 - smoothstep(0.55, 1.0, t));
}
`;

const STREAK_FRAG = /* glsl */`
${FX_DEPTH}
uniform sampler2D uMap;
varying vec2 vUv;
varying float vAlpha;
varying vec3 vTint;
varying float vViewZ;
void main() {
  vec4 tx = texture2D(uMap, vUv);
  float a = tx.r * vAlpha;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vTint * a * 2.2, a * vcSoftFade(vViewZ, 0.25));
}
`;

// =============================================================== SHELL CASING
const CASING_VERT = /* glsl */`
${GLSL_HASH}
attribute vec4 aOrigin;
attribute vec4 aVel;
attribute vec4 aParams;
attribute vec4 aTint;
uniform float uTime;
varying vec3 vN;
varying float vAlpha;
varying vec3 vTint;

mat3 axisRot(vec3 ax, float a) {
  float c = cos(a), s = sin(a), ic = 1.0 - c;
  return mat3(
    c + ax.x * ax.x * ic,        ax.x * ax.y * ic - ax.z * s, ax.x * ax.z * ic + ax.y * s,
    ax.y * ax.x * ic + ax.z * s, c + ax.y * ax.y * ic,        ax.y * ax.z * ic - ax.x * s,
    ax.z * ax.x * ic - ax.y * s, ax.z * ax.y * ic + ax.x * s, c + ax.z * ax.z * ic);
}

void main() {
  float age = uTime - aOrigin.w;
  float life = max(aVel.w, 1e-3);
  float t = age / life;
  if (t < 0.0 || t >= 1.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vAlpha = 0.0; vN = vec3(0.0, 1.0, 0.0); vTint = vec3(0.0);
    return;
  }

  float groundY = aParams.w;
  float rest = 0.0035 * max(length(vec3(aParams.x, aParams.y, aParams.z)), 1e-4);
  vec3 p = aOrigin.xyz + aVel.xyz * age + vec3(0.0, -4.905 * age * age, 0.0);

  // one damped bounce, then it lies still and stops tumbling
  float spin = age;
  if (p.y < groundY) {
    // solve for the moment it first met the ground and replay the rebound
    float vy = aVel.y;
    float disc = max(vy * vy + 2.0 * 9.81 * (aOrigin.y - groundY), 0.0);
    float tHit = (vy + sqrt(disc)) / 9.81;
    float dt2 = age - tHit;
    float vy2 = -(vy - 9.81 * tHit) * 0.32;
    float yb = groundY + vy2 * dt2 - 4.905 * dt2 * dt2;
    p.y = max(yb, groundY + rest);
    p.xz = aOrigin.xz + aVel.xz * (tHit + dt2 * 0.22);
    spin = mix(age, tHit, clamp(dt2 * 3.0, 0.0, 1.0));
  }

  // aParams.xyz is the tumble axis whose LENGTH carries the case scale, so a
  // 77 mm cannon case and a 7.9 mm rifle case share one instanced geometry.
  vec3 axRaw = vec3(aParams.x, aParams.y, aParams.z);
  float scl = max(length(axRaw), 1e-4);
  vec3 ax = axRaw / scl;
  mat3 R = axisRot(ax, spin * 22.0 / max(scl, 0.35));

  vec3 local = R * position * scl;
  vec4 mv = modelViewMatrix * vec4(p + local, 1.0);
  gl_Position = projectionMatrix * mv;
  vN = normalize(normalMatrix * (R * normal));
  vTint = aTint.rgb;
  vAlpha = aTint.a * (1.0 - smoothstep(0.75, 1.0, t));
}
`;

const CASING_FRAG = /* glsl */`
${FX_COMMON}
uniform vec3 uSunDirV;
uniform vec3 uCream;
uniform vec3 uViolet;
uniform vec3 uInkFloor;
varying vec3 vN;
varying float vAlpha;
varying vec3 vTint;
void main() {
  if (vAlpha < 0.01) discard;
  vec3 N = normalize(vN);
  float ndl = dot(N, uSunDirV) * 0.5 + 0.5;
  vec2 b = vcQuantiseBands(ndl, 3.0, 0.9, 0.4, 0.5);
  vec3 shade = vcShadowColour(vTint, uViolet, uInkFloor);
  vec3 lit = mix(vTint, uCream, 0.45) * 1.3;
  vec3 col = mix(shade, lit, b.x);
  // brass catches a hard specular glint — the one place a hot spec is allowed
  float spec = pow(clamp(dot(reflect(-uSunDirV, N), vec3(0.0, 0.0, 1.0)), 0.0, 1.0), 26.0);
  col += uCream * spec * 1.4;
  gl_FragColor = vec4(col, vAlpha);
}
`;

// ==================================================================== SYSTEM

const MAT_PRESETS = {
  stone:    { dust: 0xb9b2a2, sparks: 10, sparkCol: 0xffe0a8, smoke: 0.5 },
  concrete: { dust: 0xc4bdae, sparks: 8, sparkCol: 0xffe6b6, smoke: 0.6 },
  metal:    { dust: 0x8d8b86, sparks: 22, sparkCol: 0xfff0c8, smoke: 0.25 },
  wood:     { dust: 0x9c7748, sparks: 12, sparkCol: 0xd9a463, smoke: 0.35 },
  dirt:     { dust: 0x8a6c48, sparks: 2, sparkCol: 0xd8a86a, smoke: 0.9 },
  earth:    { dust: 0x8a6c48, sparks: 2, sparkCol: 0xd8a86a, smoke: 0.9 },
  sand:     { dust: 0xc3ac82, sparks: 0, sparkCol: 0xe8cf9e, smoke: 1.0 },
  grass:    { dust: 0x7c8551, sparks: 1, sparkCol: 0xcbbc72, smoke: 0.5 },
  water:    { dust: 0xa8bcc0, sparks: 0, sparkCol: 0xdff0f2, smoke: 0.8 },
  flesh:    { dust: 0x6d2f2c, sparks: 0, sparkCol: 0x8c3a33, smoke: 0.15 },
  default:  { dust: 0x9e9384, sparks: 6, sparkCol: 0xffdca0, smoke: 0.6 },
};

// --------------------------------------------------------------- weapon look
//
// `shot:fired` carries `{ unit, origin, dir, weapon }`, and `weapon` arrives in
// three different shapes depending on who fired:
//   * src/game/combat.js  — a WEAPONS record from game/units.js: an object with
//                           `kind`, `muzzleFlash` (0.7 .. 3.4), `tracer`,
//                           `backblast`.
//   * src/physics/ballistics.js — a bare profile NAME ('rifle', 'tankAP', ...).
//   * src/actors/tank.js  — the ballistics name it was told to fire.
// `_weaponFx()` normalises all three, so a caller can always just forward the
// payload's `weapon` straight through.
const MUZZLE_KIND = {
  rifle:   { scale: 1.00, gas: 3, sparks: 5,  dirty: 0.00, case: 1.0,  bore: 0.045 },
  smg:     { scale: 0.85, gas: 2, sparks: 4,  dirty: 0.00, case: 0.85, bore: 0.038 },
  mg:      { scale: 0.95, gas: 3, sparks: 6,  dirty: 0.05, case: 1.0,  bore: 0.045 },
  pistol:  { scale: 0.80, gas: 2, sparks: 3,  dirty: 0.00, case: 0.8,  bore: 0.036 },
  sniper:  { scale: 1.15, gas: 3, sparks: 4,  dirty: 0.05, case: 1.1,  bore: 0.048 },
  lance:   { scale: 2.20, gas: 6, sparks: 9,  dirty: 0.55, case: 0,    bore: 0.16, backblast: 1 },
  cannon:  { scale: 3.20, gas: 9, sparks: 14, dirty: 1.00, case: 7.0,  bore: 0.20 },
  flame:   { scale: 0.55, gas: 5, sparks: 2,  dirty: 0.25, case: 0,    bore: 0.09 },
  thrown:  { scale: 0,    gas: 0, sparks: 0,  dirty: 0,    case: 0,    bore: 0 },
  tool:    { scale: 0,    gas: 0, sparks: 0,  dirty: 0,    case: 0,    bore: 0 },
};

// ballistics profile name -> the kind whose muzzle behaviour it shares
const WEAPON_ALIAS = {
  tankAP: 'cannon', tankHE: 'cannon', mortar: 'cannon', coax: 'mg',
  grenade: 'thrown', throw: 'thrown', toolkit: 'tool',
};

export class FxSystem {
  /**
   * @param {THREE.Scene} scene
   * @param {object} [opts] { smoke, flash, streak, casing } pool capacities
   */
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.time = 0;
    this.enabled = true;
    this.rng = Math.random;      // gameplay jitter may be non-deterministic

    const lowQ = CFG.quality <= 0;
    const cap = Object.assign({
      smoke: lowQ ? 220 : 512,
      flash: 48,
      streak: lowQ ? 256 : 640,
      casing: lowQ ? 48 : 112,
    }, opts);

    const shared = MaterialRegistry.uniforms;
    this._shared = shared;

    const depthU = () => ({
      uDepthTex: shared.uDepthTex,
      uResolution: shared.uResolution,
      uFar: shared.uFar,
      uHasDepth: { value: 0 },
    });
    this._hasDepthUniforms = [];

    // ------------------------------------------------------------- smoke
    this.smokePool = new Pool(cap.smoke);
    const smokeGeo = billboardQuad();
    this.smokePool.build(smokeGeo);
    const smokeU = Object.assign({
      uTime: { value: 0 },
      uBuoyancy: { value: 1.15 },
      uDrag: { value: 1.35 },
      uLit: { value: new THREE.Color(0xf6ead2) },
      uShade: { value: new THREE.Color(0x6b6070) },
      uSunDirV: shared.uSunDirV,
      uLumps: { value: 1 },
    }, depthU());
    this.smokeMat = new THREE.ShaderMaterial({
      uniforms: smokeU,
      vertexShader: SMOKE_VERT,
      fragmentShader: SMOKE_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      name: 'vcSmoke',
    });
    this._hasDepthUniforms.push(smokeU.uHasDepth);
    this.smokeMesh = this._mesh(smokeGeo, this.smokeMat, 12);

    // ------------------------------------------------------------- flash
    this.flashPool = new Pool(cap.flash);
    const flashGeo = billboardQuad();
    this.flashPool.build(flashGeo);
    const flashU = Object.assign({
      uTime: { value: 0 },
      uMap: { value: getFlashTexture() },
    }, depthU());
    this.flashMat = new THREE.ShaderMaterial({
      uniforms: flashU,
      vertexShader: FLASH_VERT,
      fragmentShader: FLASH_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      name: 'vcFlash',
    });
    this._hasDepthUniforms.push(flashU.uHasDepth);
    this.flashMesh = this._mesh(flashGeo, this.flashMat, 14);

    // ----------------------------------------------------- tracers/sparks
    this.streakPool = new Pool(cap.streak);
    const streakGeo = billboardQuad();
    this.streakPool.build(streakGeo);
    const streakU = Object.assign({
      uTime: { value: 0 },
      uGravity: { value: 9.81 },
      uMap: { value: getSparkTexture() },
    }, depthU());
    this.streakMat = new THREE.ShaderMaterial({
      uniforms: streakU,
      vertexShader: STREAK_VERT,
      fragmentShader: STREAK_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      name: 'vcStreak',
    });
    this._hasDepthUniforms.push(streakU.uHasDepth);
    this.streakMesh = this._mesh(streakGeo, this.streakMat, 13);

    // ------------------------------------------------------------ casings
    this.casingPool = new Pool(cap.casing);
    const cGeo = casingGeo();
    this.casingPool.build(cGeo);
    this.casingMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uSunDirV: shared.uSunDirV,
        uCream: shared.uCream,
        uViolet: shared.uViolet,
        uInkFloor: shared.uInkFloor,
      },
      vertexShader: CASING_VERT,
      fragmentShader: CASING_FRAG,
      transparent: true,
      depthWrite: true,
      side: THREE.DoubleSide,
      name: 'vcCasing',
    });
    this.casingMesh = this._mesh(cGeo, this.casingMat, 11);

    this._pools = [
      [this.smokePool, smokeGeo], [this.flashPool, flashGeo],
      [this.streakPool, streakGeo], [this.casingPool, cGeo],
    ];
    this._times = [smokeU.uTime, flashU.uTime, streakU.uTime, this.casingMat.uniforms.uTime];

    // Fire-and-forget wiring: anything that emits these events gets VFX free.
    this._off = [
      Bus.on('shot:hit', (p) => { if (p && p.point) this.impact(p.point, p.normal, p.material); }),
      Bus.on('explosion', (p) => { if (p && p.pos) this.explosion(p.pos, p.radius || 3); }),
    ];
  }

  _mesh(geo, mat, order) {
    mat.userData.vcNoPrepass = true;
    mat.userData.vcOutline = false;
    const m = new THREE.Mesh(geo, mat);
    m.frustumCulled = false;
    m.renderOrder = order;
    m.userData.outline = false;
    m.userData.noPrepass = true;
    this.scene.add(m);
    return m;
  }

  // ------------------------------------------------------------- spawn util
  _write(pool, i, px, py, pz, vx, vy, vz, life, s0, s1, p2, p3, cr, cg, cb, alpha) {
    const o = i * 4;
    pool.origin[o] = px; pool.origin[o + 1] = py; pool.origin[o + 2] = pz; pool.origin[o + 3] = this.time;
    pool.vel[o] = vx; pool.vel[o + 1] = vy; pool.vel[o + 2] = vz; pool.vel[o + 3] = life;
    pool.params[o] = s0; pool.params[o + 1] = s1; pool.params[o + 2] = p2; pool.params[o + 3] = p3;
    pool.tint[o] = cr; pool.tint[o + 1] = cg; pool.tint[o + 2] = cb; pool.tint[o + 3] = alpha;
  }

  _rand(a, b) { return a + this.rng() * (b - a); }

  /**
   * Normalise whatever `shot:fired.weapon` happens to be into a muzzle profile.
   * Accepts a WEAPONS record, a ballistics profile name, a bare scale, or null.
   * @returns {{scale:number, gas:number, sparks:number, dirty:number,
   *            case:number, bore:number, backblast:number}}
   */
  _weaponFx(weapon) {
    if (weapon == null) return MUZZLE_KIND.rifle;
    if (typeof weapon === 'number') {
      return Object.assign({}, MUZZLE_KIND.rifle, { scale: weapon });
    }
    if (typeof weapon === 'string') {
      const key = WEAPON_ALIAS[weapon] || weapon;
      return MUZZLE_KIND[key] || MUZZLE_KIND.rifle;
    }
    const kind = WEAPON_ALIAS[weapon.kind] || weapon.kind ||
      WEAPON_ALIAS[weapon.weapon] || weapon.weapon;
    const base = MUZZLE_KIND[kind] || MUZZLE_KIND.rifle;
    // The weapon tables already publish an authored flash scale — honour it,
    // including `0`, which is how a thrown grenade or a repair kit says "none".
    const scale = weapon.muzzleFlash != null ? weapon.muzzleFlash : base.scale;
    const back = weapon.backblast ? 1 : (base.backblast || 0);
    // The common case is an authored record that agrees with its kind — return
    // the shared profile so a burst of automatic fire allocates nothing.
    if (scale === base.scale && back === (base.backblast || 0)) return base;
    let cache = this._wfx || (this._wfx = new WeakMap());
    let hit = cache.get(weapon);
    if (!hit || hit.scale !== scale || hit.backblast !== back) {
      hit = Object.assign({}, base, { scale, backblast: back });
      cache.set(weapon, hit);
    }
    return hit;
  }

  /**
   * Build an orthonormal frame around a firing direction.
   * Writes right into `_r0` and up into `_r1`; returns nothing.
   */
  _frame(d) {
    _r0.set(0, 1, 0);
    if (Math.abs(d.y) > 0.94) _r0.set(1, 0, 0);
    _r0.crossVectors(d, _r0).normalize();
    _r1.crossVectors(_r0, d).normalize();
  }

  // ============================================================== public API

  /**
   * Bright cream star at the muzzle plus a lick of propellant smoke.
   *
   * Designed to be wired straight off the canonical event:
   *   Bus.on('shot:fired', (p) => fx.muzzleFlash(p.origin, p.dir, p.weapon));
   *
   * @param {THREE.Vector3} pos   muzzle point (payload `origin`)
   * @param {THREE.Vector3} dir   firing direction, need not be normalised
   * @param {object|string|number} [weapon] payload `weapon`; a WEAPONS record,
   *   a ballistics profile name, or a bare scale. Scale 0 draws nothing.
   */
  muzzleFlash(pos, dir, weapon) {
    if (!this.enabled) return;
    const W = this._weaponFx(weapon);
    const s = W.scale;
    if (!(s > 0)) return;                 // thrown / tool / repair: no muzzle
    const d = _v0.copy(dir || _up).normalize();
    const bore = W.bore;

    const i = this.flashPool.alloc();
    _c0.set(0xfff4d8);
    this._write(this.flashPool, i,
      pos.x + d.x * bore, pos.y + d.y * bore, pos.z + d.z * bore,
      d.x * 1.2 * s, d.y * 1.2 * s, d.z * 1.2 * s,
      this._rand(0.055, 0.085) * (1 + 0.5 * (s - 1)),
      this._rand(0.26, 0.40) * s, 0, this.rng(), 0,
      _c0.r, _c0.g, _c0.b, 1);

    // A second, smaller, hotter core. It is pure white at 2.6x in the fragment
    // shader — comfortably over the 0.72 bloom threshold, so the centre always
    // blows out to cream through the bloom chain instead of reading as a decal.
    const j = this.flashPool.alloc();
    _c0.set(0xffffff);
    this._write(this.flashPool, j,
      pos.x + d.x * bore * 1.8, pos.y + d.y * bore * 1.8, pos.z + d.z * bore * 1.8,
      d.x * 2.0 * s, d.y * 2.0 * s, d.z * 2.0 * s,
      0.05, this._rand(0.10, 0.16) * s, 0, this.rng(), 0,
      _c0.r, _c0.g, _c0.b, 1);

    // propellant gas: pale, fast, gone in under a second
    _c0.set(0xd8d2c4);
    const gas = CFG.quality <= 0 ? Math.max(1, W.gas >> 1) : W.gas;
    for (let k = 0; k < gas; k++) {
      const g = this.smokePool.alloc();
      const sp = (1.6 + this.rng() * 2.4) * (0.7 + 0.5 * s);
      this._write(this.smokePool, g,
        pos.x + d.x * bore * 2.4, pos.y + d.y * bore * 2.4, pos.z + d.z * bore * 2.4,
        d.x * sp + this._rand(-0.5, 0.5), d.y * sp + this._rand(-0.2, 0.6), d.z * sp + this._rand(-0.5, 0.5),
        this._rand(0.55, 0.95) * (1 + 0.4 * (s - 1)),
        0.10 * s, this._rand(0.55, 0.85) * s, this.rng(), this._rand(-2.5, 2.5),
        _c0.r, _c0.g, _c0.b, 0.42);
    }

    // A heavy gun kicks a dirty ochre ring sideways off the muzzle brake — the
    // detail that separates an 88 from a rifle at a glance.
    if (W.dirty > 0.01 && CFG.quality > 0) {
      this._frame(d);
      _c0.set(0x8f7a5c);
      const ring = Math.round(6 * W.dirty);
      for (let k = 0; k < ring; k++) {
        const a = (k / ring) * Math.PI * 2 + this._rand(-0.3, 0.3);
        const ca = Math.cos(a), sa = Math.sin(a);
        const sp = this._rand(1.6, 4.2) * s * W.dirty;
        const g = this.smokePool.alloc();
        this._write(this.smokePool, g,
          pos.x + d.x * bore, pos.y + d.y * bore, pos.z + d.z * bore,
          (_r0.x * ca + _r1.x * sa) * sp + d.x * sp * 0.35,
          (_r0.y * ca + _r1.y * sa) * sp + d.y * sp * 0.35,
          (_r0.z * ca + _r1.z * sa) * sp + d.z * sp * 0.35,
          this._rand(1.1, 2.0),
          0.12 * s, this._rand(0.6, 1.1) * s, this.rng(), this._rand(-1.4, 1.4),
          _c0.r, _c0.g, _c0.b, 0.5 * W.dirty + 0.16);
      }
    }

    // A lance vents its whole propellant charge out the back. Without this a
    // fired lance reads as a rifle with a big flash.
    if (W.backblast) {
      _v3.copy(d).multiplyScalar(-1);
      _c0.set(0xcfc6b4);
      for (let k = 0; k < (CFG.quality <= 0 ? 3 : 6); k++) {
        const sp = this._rand(3.0, 7.5);
        const g = this.smokePool.alloc();
        this._write(this.smokePool, g,
          pos.x + _v3.x * 0.3, pos.y + _v3.y * 0.3, pos.z + _v3.z * 0.3,
          _v3.x * sp + this._rand(-0.9, 0.9), _v3.y * sp + this._rand(-0.4, 0.9), _v3.z * sp + this._rand(-0.9, 0.9),
          this._rand(0.7, 1.3),
          0.14, this._rand(0.8, 1.5), this.rng(), this._rand(-2, 2),
          _c0.r, _c0.g, _c0.b, 0.5);
      }
      const bf = this.flashPool.alloc();
      _c0.set(0xffe9bc);
      this._write(this.flashPool, bf,
        pos.x + _v3.x * 0.22, pos.y + _v3.y * 0.22, pos.z + _v3.z * 0.22,
        _v3.x * 1.6, _v3.y * 1.6, _v3.z * 1.6,
        0.07, this._rand(0.22, 0.34), 0, this.rng(), 0,
        _c0.r, _c0.g, _c0.b, 0.85);
    }

    // muzzle sparks
    const sp = CFG.quality <= 0 ? Math.max(2, W.sparks >> 1) : W.sparks;
    for (let k = 0; k < sp; k++) {
      this._spark(pos, d, 5.5 * (0.8 + 0.3 * s), 0xffe3ae, 0.22, 0.9);
    }
  }

  /**
   * Surface hit. `material` is a key from MAT_PRESETS ('stone', 'metal',
   * 'wood', 'dirt', 'flesh', 'water', ...) — unknown keys fall back sensibly.
   */
  impact(pos, normal, material) {
    if (!this.enabled) return;
    const n = _v0.copy(normal || _up).normalize();
    const key = (material || 'default');
    const p = MAT_PRESETS[key] || MAT_PRESETS.default;

    if (key === 'flesh') { this.bloodMist(pos, n); return; }

    _c0.set(p.dust);
    const puffs = CFG.quality <= 0 ? 3 : 5;
    for (let k = 0; k < puffs; k++) {
      const s = this.smokePool.alloc();
      const sp = this._rand(0.5, 2.3) * p.smoke;
      this._write(this.smokePool, s,
        pos.x + n.x * 0.04, pos.y + n.y * 0.04, pos.z + n.z * 0.04,
        n.x * sp + this._rand(-0.8, 0.8), n.y * sp + this._rand(-0.2, 1.0), n.z * sp + this._rand(-0.8, 0.8),
        this._rand(0.7, 1.5),
        this._rand(0.07, 0.14), this._rand(0.35, 0.75), this.rng(), this._rand(-2, 2),
        _c0.r, _c0.g, _c0.b, 0.55 * p.smoke + 0.18);
    }

    const nSparks = CFG.quality <= 0 ? (p.sparks >> 1) : p.sparks;
    for (let k = 0; k < nSparks; k++) {
      this._spark(pos, n, 6.5, p.sparkCol, 0.30, 1.0);
    }

    // a single bright pinprick at the moment of contact
    if (p.sparks > 4) {
      const f = this.flashPool.alloc();
      _c0.set(p.sparkCol);
      this._write(this.flashPool, f, pos.x, pos.y, pos.z, 0, 0, 0,
        0.045, this._rand(0.10, 0.18), 0, this.rng(), 0,
        _c0.r, _c0.g, _c0.b, 0.9);
    }
  }

  /** Big one: flash, fireball, boiling smoke column, dust ring, debris. */
  explosion(pos, radius = 3) {
    if (!this.enabled) return;
    const R = Math.max(0.6, radius);

    // flash core
    const f = this.flashPool.alloc();
    _c0.set(0xfff2cc);
    this._write(this.flashPool, f, pos.x, pos.y + R * 0.2, pos.z, 0, 0.6, 0,
      0.16, R * 0.75, 0, this.rng(), 0, _c0.r, _c0.g, _c0.b, 1);

    // fireball: hot ochre puffs that live briefly
    _c0.set(0xffb45c);
    const fireCount = CFG.quality <= 0 ? 5 : 9;
    for (let k = 0; k < fireCount; k++) {
      const s = this.smokePool.alloc();
      const a = this.rng() * Math.PI * 2, e = this._rand(-0.25, 0.95);
      const sp = this._rand(1.5, 5.0) * (R * 0.35);
      this._write(this.smokePool, s,
        pos.x, pos.y + R * 0.18, pos.z,
        Math.cos(a) * sp, e * sp + 1.4, Math.sin(a) * sp,
        this._rand(0.35, 0.65),
        R * 0.22, R * 0.62, this.rng(), this._rand(-3, 3),
        _c0.r * 2.2, _c0.g * 1.5, _c0.b * 0.7, 0.95);
    }

    // the smoke column that follows it up
    _c0.set(0x584f4c);
    const smokeCount = CFG.quality <= 0 ? 7 : 14;
    for (let k = 0; k < smokeCount; k++) {
      const s = this.smokePool.alloc();
      const a = this.rng() * Math.PI * 2, e = this._rand(-0.15, 1.15);
      const sp = this._rand(0.8, 3.4) * (R * 0.30);
      this._write(this.smokePool, s,
        pos.x + this._rand(-R, R) * 0.25, pos.y + R * 0.25, pos.z + this._rand(-R, R) * 0.25,
        Math.cos(a) * sp, e * sp + 0.9, Math.sin(a) * sp,
        this._rand(1.8, 3.6),
        R * 0.28, R * 1.35, this.rng(), this._rand(-1.6, 1.6),
        _c0.r, _c0.g, _c0.b, 0.72);
    }

    // ground dust ring, thrown outward and low
    _c0.set(0x9c8663);
    const ringCount = CFG.quality <= 0 ? 6 : 12;
    for (let k = 0; k < ringCount; k++) {
      const s = this.smokePool.alloc();
      const a = (k / ringCount) * Math.PI * 2 + this._rand(-0.2, 0.2);
      const sp = this._rand(3.0, 6.5) * (R * 0.3);
      this._write(this.smokePool, s,
        pos.x, pos.y + 0.15, pos.z,
        Math.cos(a) * sp, this._rand(0.1, 0.7), Math.sin(a) * sp,
        this._rand(1.4, 2.6),
        R * 0.18, R * 0.85, this.rng(), this._rand(-1, 1),
        _c0.r, _c0.g, _c0.b, 0.55);
    }

    // debris
    const debris = CFG.quality <= 0 ? 10 : 26;
    for (let k = 0; k < debris; k++) {
      const a = this.rng() * Math.PI * 2, e = this._rand(0.1, 1.2);
      _v1.set(Math.cos(a), e, Math.sin(a)).normalize();
      this._spark(pos, _v1, this._rand(6, 17), k % 3 === 0 ? 0x4a3b33 : 0xffcf86,
        this._rand(0.4, 1.5), 1.0);
    }
    // NOTE: no `sfx` emission here. FxSystem is a *subscriber* of `explosion`,
    // and the systems that emit `explosion` (physics/explosions.js,
    // game/combat.js, world/props.js) already emit the matching `sfx`. Emitting
    // one here too fired every blast twice.
  }

  /** A single drifting puff — engine exhaust, cover smoke, dust in the wind. */
  smokePuff(pos, vel, opts = {}) {
    if (!this.enabled) return;
    const v = vel || _v1.set(0, 0.6, 0);
    const s = this.smokePool.alloc();
    _c0.set(opts.color !== undefined ? opts.color : 0x9d968c);
    this._write(this.smokePool, s,
      pos.x, pos.y, pos.z,
      v.x, v.y, v.z,
      opts.life !== undefined ? opts.life : this._rand(1.6, 3.0),
      opts.size !== undefined ? opts.size : this._rand(0.25, 0.45),
      opts.endSize !== undefined ? opts.endSize : this._rand(1.1, 2.0),
      this.rng(), this._rand(-1.2, 1.2),
      _c0.r, _c0.g, _c0.b, opts.alpha !== undefined ? opts.alpha : 0.55);
  }

  /**
   * A short warm streak that flies from -> to. Fire-and-forget: the whole
   * flight is integrated in the vertex shader, so this is called ONCE per shot,
   * not once per frame. Use it for hitscan weapons, where `to` is the impact
   * point resolved by combat.js.
   *
   * @param {THREE.Vector3} from muzzle point
   * @param {THREE.Vector3} to   impact point
   * @param {number|{speed?:number, weapon?:*, color?:number, width?:number,
   *                 alpha?:number, life?:number}} [opts] a bare number is read
   *   as `speed` (metres/second, default 340) for backward compatibility.
   */
  tracer(from, to, opts = 340) {
    if (!this.enabled) return;
    const o = typeof opts === 'number' ? ((_tracerOpt.speed = opts), _tracerOpt) : opts;
    _v0.copy(to).sub(from);
    const dist = _v0.length();
    if (dist < 1e-3) return;
    _v0.multiplyScalar(1 / dist);

    const W = o.weapon !== undefined ? this._weaponFx(o.weapon) : null;
    const heft = W ? Math.max(0.7, Math.min(2.4, W.scale)) : 1;
    const speed = o.speed || 340;
    const life = o.life || Math.max(0.02, dist / speed);

    const i = this.streakPool.alloc();
    _c0.set(o.color !== undefined ? o.color : 0xffd89a);
    this._write(this.streakPool, i,
      from.x, from.y, from.z,
      _v0.x * speed, _v0.y * speed, _v0.z * speed,
      life,
      // length, half-width, seed, gravity scale
      Math.min(3.2 * heft, dist * 0.35), (o.width !== undefined ? o.width : 0.035) * heft,
      this.rng(), 0,
      _c0.r, _c0.g, _c0.b, o.alpha !== undefined ? o.alpha : 1);
  }

  /**
   * One frame's worth of an in-flight projectile's trail.
   *
   * A ballistic round follows a drag + gravity curve, so the single straight
   * `tracer()` streak cannot represent a lance or a mortar honestly. Call this
   * once per frame per live projectile, passing the segment it covered this
   * frame — consecutive stamps tile head-to-tail into a continuous dash that
   * follows the true path:
   *
   *   for (const p of ballistics.projectiles) {
   *     if (p.tracer > 0) fx.tracerSegment(p.prev, p.renderPos, dt,
   *                                        { weapon: p.weapon, alpha: p.tracer });
   *   }
   *
   * @param {THREE.Vector3} from segment start (projectile.prev)
   * @param {THREE.Vector3} to   segment end   (projectile.renderPos)
   * @param {number} dt          seconds the segment covered
   * @param {object} [opts] { weapon, color, width, alpha, length }
   */
  tracerSegment(from, to, dt, opts = {}) {
    if (!this.enabled) return;
    const life = Math.max(1 / 240, dt || 1 / 60);
    _v0.copy(to).sub(from);
    const seg = _v0.length();
    if (seg < 1e-4) return;
    const inv = 1 / life;

    const W = opts.weapon !== undefined ? this._weaponFx(opts.weapon) : null;
    const heft = W ? Math.max(0.7, Math.min(2.4, W.scale)) : 1;

    const i = this.streakPool.alloc();
    _c0.set(opts.color !== undefined ? opts.color : 0xffd89a);
    this._write(this.streakPool, i,
      from.x, from.y, from.z,
      _v0.x * inv, _v0.y * inv, _v0.z * inv,
      // Outlive the frame slightly so the dashes overlap rather than strobe.
      life * 1.35,
      opts.length !== undefined ? opts.length : Math.min(3.2 * heft, seg * 1.15),
      (opts.width !== undefined ? opts.width : 0.032) * heft,
      this.rng(), 0,
      _c0.r, _c0.g, _c0.b, opts.alpha !== undefined ? opts.alpha : 1);
  }

  /** Boots, landing, a tank track biting — low brown dust close to the ground. */
  dustKick(pos, strength = 1) {
    if (!this.enabled) return;
    _c0.set(0x8f7551);
    const n = CFG.quality <= 0 ? 2 : 4;
    for (let k = 0; k < n; k++) {
      const s = this.smokePool.alloc();
      const a = this.rng() * Math.PI * 2;
      const sp = this._rand(0.3, 1.1) * strength;
      this._write(this.smokePool, s,
        pos.x + this._rand(-0.12, 0.12), pos.y + 0.04, pos.z + this._rand(-0.12, 0.12),
        Math.cos(a) * sp, this._rand(0.25, 0.8) * strength, Math.sin(a) * sp,
        this._rand(0.9, 1.7),
        this._rand(0.10, 0.18), this._rand(0.42, 0.80) * strength, this.rng(), this._rand(-1.5, 1.5),
        _c0.r, _c0.g, _c0.b, 0.38);
    }
  }

  /** Carmine spray, deliberately restrained — this is a memoir, not a splatter. */
  bloodMist(pos, dir) {
    if (!this.enabled) return;
    const d = _v0.copy(dir || _up).normalize();
    _c0.set(0x74231f);
    const n = CFG.quality <= 0 ? 3 : 6;
    for (let k = 0; k < n; k++) {
      const s = this.smokePool.alloc();
      const sp = this._rand(1.0, 3.2);
      this._write(this.smokePool, s,
        pos.x, pos.y, pos.z,
        d.x * sp + this._rand(-0.7, 0.7), d.y * sp + this._rand(-0.3, 0.7), d.z * sp + this._rand(-0.7, 0.7),
        this._rand(0.35, 0.65),
        this._rand(0.045, 0.09), this._rand(0.16, 0.30), this.rng(), this._rand(-3, 3),
        _c0.r, _c0.g, _c0.b, 0.85);
    }
    // a few heavy droplets that fall
    for (let k = 0; k < 4; k++) {
      this._spark(pos, d, 3.4, 0x5c1a17, 0.16, 1.0, 0.055);
    }
  }

  /**
   * Ejected brass. Tumbles, bounces once, settles.
   *
   * Takes the FIRING direction rather than an ejection velocity, because that
   * is what a `shot:fired {unit, origin, dir, weapon}` payload actually carries;
   * the case is thrown up and to the shooter's right off that frame:
   *
   *   Bus.on('shot:fired', (p) => fx.shellCasing(p.origin, p.dir, {
   *     weapon: p.weapon, groundY: world.terrain.heightAt(p.origin.x, p.origin.z),
   *   }));
   *
   * @param {THREE.Vector3} pos   ejection point (the muzzle point is close enough)
   * @param {THREE.Vector3} dir   firing direction
   * @param {object|number} [opts] `{ weapon, groundY, scale, vel }`, or a bare
   *   number read as `groundY`. `vel` overrides the derived ejection velocity.
   */
  shellCasing(pos, dir, opts) {
    if (!this.enabled) return;
    const o = typeof opts === 'number' ? ((_caseOpt.groundY = opts), _caseOpt)
      : (opts || _caseOptEmpty);
    const W = o.weapon !== undefined ? this._weaponFx(o.weapon) : MUZZLE_KIND.rifle;
    const scale = o.scale !== undefined ? o.scale : W.case;
    if (!(scale > 0)) return;             // lances and thrown weapons eject nothing

    const d = _v0.copy(dir || _forward).normalize();
    this._frame(d);                       // _r0 = right, _r1 = up

    // Brass leaves up and to the right, with a little forward carry. Heavier
    // cases leave slower relative to their size, so a cannon case tips out
    // rather than flicking away.
    const k = 1 / Math.sqrt(Math.max(1, scale));
    _v2.set(0, 0, 0)
      .addScaledVector(_r0, this._rand(1.9, 2.9) * k)
      .addScaledVector(_r1, this._rand(1.3, 2.1) * k)
      .addScaledVector(d, this._rand(-0.15, 0.45) * k);
    const v = o.vel || _v2;

    const i = this.casingPool.alloc();
    _c0.set(0xc79a4e);
    const gy = o.groundY !== undefined ? o.groundY : pos.y - 1.35;
    // aParams.xyz is a tumble axis whose LENGTH the shader reads as the case
    // scale, so it must be a unit vector times `scale` — never a raw random.
    _v1.set(this._rand(-1, 1), this._rand(-1, 1), this._rand(-1, 1));
    if (_v1.lengthSq() < 1e-6) _v1.set(0, 1, 0);
    _v1.normalize().multiplyScalar(scale);
    this._write(this.casingPool, i,
      pos.x + _r0.x * 0.06, pos.y + _r0.y * 0.06, pos.z + _r0.z * 0.06,
      v.x, v.y, v.z,
      this._rand(3.5, 5.5),
      _v1.x, _v1.y, _v1.z, gy,
      _c0.r, _c0.g, _c0.b, 1);
  }

  // ------------------------------------------------------------------ spark
  // Uses its own scratch vectors: callers routinely pass `_v0`/`_v1` in as
  // `dir`, so this must never write through the vector it was handed.
  _spark(pos, dir, speed, color, life, gravityScale, width) {
    const i = this.streakPool.alloc();
    _s0.set(this._rand(-0.55, 0.55), this._rand(-0.35, 0.55), this._rand(-0.55, 0.55))
      .add(dir);
    if (_s0.lengthSq() < 1e-8) _s0.copy(_up);
    _s0.normalize().multiplyScalar(speed * this._rand(0.45, 1.25));
    _c0.set(color);
    this._write(this.streakPool, i,
      pos.x, pos.y, pos.z,
      _s0.x, _s0.y, _s0.z,
      life * this._rand(0.7, 1.4),
      0.6, width !== undefined ? width : 0.016, this.rng(), gravityScale,
      _c0.r, _c0.g, _c0.b, 1);
  }

  // ----------------------------------------------------------------- update
  update(dt) {
    this.time += dt;
    for (const u of this._times) u.value = this.time;

    // depth-fade only once the pipeline has published a G-buffer
    const has = this._shared.uDepthTex.value ? 1 : 0;
    for (const u of this._hasDepthUniforms) u.value = has;

    for (const [pool, geo] of this._pools) pool.flush(geo);
  }

  clear() {
    for (const [pool, geo] of this._pools) {
      pool.origin.fill(0); pool.vel.fill(0);
      pool.head = 0; pool.live = 0; pool.dirty = true;
      pool.flush(geo);
    }
  }

  dispose() {
    for (const off of this._off) off();
    for (const m of [this.smokeMesh, this.flashMesh, this.streakMesh, this.casingMesh]) {
      this.scene.remove(m);
      m.geometry.dispose();
      m.material.dispose();
    }
  }
}

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _r0 = new THREE.Vector3();   // frame right
const _r1 = new THREE.Vector3();   // frame up
const _s0 = new THREE.Vector3();   // _spark only — never aliased by a caller
const _up = new THREE.Vector3(0, 1, 0);
const _forward = new THREE.Vector3(0, 0, -1);
const _c0 = new THREE.Color();

// Reusable option records so the number-shorthand overloads allocate nothing.
const _tracerOpt = { speed: 340 };
const _caseOpt = { groundY: 0 };
const _caseOptEmpty = {};

export default FxSystem;
