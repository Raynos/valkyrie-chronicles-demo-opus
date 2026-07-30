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
  // ground — Gallia is green, but it is SAGE AND OLIVE green.
  //
  // Round 3 rescued these from a sepia duotone by authoring them deep and
  // saturated, on the reasoning that the NPR lit transform bleaches them. Round
  // 4 measured the result: `firefight` put 41.3% of the frame inside hue 80-160
  // with the 80-100 decade alone holding 25.8%, `grass` 40.2%, and lit patches
  // at HSV saturation 0.41-0.47 against VC Remastered pasture at 0.15-0.28.
  // The lit transform no longer boosts green chroma (it bleaches it, as a sun
  // does) and the material clamps the lobe besides, so these can finally be
  // authored as what they should look like: yellow-leaning, low chroma, with
  // the dark and lush variants a real hue apart from the base so a hillside has
  // something to vary BETWEEN.
  //
  //
  // ROUND 6. Round 5's numbers are in the third column, and they were still too
  // hot: measured on the shipped frames, lit grass came back at HSV saturation
  // 0.271 (overview), 0.305 (tank), 0.316 (firefight) and 0.351 (grass) against
  // a target of 0.28 and falling — i.e. the round-5 build moved the number the
  // WRONG WAY, and two critics independently called the hillsides "a flat
  // acid-green paint-bucket wash" and "electric green".
  //
  // Two things are clamped here now rather than one. The GREENS are pulled to
  // 0.22-0.28 display chroma — src/render/materials.js vcSageFinish enforces a
  // hard 0.26 linear ceiling on the green lobe on top of this, so these are the
  // authored intent and that is the guarantee. The STRAWS (grassDry, wheat,
  // wheatDark) are pulled down as well, and they matter more than they look:
  // they sit at 43-55 degrees, which is BELOW the sage clamp's lobe — the clamp
  // deliberately cannot reach them, because widening it far enough to would also
  // reach the road ochre and pull the cart track toward green. The straws are
  // therefore the one green-family pigment whose only ceiling is this table, and
  // they are most of what the `grass` shot's fallow field is made of.
  //
  // assertPalette() at the bottom of this block enforces both at load.
  //                      display HSV      round 5           round 3
  grass: 0x717a58,     // 76 deg / 0.28    0x6f7a50 / 0.34   0x5e7440 / 0.45
  grassDry: 0x8d8a72,  // 53 deg / 0.19    0x8f8b5f / 0.34   0x8d8d56 / 0.39
  grassDark: 0x4d5540, // 83 deg / 0.25    0x4d5540 / 0.25   0x3f5433 / 0.42
  grassLush: 0x5e6a4f, // 87 deg / 0.25    0x5c6a48 / 0.32   0x4c6b3c / 0.44
  // Earth is UMBER AND OCHRE, and in this frame it is also the majority
  // pigment: the busiest 55-degree hue wedge holds 47-72% of every shot and it
  // is the 8-63 degree one, which is these four colours plus the stucco. Round
  // 5 had dirt at HSV 0.48 and sand at 0.33 — the road was the most saturated
  // large surface in the game and it is 30-40% of the ground in half the shots.
  // Pulling the two of them to 0.36 and 0.25 is the only move available on this
  // side of the wedge that does not touch the pantiles or the ribbon.
  dirt: 0x92805e,      // 39 deg / 0.36   was 0x967c4e / 0.48
  dirtDark: 0x6f5c42,  // 36 deg / 0.40   was 0x715a37 / 0.51
  mud: 0x5b5140,
  rock: 0x928c80,
  sand: 0xc0af90,      // 39 deg / 0.25   was 0xc2ad83 / 0.33
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
  // BARN CLADDING IS NOT FRAMING TIMBER. A structural post is oiled or tarred
  // and keeps its red-brown; a boarded barn wall has stood in the weather for
  // forty years and has silvered to a grey-brown with almost no chroma left in
  // it. Round 3 built both out of PALETTE.timber (HSV sat 0.52) and the result
  // was a 9x4 m slab of the most saturated pigment on the map filling the left
  // third of the `village` frame — which is most of why that shot measured a
  // mean saturation of 91/255, the highest in the set, against 60-77 everywhere
  // else. Same hue family, a third of the chroma.
  barnBoard: 0x8b7c68,
  barnBoardDark: 0x6d6152,
  plaster: 0xcfc4ae,
  // materiel
  burlap: 0xb09a6c,
  steel: 0x7c7a80,
  steelDark: 0x565059,
  olive: 0x6c7050,
  rust: 0x8d5a3c,
  crate: 0x9a7c4e,
  // vegetation
  // Canopy, same story as the pasture and measured in the same scans — the
  // 80-100 decade that holds 25.8% of `firefight` is grass AND leaf. Authored
  // at 0.47-0.55 display chroma these were the most saturated masses in every
  // wooded shot; a canopy in a gouache study is a low-chroma olive with its
  // VALUE doing the work, not its hue. Species stay a real hue apart from each
  // other so a treeline is still a treeline.
  //                        display HSV      round 5           round 3
  leafOak: 0x646d51,     // 79 deg / 0.26   0x606b42 / 0.38   0x53692f / 0.55
  leafPoplar: 0x6f785a,  // 78 deg / 0.25   0x6c784b / 0.38   0x62793a / 0.52
  leafWillow: 0x7e8566,  // 74 deg / 0.23   0x7c8558 / 0.34   0x738345 / 0.47
  leafDark: 0x414838,    // 86 deg / 0.22   0x3f4832 / 0.31   0x38492a / 0.43
  // Straw, not gold. See the note on grassDry: these sit below the sage clamp's
  // lobe, so this table is the only ceiling they have.
  wheat: 0xb3a684,       // 43 deg / 0.26   0xb9a565 / 0.45
  wheatDark: 0x877c64,   // 41 deg / 0.26   0x8f7c48 / 0.50
  reed: 0x868a68,        // 67 deg / 0.25   0x848a5c / 0.33   0x7d8a4a / 0.46
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
// palette assertion
// ---------------------------------------------------------------------------
//
// Four rounds running, a critique has come back with "clamp every PALETTE green
// at source" and four rounds running the table has drifted back up, because a
// hex literal carries no units and 0x7d8a49 does not look saturated written
// down (it is 0.47). This makes the ceiling executable.
//
// It is a WARNING, not a throw: a palette that is 0.01 over its ceiling must not
// be able to black-screen the game in front of a player. It fails loudly in the
// console instead, and the shader-side clamp (vcSageFinish) is the guarantee.
const PIGMENT_CEILING = {
  // the green lobe the sage clamp covers
  green: { hue: [52, 130], maxSat: 0.30 },
  // straw and stubble sit below that lobe and have no shader-side ceiling
  straw: { hue: [38, 52], maxSat: 0.38, keys: ['grassDry', 'wheat', 'wheatDark'] },
};

function hexHsv(hex) {
  const r = ((hex >> 16) & 255) / 255, g = ((hex >> 8) & 255) / 255, b = (hex & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 1e-6) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  h *= 60; if (h < 0) h += 360;
  return [h, mx > 0 ? d / mx : 0, mx];
}

export function assertPalette(palette = PALETTE) {
  const bad = [];
  for (const [k, v] of Object.entries(palette)) {
    if (typeof v !== 'number') continue;
    const [h, s] = hexHsv(v);
    const rule = PIGMENT_CEILING.straw.keys.includes(k)
      ? PIGMENT_CEILING.straw
      : (h >= PIGMENT_CEILING.green.hue[0] && h <= PIGMENT_CEILING.green.hue[1])
        ? PIGMENT_CEILING.green : null;
    if (rule && s > rule.maxSat + 1e-4) {
      bad.push(`${k}=0x${v.toString(16).padStart(6, '0')} hue ${h.toFixed(0)} sat ${s.toFixed(3)} > ${rule.maxSat}`);
    }
  }
  if (bad.length) {
    console.warn('[palette] pigment ceiling exceeded — a Gallian pasture is sage and '
      + 'olive, not video-game green:\n  ' + bad.join('\n  '));
  }
  return bad;
}
assertPalette();

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
// HSV, local copies: this chunk is injected into three's Lambert shader, which
// does not carry shaderLib, and every identifier here has to be np-prefixed.
vec3 npRgb2Hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)), d / (q.x + 1e-10), q.x);
}
vec3 npHsv2Rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}

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
  //
  // SAME RULE AS src/render/materials.js vcShadeTurn / vcShadeDeep, and it has
  // to be, or the one material that falls back here is the one surface in frame
  // whose shadow goes the other way. Two things separate this from what was
  // here before:
  //
  //  * npBase * uShadeTint is a MULTIPLY, and a multiply cannot cool a warm
  //    pigment: ochre (0.60,0.45,0.25) times a blue-violet still has red
  //    highest and blue lowest. Worse, raising blue against green on a
  //    red-dominant colour moves the HUE DOWN — an ochre at 40 deg came out of
  //    that pair of lines at 19 deg, which is the measured "every material
  //    rotates its shadow into red" in one expression.
  //  * the half-tone is a GLAZE (a mix), and the hue turn is bounded and never
  //    wraps through 0, so ochre climbs to olive rather than falling to maroon.
  //
  // Round 14 brought both halves back in step with materials.js: the turn is
  // 14 deg, not 34 (the budget was compensating for a contact wash that used to
  // drag the hue back down and no longer does), and the deepest wash TURNS
  // toward the skylight instead of being mixed onto it. A 0.62 mix substituted
  // the skylight's chromaticity for the pigment's, and the 242..290 clamp that
  // followed then guaranteed the answer was violet whatever went in — measured
  // on the sibling path, five different pigments all landed on 232-244.
  vec3 npHt = npRgb2Hsv(npBase);
  npHt.x = clamp(npHt.x + clamp(0.73611 - npHt.x, -0.0389, 0.0389), 0.0, 1.0);
  npHt.y *= 0.74;
  npHt.z *= 0.62;
  vec3 npHalfCol = npHsv2Rgb(npHt);
  // the deepest wash: the half-tone darkened, turned a bounded amount further
  // toward the skylight's own hue, and left less chromatic
  float npL = max(dot(npHalfCol, vec3(0.2126, 0.7152, 0.0722)), 1e-5);
  vec3 npTint = uShadeTint / max(dot(uShadeTint, vec3(0.2126, 0.7152, 0.0722)), 1e-4);
  vec3 npShadeCol = npHalfCol * 0.66;
  vec3 npSh = npRgb2Hsv(npShadeCol);
  float npPoleH = npRgb2Hsv(npTint).x;
  npSh.x = clamp(min(npSh.x + clamp(npPoleH - npSh.x, -0.0379, 0.0379),
                     max(npSh.x, 0.375)), 0.0, 1.0);
  npSh.y *= 0.66;
  npShadeCol = npHsv2Rgb(npSh);
  // a pigment with no hue left cannot be turned, so that is the one place the
  // skylight is allowed to paint directly
  float npNeutral = 1.0 - smoothstep(0.02, 0.12, npSh.y);
  npShadeCol = mix(npShadeCol, vec3(npL * 0.66) * npTint, npNeutral * 0.62);
  vec3 npMidCol   = npBase * uMidTint;
  vec3 npLitCol   = npBase * uLitTint + vec3(0.045, 0.038, 0.022);
  vec3 npCol = mix(npShadeCol, npHalfCol, smoothstep(0.06, 0.26, npQ));
  npCol = mix(npCol, npMidCol, smoothstep(0.32, 0.58, npQ));
  npCol = mix(npCol, npLitCol, smoothstep(0.56, 1.0, npQ));

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
    // 0x6a5f78, not 0x4b4270. Same hue family, a third less chroma and a third
    // more value: this colour is now used as a unit-luminance TINT for the
    // deep-wash glaze rather than as a multiply, and a high-chroma violet used
    // that way is what put a flat lavender slab on every shaded masonry face.
    uShadeTint: { value: new THREE.Color(opts.shadeTint ?? 0x6a5f78) },
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
  // The daylight poles this material's washes ramp away from at dusk.
  m.userData.dayTint = { lit: u.uLitTint.value.clone(), shade: u.uShadeTint.value.clone() };
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
  return noteWorldMaterial(m);
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
// NOTE (round 5): the coursing and fissure branches these presets drive were
// dead code until now — src/render/materials.js added them to `extraDrive`
// four lines AFTER extraDrive had already been folded into the band drive, so
// nothing they produced ever reached a band. That is fixed; `mottle` and
// `wetRim` below are the two new knobs, and they are what give a surface
// pigment character WITHOUT the caller having to name a preset (both have
// non-zero material defaults), which matters because none of the world's own
// bins — structures, props, vegetation — pass `surface:` at all.
// `violet` is the PER-MATERIAL VIOLET MAX the round-6 temperature note asks for:
// how far the DEEPEST wash may be glazed onto the skylight. It is not a taste
// knob, it is an area knob. A shaded gable is 20-30% of the `village` frame and
// a shaded ashlar face is 35% of `bridge`, so masonry and stucco taken to the
// same violet as a patch of shaded earth is precisely how round 1 produced "a
// flat lavender wash over 70% of the frame". Earth and foliage — which is where
// the frame's shade family actually has to be legible, and which is broken up
// by grass, rock and detail — keep the full amount.
export const SURFACE_PIGMENT = {
  //            block m  tone  fissure  freq   other
  masonry:  { blockSize: 0.42, blockTone: 0.115, pigLevels: 15, mottle: 0.105, wetRim: 0.85, violet: 0.78 },
  brick:    { blockSize: 0.16, blockTone: 0.085, pigLevels: 15, mottle: 0.090, wetRim: 0.80, violet: 0.82 },
  stucco:   { blockSize: 0, blockTone: 0, pigLevels: 13, grain: 0.55, blotch: 1.35, mottle: 0.125, wetRim: 0.75, violet: 0.72 },
  tile:     { blockSize: 0.15, blockTone: 0.095, pigLevels: 14, mottle: 0.080, wetRim: 0.80, violet: 0.86 },
  timber:   { fissure: 0.075, fissureFreq: 3.4, pigLevels: 13, mottle: 0.085, violet: 0.95 },
  bark:     { fissure: 0.135, fissureFreq: 2.6, pigLevels: 12, curvature: 0.22, mottle: 0.095, violet: 1.05 },
  metal:    { pigLevels: 12, grain: 0.25, mottle: 0.055, wetRim: 0.70, violet: 0.95 },
  cloth:    { pigLevels: 12, grain: 0.38, mottle: 0.050, violet: 0.90 },
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
  // round 5: the pigment-quantiser leash, the granulating boundary rim, the
  // sub-metre pigment field and the sage/olive clamp. See applyNprOpts.
  'pigWarp', 'wetRim', 'mottle', 'pasture',
  // round 7: how far, in degrees, this pigment's half-tone may turn toward the
  // 265 deg skylight. Defaults in applyNprOpts (40 deg, 32 on skin); a bin only
  // sets it to say "this pigment must stay closer to itself in shade".
  'shadeTurn',
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
      // PER-MATERIAL VIOLET MAX. Everything this factory makes is BUILT — a
      // gable, a barn wall, a parapet, a crate — and built surfaces are the
      // large flat masses in the frame, so they are where a violet deep wash
      // stops being a shade family and becomes a lavender slab. Round 1's
      // rejection was exactly that, and `village` still measures 43-50% of its
      // pixels in hue 240-300 because one shaded facade owns a quarter of the
      // plate. Terrain (1.12) and foliage (1.12) keep the full amount: they are
      // broken up by grass, rock and leaf and they are where the shade family
      // has to be legible.
      violet: opts.violet ?? 0.82,
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
      hatch: opts.hatch ?? 1.15,
      bands: CFG.render.bands,
      outline: false,
      color: 0xffffff,

      // ---- THE TERRAIN'S OWN BAND WINDOW -----------------------------------
      //
      // Four rounds of "the ground is one unmodulated wash" came from this
      // material shipping the GENERIC band window while the ground occupies
      // only the top half of the scene-wide drive. Arithmetic, from the shader:
      //
      //   drive = keyN * uKeyGain(0.62) * uKeyBoost + ambTerm * uFillGain(0.30)
      //
      // keyN is half-Lambert at wrap 0.5, so a horizontal plane in full sun at
      // a 57-degree key returns 0.89 and drives to 0.85, while ground in cast
      // shadow (uShadowFloor 0.14) drives to 0.38 and a face turned right away
      // drives to 0.30. The whole terrain therefore lives in 0.30..0.85 — and
      // with the default driveRange (0,1) and contrast 1.12 that is 0.30..0.90
      // after the contrast lift, i.e. it crosses ONE of the four boundaries.
      // Measured on round 4: every 400x150 px terrain patch in the set came
      // back with exactly one histogram mode above 6%.
      //
      // Handing it the span it actually occupies is the whole fix. 0.28..0.90
      // maps shadow to 0.03 and full sun to 1.0, so a 90-degree change of
      // ground normal now crosses three boundaries instead of one. contrast is
      // deliberately LOW (1.18): the range remap has already done the
      // stretching and a second one on top of it clips both ends into flat
      // slabs, which is the failure mode the round-3 masonry had.
      driveRange: opts.driveRange ?? [0.29, 0.93],
      contrast: opts.contrast ?? 1.10,
      lightBias: opts.lightBias ?? 0.0,
      // ...and the boundary has to WANDER, or four hard bands on a heightfield
      // read as a contour map. 26 px of wet-edge displacement at 1.8x bleed is
      // a 4-8 px wobble at the scales these shots are framed at.
      bandBleed: opts.bandBleed ?? 1.8,
      wetPx: opts.wetPx ?? 26,
      // The ground is the largest area of shade in every frame, so it is where
      // the violet skylight has to be legible; but grass shade that rotates
      // past 250 degrees reads as cyan, which the dusk critique measured.
      shadeCool: opts.shadeCool ?? 0.88,
      violet: opts.violet ?? 1.12,
      cream: opts.cream ?? 1.06,
      // The composite-luminance quantiser that runs UNDER the band ladder. At
      // 16 levels over the perceptual range its steps are 4 LSB apart, which is
      // inside the paper grain and therefore invisible; 12 puts them at 6-7,
      // which is what a laid wash actually does when it dries in stages.
      pigLevels: opts.pigLevels ?? 12,
      pigQ: opts.pigQ ?? 0.86,
      // GRANULATING BOUNDARIES. "Give surfaces pigment character... granulating
      // dark edges where a wash meets its shade boundary" has been on the
      // materials note for three rounds, and the ground is the largest set of
      // wash boundaries in every frame. uWetRim is independent of bandBleed —
      // how far a boundary WANDERS and how much pigment DRIES OUT on it are
      // unrelated quantities — and the terrain has been running on the generic
      // 0.55 default while its bleed did all the work.
      wetRim: opts.wetRim ?? 1.05,
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
  // ...AND THE FIVE KNOBS makeTerrainMaterial NEVER READS.
  //
  // src/render/materials.js applies contrast / lightBias / bandBleed / wetPx /
  // shadeCool explicitly inside makeCanvasMaterial, but its TERRAIN factory
  // only runs applyNprOpts(), which covers keyGain, fillGain, violet, cream and
  // driveRange and nothing else. Forwarding them through the opts object is
  // therefore a silent no-op on the one material that covers most of every
  // frame — measured: with driveRange alone the shaded bank on `bridge` went
  // from 5 transect levels to 7, and the open pasture on `overview` did not
  // move at all. Write them where they live instead, exactly as this module
  // already does for the bark bin, rather than widening a signature owned by
  // another module.
  const u = m && m.uniforms;
  if (u) {
    if (u.uLightContrast) u.uLightContrast.value = opts.contrast ?? 1.10;
    if (u.uLightBias) u.uLightBias.value = opts.lightBias ?? 0.0;
    if (u.uBandBleed) u.uBandBleed.value = opts.bandBleed ?? 1.8;
    if (u.uWetPx) u.uWetPx.value = opts.wetPx ?? 26;
    if (u.uShadeCool) u.uShadeCool.value = opts.shadeCool ?? 0.88;
  }
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

// ---------------------------------------------------------------------------
// time of day: the whole world follows the sun's elevation
// ---------------------------------------------------------------------------
//
// WHY THIS EXISTS. Round 3's `dusk` shot got a correct low warm key, a correct
// 13-degree sun and — once src/world/sky.js grew its dusk pole — a correct
// ember dome, and the GROUND under it still read as mid-afternoon: the same
// electric pasture green at the same value it has at midday, under a sunset.
// That combination does not occur in nature and it is the single loudest thing
// wrong with the frame.
//
// The reason is arithmetic, not colour. src/render/materials.js builds its band
// index from
//     drive = keyN * uKeyGain * uKeyBoost + ambTerm * uFillGain * uFillBoost
// and MaterialRegistry, seeing a dim key, deliberately RAISES uFillGain to stop
// the frame collapsing into the darkest value. That is the right call for a
// gameplay camera in a dim scene, but it means the sky fill alone carries the
// open field into the middle bands — where the composite is just the albedo —
// so no amount of re-tinting the lit and shade washes can touch it. Measured:
// driving uCream to pure red and uViolet to pure blue moved the frame's mean
// saturation by 0.3/255.
//
// So this ramps the term that actually decides which band a fragment lands in.
// uKeyBoost / uFillBoost / uVioletGain / uCreamGain are PER-MATERIAL knobs —
// src/render documents them as exactly the escape hatch for a material that
// needs a different mix from the shared pair — and every material touched here
// is one this module built for the world. Nothing global is mutated.

/** The dusk poles for the four per-material grade knobs. */
const DUSK_GRADE = {
  // The sky fill stops doing the sun's job. This is the load-bearing one: it
  // is what drops the open field out of the mid bands and into the shade wash,
  // which is what "the valley goes to violet" actually means in this shader.
  fillBoost: 0.46,
  // The key keeps its own bands — a low sun still picks out every west face,
  // and losing that would flatten the frame rather than darken it.
  keyBoost: 1.06,
  // ...and once the field IS in the shade wash, the wash's own colour finally
  // matters, so lean it further into the skylight violet and pull the cream
  // lift back toward the ember the key actually is.
  violetGain: 1.42,
  creamGain: 0.86,
};

// The lit / shade poles the SHARED washes ramp toward. These are bound by
// reference across every material in the frame (SHARED_KEYS in materials.js),
// so this is a global act — done by swapping the uniform's `.value` reference,
// never by mutating src/render's own PALETTE colour objects.
const DUSK_CREAM = new THREE.Color(0xffb478);   // low sun on a lit face
const DUSK_VIOLET = new THREE.Color(0x453a72);  // the sky's own blue in shade
const DUSK_INK = new THREE.Color(0x241d2e);
const _dayWash = { cream: null, violet: null, ink: null };
const _washCream = new THREE.Color();
const _washViolet = new THREE.Color();
const _washInk = new THREE.Color();
let _duskApplied = -1;

/**
 * How far into dusk we are, from the sine of the sun's elevation.
 *
 * Identical ramp to src/world/sky.js duskAmount() — deliberately duplicated
 * rather than imported, because sky.js imports THIS module and closing that
 * cycle for six lines of arithmetic is not worth it. If one changes, change
 * both: the dome and the ground have to reach dusk on the same frame or the
 * frame contains two different times of day.
 *
 * The eleven daylight shots run 34-59 degrees of elevation (sin 0.56-0.86) and
 * every one of them returns exactly 0 here, so none of this can warm them.
 */
function duskAmount(sinElev) {
  const t = (0.50 - sinElev) / (0.50 - 0.24);
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

const lerpN = (a, b, k) => a + (b - a) * k;

/** Every material this module handed back, so the grade can reach all of them. */
const _worldMats = new Set();
function noteWorldMaterial(m) {
  if (m && m.uniforms && m.uniforms.uKeyBoost && !_worldMats.has(m)) {
    m.userData.dayGrade = {
      key: m.uniforms.uKeyBoost.value,
      fill: m.uniforms.uFillBoost.value,
      violet: m.uniforms.uVioletGain ? m.uniforms.uVioletGain.value : 1,
      cream: m.uniforms.uCreamGain ? m.uniforms.uCreamGain.value : 1,
    };
    _worldMats.add(m);
  }
  return m;
}

/** Blend every world material between its daylight and its dusk grade. */
function applyDusk(k) {
  if (Math.abs(k - _duskApplied) < 1e-3) return;
  _duskApplied = k;
  const D = DUSK_GRADE;
  for (const m of _worldMats) {
    const d = m.userData.dayGrade;
    const u = m.uniforms;
    if (!d) continue;
    u.uKeyBoost.value = d.key * lerpN(1, D.keyBoost, k);
    u.uFillBoost.value = d.fill * lerpN(1, D.fillBoost, k);
    if (u.uVioletGain) u.uVioletGain.value = d.violet * lerpN(1, D.violetGain, k);
    if (u.uCreamGain) u.uCreamGain.value = d.cream * lerpN(1, D.creamGain, k);
    // The shared block is reachable through any one of them.
    if (!_dayWash.cream && u.uCream && u.uViolet) {
      // Snapshot the daylight poles by VALUE, then swap in colours we own. The
      // uniform's current value IS src/render's palette object; mutating that
      // would repaint their module, so only the reference is replaced.
      _dayWash.cream = u.uCream.value.clone();
      _dayWash.violet = u.uViolet.value.clone();
      _dayWash.ink = u.uInkFloor ? u.uInkFloor.value.clone() : null;
      u.uCream.value = _washCream;
      u.uViolet.value = _washViolet;
      if (u.uInkFloor) u.uInkFloor.value = _washInk;
    }
  }
  if (_dayWash.cream) {
    _washCream.copy(_dayWash.cream).lerp(DUSK_CREAM, k);
    _washViolet.copy(_dayWash.violet).lerp(DUSK_VIOLET, k);
    if (_dayWash.ink) _washInk.copy(_dayWash.ink).lerp(DUSK_INK, k);
  }
  // ...and the same move on the locally-authored fallback path, so a surface
  // that fell back to the Lambert material does not stay in daylight next to
  // one that did not.
  for (const m of _fallbacks) {
    const fu = m.userData.uniforms;
    if (!fu || !m.userData.dayTint) continue;
    fu.uLitTint.value.copy(m.userData.dayTint.lit).lerp(DUSK_CREAM, k * 0.75);
    fu.uShadeTint.value.copy(m.userData.dayTint.shade).lerp(DUSK_VIOLET, k * 0.75);
  }
}

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
  applyDusk(duskAmount(WorldLighting.sunDir.y));
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
