// src/render/lighting.js
// -----------------------------------------------------------------------------
// The light rig for the CANVAS look. Deliberately simple in count and very
// carefully tuned in colour:
//
//   sun     warm directional key. THE ONLY DirectionalLight in the scene, and
//           the only shadow caster. src/world/worldMaterials.js recovers
//           `N·L * shadow` by dividing three's Lambert accumulation by the key
//           light's luminance, which is arithmetic that is only true with one
//           directional source; a second one silently doubles the recovered
//           term and shifts every band edge. It is named 'sun' so
//           src/world/world.js adopts it instead of adding its own.
//   hemi    cool sky over warm earth. This is what makes shade violet-blue
//           instead of black, and it is doing most of the artistic work. Named
//           'worldFill' for the same adopt-don't-stack handshake.
//   bounce  warm light kicked back off the ground. A HEMISPHERE light with a
//           black sky and a warm ground, i.e. pure up-facing fill — deliberately
//           NOT a directional, because hemisphere lights land in
//           `indirectDiffuse` and so leave the key-light recovery intact.
//   ambient a whisper of warm fill so nothing is ever fully unlit.
//
// The shadow camera is a single ortho frustum FITTED TO THE VIEW FRUSTUM — both
// its extent and its centre — every frame (see `fitShadow`), because one fixed
// box cannot serve both a camera 3 m behind a soldier and a command camera 45 m
// up looking across 130 m of valley: sized for the first it clips every distant
// shadow away, sized for the second it wastes 90% of its texels on ground the
// player cannot see. The fitted radius is quantised to a coarse ladder so it
// does not resize every frame, and the frustum centre is snapped to whole
// shadow texels so the shadow edge does not crawl while the camera moves.
// The action focus is now only a HINT for how much depth is worth covering; it
// is deliberately NOT the box centre any more, because centring on a selected
// unit the camera is not looking at is what blew the box out to 78 m and
// dissolved every character-scale shadow in round 1.
//
// Depth biasing is deliberately NOT a cranked constant. `uShadowTexel` is
// published to materials.js, which offsets the shadow lookup along the surface
// normal by one texel times tan(acos(N·L)) — the depth a surface climbs across
// one texel. three's own constant `normalBias` is left at a small value purely
// as a safety net for any foreign material that does not use our vertex stage.
// -----------------------------------------------------------------------------

import * as THREE from 'three';
import { CFG, byQ } from '../core/config.js';
import { clamp01, lerp, damp } from '../core/math.js';
import { MaterialRegistry } from './materials.js';

const _dir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _snap = new THREE.Vector3();
const _worldUp = new THREE.Vector3(0, 1, 0);
const _altUp = new THREE.Vector3(0, 0, 1);
const _camPos = new THREE.Vector3();
const _camFwd = new THREE.Vector3();

// The fitted shadow radius snaps to this ladder. A frustum radius that slid
// continuously would resize the ortho box — and therefore the texel grid — on
// every frame, and the shadow edge would boil no matter how well it is snapped.
//
// The low rungs are close together on purpose. An over-the-shoulder camera fits
// at 14 m, which at a 4096 map is 6.8 mm per texel — fine enough that a boot
// sole (0.28 m) is 41 texels across and throws a readable contact shadow. The
// old ladder started at 12 but the frustum was centred on the ACTION FOCUS
// rather than on the view, so a hero the camera was not looking at dragged the
// fit to the top rung (78 m, 38 mm/texel) and every character-scale shadow
// dissolved. See fitShadow().
const FIT_STEPS = [9, 12, 16, 21, 27, 35, 45, 58, 74, 94];

// Key colour through the day. Authored sRGB; three converts to linear.
// Deliberately less saturated than a physical sun. The NPR shader normalises
// the key colour to unit luminance before tinting, so a strongly saturated
// orange arrives at the surface as a ~2x red multiplier and stains everything.
const SUN_RAMP = [
  { t: 0.00, c: 0xd7a483, i: 0.35 },   // pre-dawn ember
  { t: 0.14, c: 0xf0c093, i: 1.35 },   // low sun, long shadows
  { t: 0.34, c: 0xffe2bd, i: 2.10 },
  { t: 0.50, c: 0xfff3dd, i: 2.40 },   // noon — palest, brightest
  { t: 0.68, c: 0xffe1b9, i: 2.15 },
  { t: 0.86, c: 0xf6c295, i: 1.32 },   // the memoir hour
  { t: 1.00, c: 0xc0906f, i: 0.32 },
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
 *   shadowRadius   half-size of the shadow frustum, m   (default 26) — only
 *                  used until setCamera() supplies a camera to fit to
 *   shadowDistance how far back the shadow camera sits  (default 90)
 *   shadowFar      furthest the frustum fit will reach  (default 132) — the
 *                  distance past which the world simply stops casting
 *   followLambda   focus smoothing rate                 (default 5)
 *   exposure       global multiplier on every light     (default 1)
 * @returns {{sun, ambient, hemi, bounce, update, setTimeOfDay, setCamera,
 *            setShadowRadius, setFocus, setExposure, dispose}}
 */
export function createLightRig(scene, opts = {}) {
  const o = Object.assign({
    timeOfDay: 0.78,
    azimuth: 0.85,
    maxElevation: 1.15,
    shadowRadius: 26,
    shadowDistance: 90,
    shadowFar: 132,
    followLambda: 5,
    exposure: 1,
    castShadow: true,
  }, opts);

  const mapSize = byQ(CFG.render.shadowMapSize);

  // ---------------------------------------------------------------- key sun
  // The handshake with src/world/world.js is by NAME and runs both ways: whichever
  // of the two is constructed first owns the object, the second one adopts and
  // reconfigures it. Exactly one DirectionalLight ends up in the scene in either
  // wiring order, which is the arithmetic the NPR shading depends on.
  const existingSun = scene.getObjectByName('sun');
  const sun = existingSun && existingSun.isDirectionalLight
    ? existingSun
    : new THREE.DirectionalLight(0xffdca6, 2.2);
  sun.name = 'sun';
  sun.castShadow = o.castShadow;
  sun.shadow.mapSize.set(mapSize, mapSize);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = o.shadowDistance * 2;
  sun.shadow.camera.left = -o.shadowRadius;
  sun.shadow.camera.right = o.shadowRadius;
  sun.shadow.camera.top = o.shadowRadius;
  sun.shadow.camera.bottom = -o.shadowRadius;
  // PCF radius in TEXELS (three r185 samples a 5-point Vogel disk of this radius,
  // rotated per pixel by interleaved-gradient noise). Anything above ~1.2 stops
  // being a penumbra and becomes a dithered gradient two bands wide, which is
  // the "Gaussian-blurred grey-green blob" the critique named as the loudest
  // 3D-renderer tell in the tank frame. At 1.0 the five taps overlap into plain
  // hardware bilinear PCF: a one-texel transition, i.e. a painted edge that the
  // band bleed in worldMaterials.js can then break up irregularly.
  sun.shadow.radius = CFG.quality >= 2 ? 1.0 : 0.9;
  sun.shadow.blurSamples = CFG.quality >= 2 ? 6 : 4;
  sun.shadow.camera.updateProjectionMatrix();
  if (!existingSun) { scene.add(sun); scene.add(sun.target); }

  // ------------------------------------------------------------ sky / ground
  const existingFill = scene.getObjectByName('worldFill');
  const hemi = existingFill && existingFill.isHemisphereLight
    ? existingFill
    : new THREE.HemisphereLight(0xa9c0cc, 0x7d6a4c, 0.75);
  hemi.name = 'worldFill';             // src/world/world.js adopts this by name
  if (!existingFill) scene.add(hemi);

  // ------------------------------------------------------------------ bounce
  // Warm earth-bounce, arriving from BELOW. Modelled as a hemisphere light with
  // a black sky so it only lifts downward-facing surfaces — the undersides of
  // helmets, chins, hulls and the shadowed side of a soldier's legs — without
  // adding a second directional term for the NPR shader to band.
  const existingBounce = scene.getObjectByName('bounceFill');
  const bounce = existingBounce && existingBounce.isHemisphereLight
    ? existingBounce
    : new THREE.HemisphereLight(0x000000, 0xd8a96e, 0.32);
  bounce.name = 'bounceFill';
  bounce.color.setHex(0x000000);       // sky half stays dark: this is fill FROM BELOW
  if (!existingBounce) scene.add(bounce);

  // ----------------------------------------------------------------- ambient
  const existingAmb = scene.getObjectByName('worldAmbient');
  const ambient = existingAmb && existingAmb.isAmbientLight
    ? existingAmb
    : new THREE.AmbientLight(0x6a6478, 0.22);
  ambient.name = 'worldAmbient';
  if (!existingAmb) scene.add(ambient);

  // ------------------------------------------------------------------ state
  const focus = new THREE.Vector3();
  const focusTarget = new THREE.Vector3();
  let tod = o.timeOfDay;
  let exposure = o.exposure;
  let azimuth = o.azimuth;
  let radius = 0;
  let viewCamera = null;
  let first = true;

  /**
   * Re-derive everything that depends on the ortho half-extent: the projection,
   * the depth bias, and the world texel size the surface shaders turn into a
   * normal-offset. Doing this in ONE place is the whole point — the previous
   * split (ortho here, bias in main.js) is how the bias silently went stale
   * whenever the frustum was widened, and a stale bias on a 108 m frustum is
   * striped acne across the entire terrain.
   */
  function applyRadius(r) {
    if (r === radius) return;
    radius = r;
    const cam = sun.shadow.camera;
    cam.left = -r; cam.right = r;
    cam.top = r; cam.bottom = -r;
    // Depth range tracks the box. Everything visible is inside a sphere of
    // radius r about the centre; the slack past that is for casters just off
    // screen on the sun side, and for anything tall enough to lean into frame.
    cam.near = Math.max(0.5, o.shadowDistance - r * 1.5 - 24);
    cam.far = o.shadowDistance + r * 1.5 + 14;
    cam.updateProjectionMatrix();

    const texel = (r * 2) / mapSize;
    // Published to materials.js, which scales it by tan(acos(N·L)) per fragment.
    MaterialRegistry.uniforms.uShadowTexel.value = texel;
    // A small constant depth bias on top of the normal offset, expressed in the
    // shadow camera's [0,1] depth range so it means a fixed number of METRES
    // (~1.5 texels) rather than an arbitrary number that changes meaning when
    // the frustum does.
    const depthRange = Math.max(1, cam.far - cam.near);
    sun.shadow.bias = -Math.min(0.0016, (texel * 1.5 + 0.006) / depthRange);
    // Safety net for foreign materials that still use three's own vertex stage.
    sun.shadow.normalBias = texel * 1.6;
  }

  /**
   * Fit the ortho box to WHAT THE CAMERA CAN SEE, and centre it there.
   *
   * The previous version fitted a radius but kept the box centred on the action
   * focus, which is whatever unit the battle has selected. A camera framing a
   * tank while the selected unit stands 47 m off to the side therefore had to
   * open the box to 78 m to reach both — 38 mm per texel — and every
   * character-scale shadow (a boot, a track link, a helmet) fell below the
   * filter's resolution and vanished. That is the whole reason two critics
   * independently reported "the hero casts no shadow whatsoever".
   *
   * So: take the standard cascaded-shadow-map bounding SPHERE of the view
   * frustum truncated at `shadowFar`, centre the box on the sphere, and use its
   * radius. The sphere is rotation-invariant, so panning the camera cannot make
   * the box breathe — only moving it can, and the ladder + texel snap absorb
   * that. Writes `_snap` with the (un-snapped) centre; returns the radius.
   */
  function fitShadow() {
    const cam = viewCamera;
    if (!cam || !cam.isPerspectiveCamera) {
      _snap.copy(focus);
      return Math.max(radius || o.shadowRadius, 6);
    }

    _camPos.setFromMatrixPosition(cam.matrixWorld);
    _camFwd.set(0, 0, -1).applyQuaternion(cam.quaternion);

    // How much depth is worth shadowing. Measured off the CAMERA — its height
    // above the plane the action sits on, and how steeply it is looking down at
    // that plane — never off the distance to the selected unit. That last
    // dependency is what let a unit standing 40 m off screen open the box to
    // 78 m and take every character shadow with it.
    const h = Math.max(0.8, _camPos.y - focus.y);
    const pitch = -_camFwd.y;
    // A level camera sees to the horizon but only ever needs shadows over the
    // near ground, so cap it by eye height rather than letting it diverge.
    let look = pitch > 0.06 ? h / pitch : 1e9;
    look = Math.min(look, h * 4.5 + 18);
    look = THREE.MathUtils.clamp(look, 7, 150);
    const far = THREE.MathUtils.clamp(look * 1.6 + 11, 22, o.shadowFar);
    const near = Math.max(0.1, cam.near);

    // Tight bounding sphere of a truncated perspective frustum (the usual CSM
    // fit). k is the radius of the far cap divided by its distance.
    const tanH = Math.tan(THREE.MathUtils.degToRad(cam.fov) * 0.5);
    const aspect = cam.aspect || 1.7778;
    const k2 = tanH * tanH * (1 + aspect * aspect);
    let cz, r;
    if (k2 * (far + near) >= far - near) {
      cz = far;
      r = far * Math.sqrt(k2);
    } else {
      cz = 0.5 * (far + near) * (1 + k2);
      r = 0.5 * Math.sqrt(
        (far - near) * (far - near) +
        2 * (far * far + near * near) * k2 +
        (far + near) * (far + near) * k2 * k2);
    }
    _snap.copy(_camPos).addScaledVector(_camFwd, cz);

    // Quantise up to the ladder so the box (and therefore the texel grid) is
    // stable across small camera moves.
    for (let i = 0; i < FIT_STEPS.length; i++) if (r <= FIT_STEPS[i]) return FIT_STEPS[i];
    return FIT_STEPS[FIT_STEPS.length - 1];
  }

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

    // the bounce takes its colour from the ground it is bouncing off, warmed.
    // `groundColor` is the up-facing (from below) half of a hemisphere light.
    bounce.groundColor.copy(hemi.groundColor).lerp(sun.color, 0.55);
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
    // This basis must MATCH the one three derives from `light.up` in lookAt(),
    // or the snap lands between texels and does nothing.
    const upRef = Math.abs(_dir.y) > 0.94 ? _altUp : _worldUp;
    _right.copy(upRef).cross(_dir).normalize();
    _up.copy(_dir).cross(_right).normalize();

    // fitShadow() writes the un-snapped centre into _snap and returns the radius.
    applyRadius(fitShadow());

    const texel = (radius * 2) / mapSize;
    const x = Math.round(_snap.dot(_right) / texel) * texel;
    const y = Math.round(_snap.dot(_up) / texel) * texel;
    const z = _snap.dot(_dir);
    _snap.copy(_right).multiplyScalar(x)
      .addScaledVector(_up, y)
      .addScaledVector(_dir, z);

    sun.target.position.copy(_snap);
    sun.position.copy(_snap).addScaledVector(_dir, o.shadowDistance);
    sun.target.updateMatrixWorld();
    sun.updateMatrixWorld();

    // Re-assert every frame. main.js pokes `sun.shadow.normalBias` directly on
    // its own ladder, and applyRadius() early-outs when the radius has not
    // changed, so a bias derived from a frustum we no longer use would stick.
    sun.shadow.normalBias = texel * 1.6;
    // `bounce` is a hemisphere light: it has no position or direction to place.
  }

  applyTod();
  applyRadius(o.shadowRadius);
  placeSun(0);

  const rig = {
    sun, ambient, hemi, bounce,
    get timeOfDay() { return tod; },
    get shadowRadius() { return radius; },

    /**
     * @param {number} dt
     * @param {THREE.Vector3} [focusPoint] where the action is. Only its HEIGHT
     *        and rough distance are used, to decide how much depth the shadow
     *        box should cover; the box itself is centred on the view frustum.
     * @param {THREE.PerspectiveCamera} [camera] optional; supplying it here is
     *        equivalent to calling setCamera() once.
     */
    update(dt, focusPoint, camera) {
      if (camera) viewCamera = camera;
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

    /**
     * Give the rig the view camera. Once it has one, the shadow frustum is
     * fitted to that camera's real frustum every frame and `setShadowRadius`
     * becomes advisory. `canvasRenderPipeline.setLightRig` wires this up.
     */
    setCamera(cam) { viewCamera = cam || null; },

    /**
     * Manual override, used only until a view camera is supplied. Re-derives
     * the bias and the published texel size, so it can never leave them stale.
     */
    setShadowRadius(r) { if (!viewCamera) applyRadius(Math.max(6, r)); },

    setFocus(p) { focusTarget.copy(p); },

    setExposure(e) { exposure = e; applyTod(); },

    /** World-space direction TOWARD the sun. */
    sunDirection(out) { return sunDirection(out || new THREE.Vector3()); },

    dispose() {
      sun.shadow.map?.dispose();
      scene.remove(sun, sun.target, hemi, bounce, ambient);
    },
  };

  return rig;
}
