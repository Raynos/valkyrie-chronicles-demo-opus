// src/render/lighting.js
// -----------------------------------------------------------------------------
// The light rig for the CANVAS look. Deliberately simple in count and very
// carefully tuned in colour:
//
//   sun     warm directional key. One shadow-casting light only — the NPR
//           shader bands a single light term, so a second shadowed key would
//           produce two competing sets of band edges and destroy the read.
//   hemi    cool sky over warm earth. This is what makes shade violet-blue
//           instead of black, and it is doing most of the artistic work.
//   bounce  a low, warm, upward-facing directional standing in for light kicked
//           back off the ground. Unshadowed, cheap, and it stops the undersides
//           of soldiers and vehicles from going dead.
//   ambient a whisper of warm fill so nothing is ever fully unlit.
//
// The shadow camera is a single tight ortho frustum that FOLLOWS the action
// focus point rather than trying to cover the whole map, and it is snapped to
// shadow-texel increments so the shadow edge does not crawl while the camera
// moves. At 26 m radius / 2048 px that is ~25 mm per texel — sharper than any
// cascade split would give us over a battlefield this size.
// -----------------------------------------------------------------------------

import * as THREE from 'three';
import { CFG, byQ } from '../core/config.js';
import { clamp01, lerp, damp } from '../core/math.js';

const _dir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _snap = new THREE.Vector3();
const _worldUp = new THREE.Vector3(0, 1, 0);
const _altUp = new THREE.Vector3(0, 0, 1);

// Key colour through the day. Authored sRGB; three converts to linear.
const SUN_RAMP = [
  { t: 0.00, c: 0xd98a52, i: 0.35 },   // pre-dawn ember
  { t: 0.14, c: 0xf0a768, i: 1.35 },   // low sun, long shadows
  { t: 0.34, c: 0xffdca6, i: 2.15 },
  { t: 0.50, c: 0xfff0cf, i: 2.45 },   // noon — palest, brightest
  { t: 0.68, c: 0xffd79c, i: 2.20 },
  { t: 0.86, c: 0xf2a061, i: 1.30 },   // the memoir hour
  { t: 1.00, c: 0xb96f4e, i: 0.32 },
];

const SKY_RAMP = [
  { t: 0.00, c: 0x4b5a75, i: 0.30 },
  { t: 0.16, c: 0x8fa3b4, i: 0.55 },
  { t: 0.50, c: 0xa9c0cc, i: 0.78 },
  { t: 0.84, c: 0x9fadbe, i: 0.56 },
  { t: 1.00, c: 0x4f5673, i: 0.28 },
];

const GROUND_RAMP = [
  { t: 0.00, c: 0x3d3038, i: 1 },
  { t: 0.50, c: 0x7d6a4c, i: 1 },
  { t: 1.00, c: 0x453540, i: 1 },
];

function rampColor(ramp, t, out) {
  t = clamp01(t);
  let a = ramp[0], b = ramp[ramp.length - 1];
  for (let i = 0; i < ramp.length - 1; i++) {
    if (t >= ramp[i].t && t <= ramp[i + 1].t) { a = ramp[i]; b = ramp[i + 1]; break; }
  }
  const k = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
  out.color.set(a.c).lerp(_rampTmp.set(b.c), k);
  out.intensity = lerp(a.i, b.i, k);
  return out;
}
const _rampTmp = new THREE.Color();
const _rampOut = { color: new THREE.Color(), intensity: 1 };

/**
 * @param {THREE.Scene} scene
 * @param {object} opts
 *   timeOfDay      0 dawn .. 0.5 noon .. 1 dusk         (default 0.78, late afternoon)
 *   azimuth        sun compass direction in radians     (default 0.85)
 *   maxElevation   sun height at noon, radians          (default 1.15)
 *   shadowRadius   half-size of the shadow frustum, m   (default 26)
 *   shadowDistance how far back the shadow camera sits  (default 90)
 *   followLambda   focus smoothing rate                 (default 5)
 *   exposure       global multiplier on every light     (default 1)
 * @returns {{sun, ambient, hemi, bounce, update, setTimeOfDay, setFocus, setExposure, dispose}}
 */
export function createLightRig(scene, opts = {}) {
  const o = Object.assign({
    timeOfDay: 0.78,
    azimuth: 0.85,
    maxElevation: 1.15,
    shadowRadius: 26,
    shadowDistance: 90,
    followLambda: 5,
    exposure: 1,
    castShadow: true,
  }, opts);

  const mapSize = byQ(CFG.render.shadowMapSize);

  // ---------------------------------------------------------------- key sun
  const sun = new THREE.DirectionalLight(0xffdca6, 2.2);
  sun.castShadow = o.castShadow;
  sun.shadow.mapSize.set(mapSize, mapSize);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = o.shadowDistance * 2;
  sun.shadow.camera.left = -o.shadowRadius;
  sun.shadow.camera.right = o.shadowRadius;
  sun.shadow.camera.top = o.shadowRadius;
  sun.shadow.camera.bottom = -o.shadowRadius;
  // Depth bias fights peter-panning; normal bias fights acne at grazing angles,
  // which is exactly the failure mode a large low-poly terrain produces under a
  // low sun. Scale it with the world size of one shadow texel.
  const texelWorld = (o.shadowRadius * 2) / mapSize;
  sun.shadow.bias = -0.00035;
  sun.shadow.normalBias = texelWorld * 2.4;
  sun.shadow.radius = CFG.quality >= 2 ? 3.2 : 2;
  sun.shadow.blurSamples = CFG.quality >= 2 ? 12 : 8;
  sun.shadow.camera.updateProjectionMatrix();
  scene.add(sun);
  scene.add(sun.target);

  // ------------------------------------------------------------ sky / ground
  const hemi = new THREE.HemisphereLight(0xa9c0cc, 0x7d6a4c, 0.75);
  scene.add(hemi);

  // ------------------------------------------------------------------ bounce
  // Warm earth-bounce from below-front. Never casts, never bands hard.
  const bounce = new THREE.DirectionalLight(0xd8a96e, 0.32);
  bounce.castShadow = false;
  scene.add(bounce);
  scene.add(bounce.target);

  // ----------------------------------------------------------------- ambient
  const ambient = new THREE.AmbientLight(0x6a6478, 0.22);
  scene.add(ambient);

  // ------------------------------------------------------------------ state
  const focus = new THREE.Vector3();
  const focusTarget = new THREE.Vector3();
  let tod = o.timeOfDay;
  let exposure = o.exposure;
  let azimuth = o.azimuth;
  let radius = o.shadowRadius;
  let first = true;

  function sunDirection(out) {
    // elevation follows a sine arc; the sun never quite reaches the zenith,
    // which keeps shadows long and readable across the whole battle
    const elev = Math.sin(clamp01(tod) * Math.PI) * o.maxElevation + 0.045;
    const az = azimuth + (tod - 0.5) * 1.15;          // the sun tracks across
    const ce = Math.cos(elev);
    return out.set(Math.sin(az) * ce, Math.sin(elev), Math.cos(az) * ce).normalize();
  }

  function applyTod() {
    rampColor(SUN_RAMP, tod, _rampOut);
    sun.color.copy(_rampOut.color);
    sun.intensity = _rampOut.intensity * exposure;

    rampColor(SKY_RAMP, tod, _rampOut);
    hemi.color.copy(_rampOut.color);
    hemi.intensity = _rampOut.intensity * exposure;

    rampColor(GROUND_RAMP, tod, _rampOut);
    hemi.groundColor.copy(_rampOut.color);

    // the bounce takes its colour from the ground it is bouncing off, warmed
    bounce.color.copy(hemi.groundColor).lerp(sun.color, 0.55);
    bounce.intensity = sun.intensity * 0.135;

    // twilight ambient goes violet, midday ambient goes warm straw
    const noon = 1 - Math.abs(tod - 0.5) * 2;
    ambient.color.setHex(0x6a6478).lerp(_rampTmp.setHex(0x9a8d72), noon);
    ambient.intensity = lerp(0.16, 0.26, noon) * exposure;
  }

  function placeSun(dt) {
    sunDirection(_dir);

    // Build a light-space basis and snap the frustum centre to whole shadow
    // texels along it. Without this the shadow edge boils as the focus moves.
    const upRef = Math.abs(_dir.y) > 0.94 ? _altUp : _worldUp;
    _right.copy(upRef).cross(_dir).normalize();
    _up.copy(_dir).cross(_right).normalize();

    const texel = (radius * 2) / mapSize;
    const x = Math.round(focus.dot(_right) / texel) * texel;
    const y = Math.round(focus.dot(_up) / texel) * texel;
    const z = focus.dot(_dir);
    _snap.copy(_right).multiplyScalar(x)
      .addScaledVector(_up, y)
      .addScaledVector(_dir, z);

    sun.target.position.copy(_snap);
    sun.position.copy(_snap).addScaledVector(_dir, o.shadowDistance);
    sun.target.updateMatrixWorld();
    sun.updateMatrixWorld();

    const cam = sun.shadow.camera;
    if (cam.right !== radius) {
      cam.left = -radius; cam.right = radius;
      cam.top = radius; cam.bottom = -radius;
      cam.updateProjectionMatrix();
    }

    // bounce comes from below and slightly toward the camera-facing side
    bounce.target.position.copy(focus);
    bounce.position.copy(focus)
      .addScaledVector(_dir, -14)
      .add(_tmp.set(0, -9, 0));
    bounce.target.updateMatrixWorld();
    bounce.updateMatrixWorld();
  }

  applyTod();
  placeSun(0);

  const rig = {
    sun, ambient, hemi, bounce,
    get timeOfDay() { return tod; },
    get shadowRadius() { return radius; },

    /**
     * @param {number} dt
     * @param {THREE.Vector3} [focusPoint] where the action is — the shadow
     *        frustum follows this, so keep it on the selected unit / camera aim.
     */
    update(dt, focusPoint) {
      if (focusPoint) focusTarget.copy(focusPoint);
      if (first) { focus.copy(focusTarget); first = false; }
      else {
        focus.x = damp(focus.x, focusTarget.x, o.followLambda, dt);
        focus.y = damp(focus.y, focusTarget.y, o.followLambda, dt);
        focus.z = damp(focus.z, focusTarget.z, o.followLambda, dt);
      }
      placeSun(dt);
    },

    /** 0 = dawn, 0.5 = noon, 1 = dusk. */
    setTimeOfDay(t) { tod = clamp01(t); applyTod(); placeSun(0); },

    setAzimuth(a) { azimuth = a; placeSun(0); },

    /** Tighten the shadow frustum for close combat, widen it for overview. */
    setShadowRadius(r) { radius = Math.max(6, r); },

    setFocus(p) { focusTarget.copy(p); },

    setExposure(e) { exposure = e; applyTod(); },

    /** World-space direction TOWARD the sun. */
    sunDirection(out) { return sunDirection(out || new THREE.Vector3()); },

    dispose() {
      sun.shadow.map?.dispose();
      scene.remove(sun, sun.target, hemi, bounce, bounce.target, ambient);
    },
  };

  return rig;
}
