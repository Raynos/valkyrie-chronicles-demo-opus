// The river surface — a stylised watercolour water shader.
//
// The mesh is a ribbon lofted along the river spline and deliberately built
// WIDER than the carved channel, so its edges bury themselves inside the banks.
// That means the visible shoreline is defined by the terrain's noisy carve
// rather than by the water geometry, and it wanders exactly the way the ground
// does — no polygon edge ever shows.
//
// Per-vertex we bake the depth of water (surface minus riverbed) and the flow
// tangent. Depth drives colour, transparency and the foam line; the tangent
// drives the direction the distortion scrolls, so the water reads as *moving
// downstream* rather than as a generic animated normal map.

import * as THREE from 'three';
import { WATER_Y } from './layout.js';
import { flowNoiseTexture, paperTexture } from './textures.js';
import { PALETTE, WorldLighting } from './worldMaterials.js';
import { bridgeSpanLayout } from './structures.js';
import { clamp01 } from '../core/math.js';

const VERT = /* glsl */ `
attribute float aDepth;
attribute vec2  aFlow;
attribute float aArc;
attribute float aObstacle;

uniform float uTime;

varying float vDepth;
varying vec2  vFlow;
varying float vArc;
varying float vObst;
varying vec2  vAcross;
varying vec3  vWorld;
varying vec3  vView;

void main() {
  vec3 p = position;
  // Two travelling swells plus a fine chop; amplitude dies in the shallows so
  // the waterline stays glued to the bank.
  float amp = smoothstep(0.0, 0.55, aDepth);
  float s1 = sin(aArc * 0.55 - uTime * 1.35 + p.x * 0.11);
  float s2 = sin(aArc * 1.35 + uTime * 2.05 - p.z * 0.19);
  float s3 = sin(aArc * 3.1 - uTime * 3.4 + p.x * 0.5 + p.z * 0.37);
  p.y += (s1 * 0.045 + s2 * 0.026 + s3 * 0.011) * amp;

  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorld = wp.xyz;
  vDepth = aDepth;
  vFlow = aFlow;
  vArc = aArc;
  vObst = aObstacle;
  vAcross = vec2(uv.x, uv.y);
  vec4 mv = viewMatrix * wp;
  vView = -mv.xyz;
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
precision highp float;

uniform sampler2D uFlowTex;
uniform sampler2D uPaperTex;
uniform float uTime;
uniform vec3  uShallow;
uniform vec3  uDeep;
uniform vec3  uFoam;
uniform vec3  uBed;
uniform vec3  uHaze;
uniform float uFogDensity;
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform vec3  uSkyColor;
uniform float uBands;

varying float vDepth;
varying vec2  vFlow;
varying float vArc;
varying float vObst;
varying vec2  vAcross;
varying vec3  vWorld;
varying vec3  vView;

float band(float v, float n, float soft) {
  float sc = v * n;
  float f = floor(sc);
  return (f + smoothstep(0.5 - soft, 0.5 + soft, sc - f)) / n;
}

void main() {
  // Flow-aligned UVs: u runs downstream, v runs across the channel.
  vec2 flowUV = vec2(vArc * 0.085, vAcross.x * 2.4);

  // Two layers scrolling at different rates and slightly different scales.
  // Cross-fading them the way a flow-map does keeps the surface from visibly
  // repeating without needing an actual flow map.
  vec2 s1 = flowUV + vec2(-uTime * 0.055, sin(uTime * 0.21) * 0.02);
  vec2 s2 = flowUV * 1.73 + vec2(-uTime * 0.088, -uTime * 0.011);
  vec4 n1 = texture2D(uFlowTex, s1);
  vec4 n2 = texture2D(uFlowTex, s2);

  // Distortion vector, then a second lookup through it: this is what gives the
  // swirling, marbled look of pigment dragged across wet paper.
  vec2 warp = (vec2(n1.r, n1.g) - 0.5) * 0.09 + (vec2(n2.b, n2.a) - 0.5) * 0.05;
  vec4 n3 = texture2D(uFlowTex, flowUV * 0.6 + warp + vec2(-uTime * 0.03, 0.0));

  float turb = clamp((n1.b * 0.5 + n2.b * 0.3 + n3.a * 0.4), 0.0, 1.0);

  // --- depth colour. The bed is a warm sand that reads THROUGH the shallows;
  // the channel proper settles to a teal-slate. Quantised into washes with soft
  // edges so it belongs to the same painting as the ground.
  float dNorm = clamp(vDepth / 1.75, 0.0, 1.0);
  // The quantiser boundary wanders with the flow noise, so the depth washes are
  // torn contours in the current rather than clean bathymetry lines.
  float dq = band(clamp(dNorm + (n3.b - 0.5) * 0.16, 0.0, 1.0), uBands, 0.11);
  vec3 col = mix(uShallow, uDeep, dq);
  // Silt fingers: the bed shows through in wandering streaks, not a clean ramp.
  float silt = (1.0 - smoothstep(0.10, 0.85, dNorm)) * smoothstep(0.30, 0.75, n3.b);
  col = mix(col, uBed, clamp(silt * 0.62 + (1.0 - dNorm) * 0.26, 0.0, 0.74));
  // Current: quantised value drift along the flow so the channel visibly moves.
  // Round 1 read as "a flat pale slab" because this term was a 0.82-1.22
  // multiply with a three-step ramp — under the grade that is a 6% swing.
  float cur = band(clamp(turb * 1.30 - 0.06, 0.0, 1.0), 3.0, 0.13);
  col *= 0.70 + cur * 0.62;
  col = mix(col, col * vec3(1.10, 1.03, 0.90), turb * 0.50);

  // Flow lines: the long dark filaments a river draws along its own shear,
  // quantised to two values so they read as drawn strokes and not as a normal
  // map. Aligned with the channel because they are sampled in flow UVs.
  float line = texture2D(uFlowTex, vec2(flowUV.x * 0.55 - uTime * 0.045,
                                        flowUV.y * 3.1 + warp.y * 2.0)).g;
  float streak = smoothstep(0.60, 0.78, line) * smoothstep(0.12, 0.45, dNorm);
  col *= 1.0 - streak * 0.17;

  // --- surface normal from the warp field, for glints only
  vec3 N = normalize(vec3(warp.x * 7.0, 1.0, warp.y * 7.0));
  vec3 V = normalize(vView);
  vec3 H = normalize(uSunDir + V);
  float spec = pow(max(dot(N, H), 0.0), 16.0);
  // Quantised glints: two hard steps, so highlights read as flicked gouache
  // rather than as a specular sheen.
  float glint = step(0.42, spec) * 0.5 + step(0.74, spec) * 0.5;
  // Break the glint field up with turbulence so it sparkles along the ripples.
  glint *= smoothstep(0.42, 0.78, turb);
  col += glint * uSunColor * 0.95;

  // Sky is only lightly reflected, and the reflection is BANDED like everything
  // else — a smooth Fresnel ramp is a zero on the watercolour axis.
  float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.5);
  fres = band(clamp(fres * 1.15 + (n3.b - 0.5) * 0.10, 0.0, 1.0), 3.0, 0.14);
  col = mix(col, uSkyColor, fres * 0.34);

  // --- wetness mask. The ribbon is built WIDER than the carved channel so its
  // edges bury themselves in the banks, which means a good part of it lies over
  // ground that is not under water at all. Everything below only applies where
  // there is genuinely water, or the surface paints a white foam slab across
  // the dry shingle.
  float wet = smoothstep(0.0, 0.09, vDepth);

  // --- foam. A tight noisy band right at the waterline, plus lace where the
  // flow is turbulent, plus a standing wave broken around every bridge pier.
  float shore = (1.0 - smoothstep(0.05, 0.40, vDepth)) * wet;
  float lace = smoothstep(0.42, 0.86, n3.b + n1.a * 0.4 - shore * 0.2);
  float foam = clamp(shore * (0.46 + lace * 0.80), 0.0, 0.90);
  foam += smoothstep(0.55, 0.95, vDepth) * lace * 0.16;   // midstream riffles
  // pier wash: aObstacle is 1 hard against a pier and dies off downstream
  float pier = vObst * wet * (0.48 + 0.60 * smoothstep(0.25, 0.75, turb));
  foam = max(foam, clamp(pier, 0.0, 0.94));
  // Quantise the foam so it lands as flicked white gouache with a torn edge,
  // not as an airbrushed alpha gradient.
  foam = band(clamp(foam + (n1.a - 0.5) * 0.18, 0.0, 1.0), 3.0, 0.10);
  col = mix(col, uFoam, clamp(foam, 0.0, 0.90));

  // A hard contact darkening where anything pierces the surface. Masonry
  // standing in a river makes a dark line at the waterline and a shadow in its
  // own lee; without one the piers read as pale cards laid ON the water.
  float contact = smoothstep(0.55, 0.97, vObst) * wet;
  col *= 1.0 - contact * 0.30;

  // Hold the pigment: the depth washes, the silt and the sky reflection all
  // pull toward neutral, and a neutral river reads as wet tarmac.
  float wlum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(wlum), col, 1.28);

  // --- paper grain over everything, screen-space so it belongs to the page
  float fibre = texture2D(uPaperTex, gl_FragCoord.xy * 0.0023).r;
  col *= 0.84 + fibre * 0.30;

  // --- aerial perspective, matched to the scene fog so the far reach of the
  // river recedes with the bank it runs through instead of staying vivid.
  float vd = length(vView);
  col = mix(col, uHaze, clamp(1.0 - exp(-pow(vd * uFogDensity, 2.0)), 0.0, 0.85));

  // Shallow water is nearly clear so the warm bed reads straight through it;
  // deep water closes up, which also stops submerged masonry from being
  // legible through the channel.
  float alpha = mix(0.30, 0.94, smoothstep(0.0, 1.05, vDepth));
  alpha = max(alpha, foam * 0.9);
  alpha *= wet;
  if (alpha < 0.02) discard;

  gl_FragColor = vec4(col, alpha);
}
`;

export class Water {
  /**
   * @param {MissionLayout} layout
   * @param {Terrain} terrain
   */
  constructor(layout, terrain, opts = {}) {
    this.layout = layout;
    this.terrain = terrain;
    this.time = 0;

    const geo = this._build(opts.across ?? 26, opts.subdiv ?? 2);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uFlowTex: { value: flowNoiseTexture(256, 61) },
        uPaperTex: { value: paperTexture(512, 77) },
        uTime: { value: 0 },
        uShallow: { value: new THREE.Color(PALETTE.water).lerp(new THREE.Color(PALETTE.sand), 0.22) },
        uDeep: { value: new THREE.Color(PALETTE.waterDeep) },
        uBed: { value: new THREE.Color(PALETTE.sand).lerp(new THREE.Color(PALETTE.dirt), 0.35) },
        uFoam: { value: new THREE.Color(PALETTE.foam) },
        uHaze: { value: new THREE.Color(PALETTE.haze) },
        uFogDensity: { value: 0.0026 },
        uSunDir: { value: WorldLighting.sunDir },
        uSunColor: { value: new THREE.Color(WorldLighting.sunColor) },
        uSkyColor: { value: new THREE.Color(PALETTE.skyHorizon) },
        uBands: { value: 3.0 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      // The ribbon is a single sheet: a camera that dips to the waterline, or a
      // soldier fording the shallows, must still see a surface above them.
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'river';
    this.mesh.userData.outline = false;
    this.mesh.receiveShadow = false;
    this.mesh.castShadow = false;
    this.mesh.renderOrder = 2;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
  }

  /**
   * Loft the ribbon. `across` cross-section segments, `subdiv` extra samples
   * per spline sample along the flow.
   */
  _build(across, subdiv) {
    const L = this.layout;
    const poly = L.river;
    const rows = [];
    // Only keep the stretch that can actually be seen, plus a margin.
    const margin = 26;
    const lim = 90 + margin;

    for (let i = 0; i < poly.n - 1; i++) {
      for (let s = 0; s < subdiv; s++) {
        const f = s / subdiv;
        const x = poly.x[i] + (poly.x[i + 1] - poly.x[i]) * f;
        const z = poly.z[i] + (poly.z[i + 1] - poly.z[i]) * f;
        if (Math.abs(x) > lim || Math.abs(z) > lim) continue;
        let tx = poly.x[i + 1] - poly.x[i];
        let tz = poly.z[i + 1] - poly.z[i];
        const tl = Math.hypot(tx, tz) || 1;
        tx /= tl; tz /= tl;
        const arc = poly.cum[i] + tl * f;
        const t = arc / poly.length;
        // Widen past the carved channel; the banks bury the excess, and the
        // shader discards anything that ends up over dry ground anyway.
        const w = L.riverHalfWidth(t) + 10.5;
        rows.push({ x, z, tx, tz, arc, w });
      }
    }
    // ensure the final row
    {
      const i = poly.n - 1;
      const x = poly.x[i], z = poly.z[i];
      if (Math.abs(x) <= lim && Math.abs(z) <= lim) {
        const j = i - 1;
        let tx = poly.x[i] - poly.x[j], tz = poly.z[i] - poly.z[j];
        const tl = Math.hypot(tx, tz) || 1;
        rows.push({ x, z, tx: tx / tl, tz: tz / tl, arc: poly.cum[i], w: L.riverHalfWidth(1) + 10.5 });
      }
    }

    const R = rows.length;
    const C = across + 1;
    const pos = new Float32Array(R * C * 3);
    const nrm = new Float32Array(R * C * 3);
    const uv = new Float32Array(R * C * 2);
    const dep = new Float32Array(R * C);
    const flw = new Float32Array(R * C * 2);
    const arcA = new Float32Array(R * C);
    const obs = new Float32Array(R * C);
    const piers = this._pierPoints();

    for (let r = 0; r < R; r++) {
      const row = rows[r];
      // channel normal (perpendicular to flow, in XZ)
      const nx = -row.tz, nz = row.tx;
      for (let c = 0; c < C; c++) {
        const u = (c / across) * 2 - 1;               // -1..1 across
        const x = row.x + nx * u * row.w;
        const z = row.z + nz * u * row.w;
        const k = r * C + c;
        pos[k * 3] = x;
        pos[k * 3 + 1] = WATER_Y;
        pos[k * 3 + 2] = z;
        nrm[k * 3] = 0; nrm[k * 3 + 1] = 1; nrm[k * 3 + 2] = 0;
        uv[k * 2] = u;
        uv[k * 2 + 1] = row.arc * 0.1;
        const bed = this.terrain ? this.terrain.heightAt(x, z) : WATER_Y - 1.5;
        dep[k] = Math.max(0, WATER_Y - bed);
        flw[k * 2] = row.tx;
        flw[k * 2 + 1] = row.tz;
        arcA[k] = row.arc;
        // Standing wash around the bridge piers: tight on the upstream cutwater,
        // trailing into a wake on the lee side.
        let o = 0;
        for (let p = 0; p < piers.length; p++) {
          const P = piers[p];
          const dx = x - P.x, dz = z - P.z;
          const along = dx * row.tx + dz * row.tz;        // + is downstream
          const side = Math.abs(dx * -row.tz + dz * row.tx);
          const reach = along > 0 ? 5.5 : 2.2;
          const f = (1 - clamp01(Math.abs(along) / reach)) *
                    (1 - clamp01((side - P.r) / (along > 0 ? 2.4 : 1.3)));
          if (f > o) o = f;
        }
        obs[k] = o * o;
      }
    }

    const idx = [];
    for (let r = 0; r < R - 1; r++) {
      for (let c = 0; c < C - 1; c++) {
        const a = r * C + c, b = r * C + c + 1;
        const d = (r + 1) * C + c, e = (r + 1) * C + c + 1;
        // Wind the quads so the geometric normal points UP. (across x flow) is
        // left-handed about +Y here, so the naive order faces the riverbed and
        // FrontSide culling made the whole river invisible.
        idx.push(a, b, e, a, e, d);
      }
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('aDepth', new THREE.BufferAttribute(dep, 1));
    g.setAttribute('aFlow', new THREE.BufferAttribute(flw, 2));
    g.setAttribute('aArc', new THREE.BufferAttribute(arcA, 1));
    g.setAttribute('aObstacle', new THREE.BufferAttribute(obs, 1));
    g.setIndex(idx);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    this.rows = rows;
    return g;
  }

  /**
   * World positions of the bridge piers, mirroring buildBridge()'s pier layout
   * so the foam breaks exactly where the masonry stands in the stream.
   */
  _pierPoints() {
    const b = this.layout.bridge;
    if (!b || !(b.length > 0)) return [];
    const { span, pierZ } = bridgeSpanLayout(b.length);
    if (!(span > 0)) return [];
    const co = Math.cos(b.yaw), si = Math.sin(b.yaw);
    const out = [];
    for (const zc of pierZ) {
      // The cutwaters reach 1.45 m past the parapet line on each side, so the
      // standing wash has to break that far out or the masonry appears to sit
      // ON the water rather than IN it.
      out.push({ x: b.x + zc * si, z: b.z + zc * co, r: b.width * 0.5 + 1.6 });
    }
    return out;
  }

  /** Surface height including the swell — for splash VFX and boats. */
  surfaceY(x, z) {
    const t = this.time;
    const r = this.layout.riverSDF(x, z);
    const arc = r.t * this.layout.river.length;
    const s1 = Math.sin(arc * 0.55 - t * 1.35 + x * 0.11);
    const s2 = Math.sin(arc * 1.35 + t * 2.05 - z * 0.19);
    const depth = clamp01((WATER_Y - (this.terrain ? this.terrain.heightAt(x, z) : 0)) / 0.55);
    return WATER_Y + (s1 * 0.045 + s2 * 0.026) * depth;
  }

  update(dt) {
    this.time += dt;
    this.material.uniforms.uTime.value = this.time;
    this.material.uniforms.uSunDir.value.copy(WorldLighting.sunDir);
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
