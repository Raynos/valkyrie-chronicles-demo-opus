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
uniform vec3  uSunDir;
uniform float uTime;
uniform float uCoverage;
uniform float uBands;
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
  // A battlefield camera almost never looks up: the visible sky is the bottom
  // 20-30 degrees. So the gradient is compressed into that band — pale warm
  // haze sitting ON the horizon, muted teal-grey by ~25 degrees, a deeper
  // slate-teal overhead that only the command camera ever sees.
  float g = pow(clamp(up, 0.0, 1.0), 0.42);
  vec3 sky = mix(uHorizon, uZenith, g);

  // Haze layer: the band of dusty air the distant landscape dissolves into.
  // Without this the sky meets the ground on a hard line and the frame has no
  // depth at all.
  float hazeBand = pow(1.0 - clamp(up * 7.5, 0.0, 1.0), 2.1);
  sky = mix(sky, uHaze, hazeBand * 0.72);

  float sunAz = clamp(dot(normalize(vec3(d.x, 0.0, d.z)), normalize(vec3(uSunDir.x, 0.0, uSunDir.z))), 0.0, 1.0);
  float lowGold = pow(1.0 - clamp(up * 2.6, 0.0, 1.0), 2.0) * pow(sunAz, 1.5);
  sky = mix(sky, uGold, lowGold * 0.55);

  // Soft glow around the sun. Deliberately restrained: the terrain's cream
  // highlights are the brightest thing in frame and the sky must sit under
  // them, or the whole upper half clips to white through the bloom pass.
  float sd = clamp(dot(d, normalize(uSunDir)), 0.0, 1.0);
  sky += uGold * pow(sd, 40.0) * 0.30 + uGold * pow(sd, 6.0) * 0.055;

  // --- cloud deck.
  // A true 1/y projection onto an infinite plane stretches the noise into
  // horizontal smears the moment the camera looks near the horizon — which is
  // almost always — and smears are what make a sky read as a flat band. The
  // softened denominator caps the stretch at about 4:1, so cumulus stay ROUND
  // masses that merely crowd toward the horizon.
  float yy = max(d.y, 0.0) + 0.235;
  vec2 cp = d.xz / yy * 1.05;
  vec2 drift = vec2(uTime * 0.0042, uTime * 0.0026);
  cp += drift * 4.0;

  float base = fbm(cp * 0.62, 5);
  // Domed tops: a second, larger-scale field pushes whole cloud masses up.
  float mass = fbm(cp * 0.21 + vec2(4.7, -2.1), 4);
  float dens = base * 0.62 + mass * 0.60;
  dens = dens - (1.0 - uCoverage);
  // Erode the undersides so the bases are flat, like real fair-weather cumulus.
  float erode = fbm(cp * 1.9 + vec2(-9.3, 5.5), 4);
  dens -= erode * 0.16;

  float cover = clamp(dens * 4.6, 0.0, 1.0);
  // Wet-edge bleed: warp the quantiser boundary with fine noise so the wash
  // edge is ragged and fibrous instead of a clean contour. Two scales, so the
  // edge is torn at the centimetre AND at the metre.
  float bleedN = (fbm(cp * 4.6, 3) - 0.5) * 0.15 + (fbm(cp * 13.0, 2) - 0.5) * 0.06;
  float q = band(clamp(cover + bleedN, 0.0, 1.0), uBands, 0.24);

  // Shading inside the cloud: sunward side and tops go cream, the rest drops
  // to a violet-grey. The mass field stands in for height within the body.
  float lit = clamp(mass * 2.1 - 0.42 + sunAz * 0.30, 0.0, 1.0);
  float litQ = band(lit, 3.0, 0.20);
  vec3 cloud = mix(uCloudShade, uCloudMid, smoothstep(0.12, 0.55, litQ));
  cloud = mix(cloud, uCloudLit, smoothstep(0.5, 0.95, litQ));
  // rim: the sun burning through a thin edge
  cloud += uGold * smoothstep(0.55, 0.97, 1.0 - q) * q * pow(sunAz, 2.0) * 0.45;

  // The deck reaches all the way down — cumulus stacked along the horizon is
  // most of what a low camera sees — but it dissolves INTO the haze there
  // rather than stopping at a line.
  float horizonFade = smoothstep(-0.005, 0.075, d.y);
  vec3 col = mix(sky, cloud, q * horizonFade);
  col = mix(col, uHaze, hazeBand * 0.42 * q);

  // --- paper. Weak in the bright sky, strongest through the cloud midtones.
  float fibre = texture2D(uPaperTex, gl_FragCoord.xy * 0.0017).r;
  float mid = 1.0 - abs(q * 2.0 - 1.0);
  col *= mix(1.0, 0.88 + fibre * 0.24, 0.55 + mid * 0.45);

  // Hold the sky below the terrain's cream highlights. Soft-knee, so the
  // brightest cloud tops still separate from the mid values.
  float l = max(max(col.r, col.g), col.b);
  col *= 1.0 - 0.42 * smoothstep(0.72, 1.15, l);

  gl_FragColor = vec4(col, 1.0);
}
`;

export class Sky {
  constructor(opts = {}) {
    this.radius = opts.radius ?? 760;
    this.time = 0;

    const geo = new THREE.SphereGeometry(this.radius, 32, 20);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uZenith: { value: new THREE.Color(opts.zenith ?? PALETTE.skyZenith) },
        uHorizon: { value: new THREE.Color(opts.horizon ?? PALETTE.skyHorizon) },
        uHaze: { value: new THREE.Color(opts.haze ?? PALETTE.haze) },
        uGold: { value: new THREE.Color(opts.gold ?? PALETTE.skyGold) },
        uCloudLit: { value: new THREE.Color(0xe4dac2) },
        uCloudMid: { value: new THREE.Color(0xb9b5ac) },
        uCloudShade: { value: new THREE.Color(0x827f92) },
        uSunDir: { value: WorldLighting.sunDir.clone() },
        uTime: { value: 0 },
        uCoverage: { value: opts.coverage ?? 0.56 },
        uBands: { value: 3.0 },
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
