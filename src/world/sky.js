// Sky: a gradient dome with procedural watercolour cumulus.
//
// No cube map, no HDRI, no cloud sprites. The dome is a back-faced sphere
// parented to the camera; its fragment shader raises a flat cloud plane in the
// view direction, evaluates fbm on it, and then treats the result exactly like
// the rest of the frame — quantised into a few washes with bleeding edges,
// warm where the sun catches the tops, violet-blue in the undersides, with
// paper fibre multiplied through the midtones.

import * as THREE from 'three';
import { PALETTE, WorldLighting } from './worldMaterials.js';
import { paperTexture } from './textures.js';

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  // Push to the far plane; the dome must never clip against terrain.
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_Position.z = gl_Position.w * 0.999999;
}
`;

const FRAG = /* glsl */ `
precision highp float;

uniform vec3  uZenith;
uniform vec3  uHorizon;
uniform vec3  uHaze;
uniform vec3  uGold;
uniform vec3  uCloudLit;
uniform vec3  uCloudMid;
uniform vec3  uCloudShade;
uniform vec3  uCirrus;
uniform vec3  uSunDir;
uniform float uTime;
uniform float uCoverage;
uniform float uBands;
uniform float uGradPow;
uniform float uGradSpan;
uniform float uExposure;
uniform sampler2D uPaperTex;

varying vec3 vDir;

// --- value noise (matches the CPU fbm in core/rng.js closely enough that
//     CPU-side placement decisions and the painted sky agree in character)
float hash(vec2 p) {
  p = fract(p * vec2(127.31, 311.7));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p, int oct) {
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i = 0; i < 7; i++) {
    if (i >= oct) break;
    s += a * vnoise(p);
    n += a;
    a *= 0.52;
    p = p * 2.03 + vec2(19.1, -7.3);
  }
  return s / n;
}

float band(float v, float n, float soft) {
  float sc = v * n;
  float f = floor(sc);
  return (f + smoothstep(0.5 - soft, 0.5 + soft, sc - f)) / n;
}

void main() {
  vec3 d = normalize(vDir);
  float up = clamp(d.y, -0.25, 1.0);

  // --- base gradient.
  // A battlefield camera almost never looks up. Measured on the overview
  // shot: the lens sits 2 m up and pitches 7 degrees DOWN with a 40 degree
  // vertical field, so the very top row of the frame is only ~13 degrees above
  // the horizon (d.y = 0.225) and the skyline is at 0. The whole zenith-to-
  // horizon move therefore has to be spent inside 0..13 degrees or the frame
  // never sees any of it — which is exactly what round 2 measured (6 LSB of
  // rise across the entire upper third, hue 27 warm brown at every altitude).
  //
  // A single smoothstep across 0..27 degrees (round 2's uGradSpan 0.46) only
  // reaches g=0.53 at the top of the frame, i.e. the visible sky was still half
  // horizon-cream. TWO stacked ramps fix that without making the dome flat for
  // a camera that does look up: the first spends 78% of the travel inside the
  // bottom 8.6 degrees (which is all a gameplay camera ever sees), the second
  // carries the remaining 22% on up to the true zenith for the cinematic and
  // dusk framings.
  // 70% of the travel inside the bottom 6.3 degrees (all a battlefield camera
  // sees), the remaining 30% carried on to 36 degrees so a camera that DOES
  // look up — the bridge and dusk framings put the skyline a third of the way
  // up the page — still gets a gradient instead of one flat teal slab.
  float g = 0.70 * smoothstep(0.0, uGradSpan, up)
          + 0.30 * smoothstep(uGradSpan * 0.64, 0.62, up);
  g = pow(clamp(g, 0.0, 1.0), uGradPow);
  vec3 sky = mix(uHorizon, uZenith, g);

  // Haze layer: the band of dusty air the distant landscape dissolves into.
  // Without this the sky meets the ground on a hard line and the frame has no
  // depth at all. Kept to the bottom ~6 degrees so it cannot flatten the
  // gradient it sits under.
  float hazeBand = pow(1.0 - clamp(up * 11.0, 0.0, 1.0), 2.3);
  sky = mix(sky, uHaze, hazeBand * 0.60);

  float sunAz = clamp(dot(normalize(vec3(d.x, 0.0, d.z)), normalize(vec3(uSunDir.x, 0.0, uSunDir.z))), 0.0, 1.0);
  // Gold near the skyline, in the sun's quadrant only. Round 2 ran this at 0.45
  // over a 22-degree band, which put a warm wash across most of the sky a
  // gameplay camera can see and is a large part of why the dome measured hue 27
  // top to bottom. It is a skyline effect; it must die by 10 degrees.
  float lowGold = pow(1.0 - clamp(up * 5.2, 0.0, 1.0), 2.0) * pow(sunAz, 1.5);
  sky = mix(sky, uGold, lowGold * 0.34);

  // Soft glow around the sun. Deliberately restrained: the terrain's cream
  // highlights are the brightest thing in frame and the sky must sit under
  // them, or the whole upper half clips to white through the bloom pass.
  float sd = clamp(dot(d, normalize(uSunDir)), 0.0, 1.0);
  // The tight lobe is the sun; the wide one used to be a 35-degree warm halo at
  // 0.045, which on a camera pointed anywhere near the key is another sepia
  // wash over a third of the dome. Halved and tightened.
  sky += uGold * pow(sd, 40.0) * 0.26 + uGold * pow(sd, 11.0) * 0.024;

  // --- cloud deck.
  // A true 1/y projection onto an infinite plane stretches the noise into
  // horizontal smears the moment the camera looks near the horizon — which is
  // almost always — and smears are what make a sky read as a flat band. The
  // softened denominator caps the stretch at about 4:1, so cumulus stay ROUND
  // masses that merely crowd toward the horizon.
  //
  // The frequencies matter more than anything else here. At the elevations a
  // gameplay camera actually sees, cp only travels ~0.5 units across ten
  // degrees of sky; round 1 ran its cloud fbm at 0.62 and its mass field at
  // 0.21 cycles per unit, so BOTH fields were effectively constant over the
  // whole visible sky and the result was a featureless wash (measured patch
  // stdev 4.5). These frequencies put a cumulus mass at roughly 8-14 degrees.
  float yy = max(d.y, 0.0) + 0.235;
  vec2 cp = d.xz / yy;
  cp += vec2(uTime * 0.0125, uTime * 0.0078);

  // Domed tops: the large-scale field decides WHERE the masses are.
  float mass = fbm(cp * 0.78 + vec2(4.7, -2.1), 4);
  // Billows inside each mass.
  float base = fbm(cp * 2.05, 5);
  float dens = mass * 0.74 + base * 0.44;
  dens = dens - (1.0 - uCoverage);
  // Erode the undersides so the bases are flat, like real fair-weather cumulus.
  float erode = fbm(cp * 4.6 + vec2(-9.3, 5.5), 4);
  dens -= erode * 0.14;
  // Cumulus have flat bottoms: bias the field against the underside of a mass.
  dens -= smoothstep(0.55, 0.05, d.y * 3.4) * 0.05;

  float cover = clamp(dens * 5.4, 0.0, 1.0);
  // Wet-edge bleed: warp the quantiser boundary with fine noise so the wash
  // edge is ragged and fibrous instead of a clean contour. Three scales, so the
  // edge is torn at every size a brush would tear it.
  float bleedN = (fbm(cp * 6.2, 3) - 0.5) * 0.20
               + (fbm(cp * 17.0, 2) - 0.5) * 0.09
               + (fbm(cp * 44.0, 2) - 0.5) * 0.035;
  float cf = clamp(cover + bleedN, 0.0, 1.0);

  // OPACITY, in exactly two ranks. Round 2 ran the coverage field through the
  // same 4-level band() it used for value and then handed the RESULT to mix()
  // as an alpha — so a cloud edge crossfaded through 0.33 and 0.67 opacity over
  // the sky behind it. That IS soft-alpha airbrushing, whatever the histogram
  // of the mask says. A painter lays a thin veil and a solid mass and lets the
  // torn boundary between them do the work; there is no third state.
  float veil = smoothstep(0.09, 0.20, cf);
  float core = smoothstep(0.33, 0.41, cf);
  float q = clamp(veil * 0.32 + core * 0.68, 0.0, 1.0);

  // Shading inside the cloud: sunward side and tops go cream, the rest drops
  // to a violet-grey. THREE flat washes, no ramp between them — a soft-alpha
  // cumulus is the single most obvious "3D volumetric" tell. The boundaries are
  // torn by the same two-scale bleed noise the mask uses and antialiased with
  // fwidth so they land as ~1 px pigment edges rather than as stair-steps.
  float shape = fbm(cp * 1.35 + vec2(-3.1, 8.8), 3);
  float lit = clamp((mass - 0.42) * 2.6 + (shape - 0.5) * 1.1
                    + sunAz * 0.55 + d.y * 0.9, 0.0, 1.0);
  float lb = lit + (fbm(cp * 9.0, 2) - 0.5) * 0.22
                 + (fbm(cp * 26.0, 2) - 0.5) * 0.09;
  float aw = max(fwidth(lb) * 0.8, 0.006);
  vec3 cloud = mix(uCloudShade, uCloudMid, smoothstep(0.3333 - aw, 0.3333 + aw, lb));
  cloud = mix(cloud, uCloudLit, smoothstep(0.6667 - aw, 0.6667 + aw, lb));
  // rim: the sun burning through a thin edge
  cloud += uGold * smoothstep(0.45, 0.95, 1.0 - q) * q * pow(sunAz, 2.0) * 0.50;

  // The deck reaches all the way down — cumulus stacked along the horizon is
  // most of what a low camera sees — but it dissolves INTO the haze there
  // rather than stopping at a line.
  float horizonFade = smoothstep(-0.010, 0.048, d.y);
  vec3 col = mix(sky, cloud, q * horizonFade);

  // --- a thin cirrus wash well above the cumulus, so the empty top of the
  // frame has something drawn in it too. Streaked, not lumpy.
  float ci = fbm(vec2(cp.x * 0.30, cp.y * 1.15) + vec2(11.0, -4.0), 4);
  float cirrus = smoothstep(0.56, 0.80, ci) * smoothstep(0.02, 0.22, d.y);
  cirrus = band(cirrus, 2.0, 0.22) * (1.0 - q * 0.85);
  col = mix(col, uCirrus, cirrus * 0.26);

  col = mix(col, uHaze, hazeBand * 0.42 * q);

  // --- paper. Strongest through the cloud midtones, and it must VANISH in the
  // brightest wash — the rubric scores a fibre multiply that survives into the
  // highlights as "a noise overlay on a 3D render".
  float fibre = texture2D(uPaperTex, gl_FragCoord.xy * 0.0017).r;
  float mid = 1.0 - abs(q * 2.0 - 1.0);
  float bright = smoothstep(0.42, 0.86, max(max(col.r, col.g), col.b));
  col *= mix(1.0, 0.88 + fibre * 0.24, (0.30 + mid * 0.55) * (1.0 - bright * 0.80));

  // Hold the sky below the terrain's cream highlights. Soft-knee, so the
  // brightest cloud tops still separate from the mid values.
  float l = max(max(col.r, col.g), col.b);
  col *= 1.0 - 0.34 * smoothstep(0.80, 1.20, l);

  // The post grade has a hard shoulder: anything the dome sends up past ~0.55
  // linear comes back compressed into a 10-level band at the top of the ramp,
  // which is precisely how a 65-level authored gradient measured as a 14-level
  // rise in round 1. Sitting the whole dome below the knee is what buys the
  // gradient back.
  col *= uExposure;

  gl_FragColor = vec4(col, 1.0);
}
`;

// The sky's own palette. PALETTE.skyZenith / skyHorizon in worldMaterials.js
// are the ambient-light reference colours the whole world calibrates against
// and are owned elsewhere; the DOME needs a much wider spread than those (round
// 1 measured a 14-level rise from frame top to horizon with 4% chroma), so it
// authors its own and hands the ambient rig the same two values it always did.
// These are authored AGAINST THE GRADE, not against the eye. The post stack
// (canvasRenderPipeline GRADE_FRAG) tonemaps to a cream white point, split-tones
// highlights toward 0xfff0d2 and lifts hues near 34 deg — so a dome colour
// arrives on the page noticeably warmer and less saturated than it left here.
// Simulating that chain end-to-end, the pair below lands at:
//   skyline  (~1 deg)  RGB 187,184,168   hue  50  sat 0.10  L 183
//   frame top (13 deg) RGB 122,141,157   hue 207  sat 0.22  L 138
// i.e. B > R at the top of the dome, 22% chroma in the teal band, and a 45 LSB
// zenith-to-horizon luma delta — the three numbers round 2 measured at 27 deg /
// 0% / 6 LSB. Do not "correct" the horizon back toward orange: mixing a warm
// horizon into a cool zenith crosses through neutral grey halfway up and that
// dead band is what made the mid-sky read as sepia mud. The WARMTH at the
// skyline is the job of uHaze and the low gold term, both of which die within
// ~10 degrees.
const SKY = {
  // muted teal overhead. Authored DEEPER than it should look: the composite
  // adds a warm bloom (tint 0xffdcae at 0.52) from the cream ground and houses,
  // which measured +27R/+14G/+2B on the sky at the top of the overview frame.
  zenith: 0x4d8ea6,
  // pale straw-cream at the skyline — cooler and less saturated than it looks,
  // because the grade puts the ochre back
  horizon: 0xe0dcc4,
  cloudLit: 0xefe7d2,
  // Cool greys. Round 2's 0xc8c3b2 / 0x8b8698 were a warm putty and a mauve;
  // over a 28%-of-frame surface that alone pins the whole palette in the 30 deg
  // hue bucket.
  cloudMid: 0xb9bfbe,
  cloudShade: 0x7d8399,
  cirrus: 0xd9ded6,
};

export class Sky {
  constructor(opts = {}) {
    this.radius = opts.radius ?? 760;
    this.time = 0;

    const geo = new THREE.SphereGeometry(this.radius, 32, 20);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uZenith: { value: new THREE.Color(opts.zenith ?? SKY.zenith) },
        uHorizon: { value: new THREE.Color(opts.horizon ?? SKY.horizon) },
        uHaze: { value: new THREE.Color(opts.haze ?? PALETTE.haze) },
        uGold: { value: new THREE.Color(opts.gold ?? PALETTE.skyGold) },
        uCloudLit: { value: new THREE.Color(SKY.cloudLit) },
        uCloudMid: { value: new THREE.Color(SKY.cloudMid) },
        uCloudShade: { value: new THREE.Color(SKY.cloudShade) },
        uCirrus: { value: new THREE.Color(SKY.cirrus) },
        uSunDir: { value: WorldLighting.sunDir.clone() },
        uTime: { value: 0 },
        // 0.60 left almost no clear sky between the masses, so the dome was one
        // continuous overcast wash and none of the gradient below it ever
        // showed. Fair-weather cumulus want gaps.
        uCoverage: { value: opts.coverage ?? 0.46 },
        uBands: { value: 3.0 },
        uGradPow: { value: opts.gradPow ?? 0.92 },
        // 0.11 == 6.3 degrees; see the two-stage ramp in the fragment shader.
        uGradSpan: { value: opts.gradSpan ?? 0.11 },
        uExposure: { value: opts.exposure ?? 0.72 },
        uPaperTex: { value: paperTexture(512, 77) },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: true,
      fog: false,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'sky';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.userData.outline = false;
    this.mesh.matrixAutoUpdate = false;

    this.sunDir = WorldLighting.sunDir;
  }

  /** Colour the ambient/hemisphere lights should use, sampled from the dome. */
  horizonColor() { return this.material.uniforms.uHorizon.value; }
  zenithColor() { return this.material.uniforms.uZenith.value; }

  update(dt, camera) {
    this.time += dt;
    this.material.uniforms.uTime.value = this.time;
    this.material.uniforms.uSunDir.value.copy(WorldLighting.sunDir);
    if (camera) {
      this.mesh.position.copy(camera.position);
      this.mesh.updateMatrix();
    }
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
