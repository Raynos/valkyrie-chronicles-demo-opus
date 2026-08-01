// src/render/shaderLib.js
// -----------------------------------------------------------------------------
// Shared GLSL for the CANVAS-engine renderer. Everything in here is a string
// pasted into both surface materials and post-process passes, so the watercolour
// vocabulary (band bleed, pigment pooling, graphite hatching, shadow hue
// rotation) is literally the same maths everywhere and the frame reads as one
// painting instead of a scene plus a filter.
//
// Colour convention: ALL of this runs in linear working space. Palette colours
// arrive as THREE.Color uniforms so three's ColorManagement has already done the
// sRGB -> linear conversion; never hard-code a hex-derived literal in here.
// -----------------------------------------------------------------------------

// ------------------------------------------------------------------ hashing
// Dave Hoskins' hash family: cheap, no sin(), stable across drivers.
export const GLSL_HASH = /* glsl */`
float vcHash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}
float vcHash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 vcHash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float vcHash31(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
`;

// -------------------------------------------------------------------- noise
export const GLSL_NOISE = /* glsl */`
float vcNoise2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = vcHash21(i);
  float b = vcHash21(i + vec2(1.0, 0.0));
  float c = vcHash21(i + vec2(0.0, 1.0));
  float d = vcHash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float vcNoise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float n000 = vcHash31(i);
  float n100 = vcHash31(i + vec3(1.0, 0.0, 0.0));
  float n010 = vcHash31(i + vec3(0.0, 1.0, 0.0));
  float n110 = vcHash31(i + vec3(1.0, 1.0, 0.0));
  float n001 = vcHash31(i + vec3(0.0, 0.0, 1.0));
  float n101 = vcHash31(i + vec3(1.0, 0.0, 1.0));
  float n011 = vcHash31(i + vec3(0.0, 1.0, 1.0));
  float n111 = vcHash31(i + vec3(1.0, 1.0, 1.0));
  float a = mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y);
  float b = mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y);
  return mix(a, b, u.z);
}
// Fixed-octave fbms. Written out rather than looped so the compiler can
// schedule the texture-free ALU work tightly.
float vcFbm2(vec2 p) {           // 2 octaves — broad wash shapes
  float s = vcNoise2(p) * 0.6667;
  s += vcNoise2(p * 2.03 + 11.3) * 0.3333;
  return s;
}
float vcFbm3(vec2 p) {           // 3 octaves — the workhorse
  float s = vcNoise2(p) * 0.5714;
  s += vcNoise2(p * 2.03 + 11.3) * 0.2857;
  s += vcNoise2(p * 4.11 + 27.9) * 0.1429;
  return s;
}
float vcFbm4(vec2 p) {           // 4 octaves — surface granulation
  float s = vcNoise2(p) * 0.5333;
  s += vcNoise2(p * 2.03 + 11.3) * 0.2667;
  s += vcNoise2(p * 4.11 + 27.9) * 0.1333;
  s += vcNoise2(p * 8.17 + 53.1) * 0.0667;
  return s;
}
float vcFbm3d(vec3 p) {
  float s = vcNoise3(p) * 0.5714;
  s += vcNoise3(p * 2.03 + 11.3) * 0.2857;
  s += vcNoise3(p * 4.11 + 27.9) * 0.1429;
  return s;
}
`;

// ------------------------------------------------------------- colour tools
export const GLSL_COLOR = /* glsl */`
float vcLum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

// ---------------------------------------------------- the paper midtone window
// THE RULE (rubric axis 4): the cold-press grain is strongest at the MIDTONES,
// gone in the highlights, gone in deep shadow.
//
// Round 2 shipped mid = pow(1.0 - abs(l*2.0-1.0), 0.75) with l a LINEAR
// luminance, and that is why the grain measured loudest exactly where it had to
// vanish. A linear 0.5 is a DISPLAY value of 0.73 — a highlight — so the window
// peaked on the brightest surfaces in frame and rolled off through the actual
// midtones. Measured consequence: the lit cream stucco (display 0.79, i.e.
// linear 0.58) evaluated to 0.87, so the fibre ran at 87% strength on the
// brightest object in the picture, giving the same high-pass amplitude there as
// on the midtone grass.
//
// The window therefore has to be evaluated in a PERCEPTUAL space. Three entry
// points, because the callers hold the value in three different spaces:
//   vcPaperWindow    — v is already display-referred 0..1
//   vcPaperMid       — l is a post-tonemap linear value (the grade pass)
//   vcPaperMidScene  — l is scene-referred radiance (the surface shaders), so
//                      a cheap Reinhard stands in for the tonemap first
// Peak 0.25..0.50 display, three quarters gone by 0.67, gone by 0.80. The upper
// shoulder is deliberately early: "gone in highlights" is a hard requirement of
// the axis, and a lit cream wall reading as clean paint with the tooth only in
// the washes around it is what the reference actually looks like.
float vcPaperWindow(float v) {
  return smoothstep(0.06, 0.26, v) * (1.0 - smoothstep(0.52, 0.82, v));
}
float vcPaperMid(float l) {
  return vcPaperWindow(pow(clamp(l, 0.0, 1.0), 0.4545));
}

// ---------------------------------------------- predicting the display value
// vcPaperMidScene used to stand a Reinhard (l / (l + 0.62)) in for the grade's
// filmic curve, and that stand-in is wrong at exactly the end that decides
// whether a frame's grain looks like paper. Measured against the real chain
// (Hable A..F, W = 2.45, gouache S at contrast 0.34, exposure x pre-gain =
// 1.1236):
//
//   scene l   real display   Reinhard 0.62   real window   window as shipped
//     0.02        0.092          0.207          0.069            0.826
//     0.05        0.166          0.307          0.544            1.000
//     0.30        0.534          0.601          0.994            0.821
//     0.70        0.781          0.750          0.047            0.140
//
// So the substrate was running at 83% strength on scene values that reach the
// screen as a deep shade wash, where the rubric requires it GONE — and by how
// much depended on where a given shot's exposure put its masses, which is
// precisely why paper measured 8 on squad and 3 on closeup off one constant.
// Run the actual curve instead. The exposure arrives as a uniform because the
// grade owns it and a day/night cycle moves it.
float vcSceneDisplay(float l, float exposure) {
  float x = max(l, 0.0) * exposure;
  const float A = 0.22, B = 0.30, C = 0.10, D = 0.20, E = 0.018, F = 0.30;
  const float W = 2.45;
  float wS = ((W * (A * W + C * B) + D * E) / (W * (A * W + B) + D * F)) - E / F;
  float c = ((x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F)) - E / F;
  float p = pow(clamp(c / wS, 0.0, 1.0), 0.4545);
  // the grade's gouache S, so the toe lands where it really lands
  return mix(p, p * p * (3.0 - 2.0 * p), 0.34);
}
float vcPaperMidScene(float l, float exposure) {
  return vcPaperWindow(vcSceneDisplay(l, exposure));
}

// --------------------------------------------- a world UV that cannot collapse
// 'wp.xz + wp.y * k' — the shorthand used by the wet edge, the boundary-width
// field and the paper tooth — adds a scalar built from ONE axis to BOTH
// components of a vec2. On any vertical surface x and z are then locked
// together with y, so the field is CONSTANT along (1,-1) and every flat wall in
// frame carries a 45-degree ruling whose screen angle is whatever that wall's
// yaw happens to be.
//
// Measured on the round-4 firefight frame, 18-bin orientation power over 3-16 px
// periods: bridge spandrel peaked at 10-20 deg (3.3:1), stucco wall at 0-10
// (5.8:1), lit hillside at 160-170 (2.8:1), hero torso at 80-90 (3.0:1) — seven
// surfaces, seven different peak decades. Grain that rotates with the object is
// a UV stripe, not a sheet, and it is the whole of the 'paper' axis's
// inconsistency between shots.
//
// Project onto the plane the surface actually faces instead. The axis choice
// only flips across a 45-degree normal change, which on this geometry is a
// wall corner or an eave — i.e. somewhere an ink line already runs.
vec2 vcSurfUV(vec3 wp, vec3 wn) {
  vec3 a = abs(wn);
  if (a.y >= a.x && a.y >= a.z) return wp.xz;
  if (a.x >= a.z) return wp.zy + 37.13;
  return wp.xy + 71.91;
}

vec3 vcRgb2Hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)), d / (q.x + 1e-10), q.x);
}
vec3 vcHsv2Rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

// SHADE IS COOL — but shade is still the SAME PIGMENT.
//
// Round 3 implemented "cool" as a channel floor: b = max(b, r * 1.46). On a
// warm pigment that is a reasonable violet-brown, but the rule is stated in
// terms of RED, and on anything that is not red-dominant it is a hue
// REPLACEMENT rather than a shift. Measured consequences on the round-3 frames:
//   * grass, albedo hue 81 deg, came out of shade at hue 195 — a 114 deg
//     rotation, i.e. a saturated TEAL patch sitting next to green grass;
//   * the Edelweiss's near-neutral sage armour (0xaeb5a6, saturation 0.08) has
//     essentially no red to lead, so b = 1.46r turned a grey-green plate into
//     saturated blue-violet and every tank in frame measured hue 240-260.
// Both are the artefact commit 1cf9cbc removed, arriving by a different route.
//
// So the cool move is now a BOUNDED HUE TURN toward 235 deg along the shorter
// arc, capped at VC_COOL_TURN, plus a small chroma drop; luminance is preserved
// exactly, so cooling a wash still can never brighten it. The cap is the whole
// point: a shaded surface has to land within ~40 deg of its own lit hue, which
// is what makes it read as the same material in shadow instead of a different
// material painted next to it.
//
// A near-NEUTRAL pigment has no hue to turn — a limestone parapet or a
// grey-green hull would come out of the rotation unchanged — so those get the
// skylight as a gentle RGB lean instead. It is deliberately weak: this is the
// path that used to produce lavender masonry.
//
// The amt argument is the blend, driven by band index at the call site so only
// the bottom one or two washes are cooled.
#define VC_COOL_TURN 0.058          // 21 degrees, the whole budget for one call
vec3 vcCoolShade(vec3 c, float amt) {
  amt = clamp(amt, 0.0, 1.0);
  if (amt <= 0.001) return c;
  float l = vcLum(c);
  vec3 hsv = vcRgb2Hsv(c);
  float dh = 0.6528 - hsv.x;        // 235 deg: blue-violet, the skylight hue
  dh -= floor(dh + 0.5);            // shortest signed arc, -0.5 .. 0.5
  hsv.x = fract(hsv.x + clamp(dh, -VC_COOL_TURN, VC_COOL_TURN) * amt);
  hsv.y *= mix(1.0, 0.90, amt);     // pigment in shade reads LESS chromatic
  vec3 t = vcHsv2Rgb(hsv);
  float neutral = 1.0 - smoothstep(0.03, 0.14, hsv.y);
  t *= mix(vec3(1.0), vec3(0.950, 0.984, 1.082), neutral * amt);
  t *= l / max(vcLum(t), 1e-5);
  return t;
}

// Shade is not a darker copy of the lit colour and it is certainly not grey. It
// is the SAME pigment, darkened, lit only by the violet-blue sky — so it keeps
// its own hue, cools, and is floored so nothing in frame hits black.
//
// An early build rotated the hue all the way to 265 deg, and that is the single
// worst thing you can do to a warm palette: the shortest arc from ochre (30
// deg) to violet-blue runs BACKWARDS through red into magenta, so every ochre
// field, every brick wall and every straw roof turned lavender in shade and the
// whole frame went purple. What went wrong there was the SIZE of the rotation,
// not the idea — vcCoolShade above now caps it at 21 deg, which lands ochre on
// a burnt red-brown rather than on lavender. The bulk of the work is still done
// by a MULTIPLY plus a small ADD, which gives the right answer for free:
//   * a warm pigment lands on a low-chroma brown-violet,
//   * a green/sage pigment lands on desaturated violet-grey,
// which is exactly the two behaviours the CANVAS palette wants. vcCoolShade
// then guarantees the last step the multiply cannot: blue ahead of red.
vec3 vcShadowColour(vec3 albedo, vec3 violet, vec3 floorCol) {
  float l = vcLum(albedo);
  vec3 tint = violet / max(vcLum(violet), 1e-4);   // unit-luminance skylight

  // Value drop with only a LIGHT pull toward the pigment's own grey. Round 3
  // mixed 40% to grey and then rotated the residue onto blue, so almost nothing
  // that came out the far end was still the pigment: that is the arithmetic
  // that turned a green field into a teal patch. 0.22 keeps the hue identifiable
  // while still reading less chromatic than the lit wash, which is what shade
  // actually does.
  vec3 c = mix(albedo, vec3(l), 0.22) * 0.36;
  // multiplicative skylight: cools without moving the hue much
  c *= mix(vec3(1.0), tint, 0.30);
  // a whisper of ADDITIVE skylight, and a whisper is all it may be — additive
  // light does not respect the pigment's hue at all, so it is the term that
  // replaces rather than shifts. Halved from round 3.
  c += violet * 0.026 * (0.40 + 0.60 * l);

  // Never darker than the floor — but the floor may not REPLACE the pigment.
  // max(c, violetConstant) is a per-channel operation, so on anything dark it
  // simply becomes that violet: the Edelweiss's track-guard underside measured
  // hue 277 against sage-green paint at hue 90, and every deep shadow in frame
  // arrived at the same lavender whatever was in it. Lift the VALUE to the floor
  // and lean the hue only an eighth of the way there.
  float fl = vcLum(floorCol) * (0.40 + 0.60 * l);
  c *= max(1.0, fl / max(vcLum(c), 1e-5));
  vec3 fTint = floorCol / max(vcLum(floorCol), 1e-4);
  c = mix(c, vec3(vcLum(c)) * fTint, 0.13);

  // and finally the bounded cool turn. NOT at full strength: this colour is
  // handed to the band ramp and then passed through vcCoolShade a second time
  // on the composite, and two full turns is a 42 deg rotation, i.e. the
  // replacement this function exists to avoid.
  return vcCoolShade(c, 0.85);
}

// The other half of the rule. Lit pigment must stay the SAME pigment — brighter,
// a touch warmer, barely less saturated. Mixing toward neutral cream is what
// turns sage grass into khaki and an olive field into a desert, so the lift is
// done in HSV and only a whisper of paper white is added on top.
vec3 vcLitColour(vec3 albedo, vec3 cream) {
  vec3 hsv = vcRgb2Hsv(albedo);
  float target = 0.105;                       // ~38 deg, straw / low sun
  float dh = target - hsv.x;
  dh -= floor(dh + 0.5);

  // GREENS ARE EXEMPT from the STRAW lean. Gallia is green countryside; a sage
  // field leaned 13% toward straw and then given a whisper of cream comes out
  // the far end of the grade with RED AHEAD OF GREEN, which is the loudest
  // palette failure on offer. Ochre, brick and stucco keep the full lean — it
  // is what makes them read as sunlit rather than merely bright.
  float dg = hsv.x - 0.26;                    // ~94 deg, pasture green
  float guard = 1.0 - exp(-dg * dg / 0.0045) * 0.88;

  hsv.x = fract(hsv.x + dh * 0.115 * guard);
  // ...but they are NOT exempt from sun-bleaching, and round 4 had that
  // backwards. This line used to read mix(1.16, 0.985, guard), i.e. a +12%
  // CHROMA BOOST on the pasture lobe, put in to survive the grade's foliage
  // desaturation. The grade no longer desaturates that lobe — it raises chroma
  // frame-wide at uSatGamma 0.73 — so the boost stacked on top of it and the
  // hillside that owns the bottom-right third of 'firefight' measured HSV sat
  // 0.44-0.47 at hue 86-92: an acid paint-bucket wash. A field in full sun is
  // the LEAST chromatic it ever gets; the chroma lives in the half-tone.
  hsv.y *= mix(0.86, 0.985, guard);
  hsv.z = min(1.0, hsv.z * 1.36 + 0.10);

  // CHROMA CEILING on the brick/pantile end of the wheel. That end is the one
  // that runs away: the value lift above is applied at constant saturation and
  // the grade then boosts saturation AND value again for hues near 34 deg, so a
  // pantile authored at 0.55 arrived on screen at HSV sat 0.60 / val 0.91 — the
  // highest-chroma, highest-value object in every frame, with the rest of the
  // palette sitting between 0.09 and 0.40. Ceiling that end and leave the
  // sage/olive end alone; it is already the quietest thing in the frame, and
  // desaturating it is what tips RED above GREEN on a lit field.
  float dO = hsv.x - 0.055;                   // ~20 deg, brick / pantile
  dO -= floor(dO + 0.5);
  float hot = exp(-dO * dO / 0.0035);
  // ROUND 24 - the brick/pantile ceiling was cutting chroma AND value on the
  // one hue the real game is loudest in: terracotta roof tile.
  hsv.y = min(hsv.y, mix(0.72, 0.62, hot));

  return mix(vcHsv2Rgb(hsv), cream, 0.014 + 0.050 * guard);
}

// ------------------------------------------------------------ SAGE AND OLIVE
// Round 3 killed a sepia duotone by pushing chroma back into the greens. Round 4
// overshot: 'firefight' measured 41.3% of the frame inside hue 80-160 with the
// 80-100 decade alone holding 25.8% (40.2% on 'grass'), lit patches at
// saturation 0.41-0.47, and a 300 px transect across the hillside that was one
// flat fill. Valkyria's countryside is not that colour and, more importantly,
// is not ONE colour: a pasture there is a dozen related sages and olives —
// yellow-leaning, low chroma, with the drier crowns a whole value above the
// hollows.
//
// So this is a three-part move applied to the GREEN LOBE ONLY, before shading:
//   * a chroma CEILING, so no amount of albedo authoring or grade gain can put
//     a field back into acid;
//   * a hue pull off pure 90 deg toward ~80, i.e. yellow-green rather than
//     kelly;
//   * and the part that actually matters pictorially — hue, chroma AND value
//     SPREAD driven by two world-space fields, so a hillside is painted in
//     patches instead of poured out of a bucket. 'macro' should be a tens-of-
//     metres field and 'fine' a metres-scale one; both are 0..1 about 0.5.
//
// Everything off the green lobe is returned untouched, so ochre roads, stucco,
// skin and pantile cannot be reached by any of it.
vec3 vcPasture(vec3 c, float macro, float fine, float amt) {
  if (amt <= 0.001) return c;
  vec3 hsv = vcRgb2Hsv(c);
  // A PLATEAU, not a gaussian. The first build used exp(-d*d/0.0042) about
  // 92 deg, i.e. a 16.5-degree sigma — and the whole point of the function is
  // to move pigment DOWN to 72-80 deg, so every green it had already corrected
  // evaluated at g = 0.5-0.6 and got a chroma ceiling of 0.58-0.68 instead of
  // the 0.34 the code said. Measured consequence: dropping the written ceiling
  // from 0.50 to 0.42 to 0.36 moved the grass shot's lit saturation by 0.005.
  // Flat across the whole pasture band and falling away outside it.
  float d = hsv.x - 0.230;                    // ~83 deg, centre of the band
  d -= floor(d + 0.5);
  //  full  56-110 deg   zero outside 34-132
  float g = amt * (1.0 - smoothstep(0.075, 0.135, abs(d)));
  if (g < 0.004) return c;

  // THE FIELDS HAVE TO BE STRETCHED FIRST. Every caller feeds this an fbm of
  // value noise, and that distribution clusters hard around 0.5: measured on
  // the terrain's own macro field, (macro - 0.5) is a +/-0.10 excursion, not a
  // +/-0.5 one. The first build of this function spread hue by a nominal
  // +/-17 deg and moved the frame's green hue sd by 0.5 degrees, because it was
  // really spreading by +/-3.4.
  float m = clamp((macro - 0.5) * 2.6, -0.5, 0.5);
  float f = clamp((fine - 0.5) * 2.6, -0.5, 0.5);

  // Yellow-green, not kelly — and DELIBERATELY LOW, at 72 deg. The grade's
  // green-lift warp (canvasRenderPipeline uGreenLift 0.084 over a 55-130 deg
  // lobe) is strongly compressive at this end: it maps an input of 60 deg to
  // 90, 80 to 106 and 100 to 113, i.e. d(out)/d(in) falls to 0.31 across the
  // pasture band. Anything authored between 55 and 90 arrives on screen inside
  // ONE 20-degree bin no matter how it was spread, which is most of why the
  // 80-100 decade holds a quarter of these frames.
  hsv.x = mix(hsv.x, 0.2111, 0.55 * g);       // 76 deg

  // So the spread is deliberately wider than the look needs: +/-27 deg at the
  // mass scale, so that after the grade's compression what is left is still
  // 50-113 rather than 90-110. Pictorially this is the dry crown / lush hollow
  // patchwork a real pasture has — chroma and value follow the same fields,
  // with opposite signs on the fine octave, so a bleached crown is both lighter
  // and greyer than the hollow beside it.
  // ...and the spread is SKEWED to the yellow side. A symmetric one puts the
  // top of its excursion at 110 deg, the grade's warp carries that to 116, and
  // the shade cool turn takes the shadowed half of it past 130: measured as a
  // 9.5% band at hue 140-160 on firefight, i.e. a mint-green hillside, which
  // is the same failure as acid green with the sign flipped. A pasture varies
  // toward STRAW, not toward teal.
  float hx = hsv.x + (m * (m < 0.0 ? 0.190 : 0.105) + f * 0.045) * g;
  // ...and the tail is CLAMPED into the band the grade's lift warp actually
  // covers. That warp is zero below 55 deg, so a pasture pixel spread down to
  // 42 stays at 42 and arrives as bare earth: measured on overview, an
  // unclamped -34 deg tail moved 15% of the frame out of hue 80-120 and into
  // 20-60, taking the best 55-degree wedge from 48.7% to 56.6% — trading acid
  // green for the warm duotone round 3 removed. 55-108 deg is the safe band.
  hsv.x = fract(mix(hx, clamp(hx, 0.1528, 0.3000), g));
  hsv.y = clamp(hsv.y * (1.0 + (m * 0.34 - f * 0.44) * g), 0.0, 1.0);
  hsv.z = clamp(hsv.z * (1.0 + (m * 0.30 + f * 0.34) * g), 0.0, 4.0);

  // The chroma CEILING goes on LAST. Applied before the spread — as it was
  // first written — the spread's +30% excursion simply walked back over it and
  // the grass shot measured lit saturation 0.433, i.e. HIGHER than the
  // 0.411 it started at. A ceiling that anything downstream of it can raise is
  // not a ceiling.
  //
  // 0.34 LINEAR is ~0.18 display here, and the grade turns that back into ~0.33
  // on screen: it raises chroma with a gamma (uSatGamma 0.73, so 0.23 -> 0.34)
  // and then adds another 22% on the pasture lobe specifically (uGreenChroma).
  // The number that has to land under the 0.34 target is the one after all of
  // that, so this one has to be authored well below it.
  // ROUND 24 - 0.34 -> 0.62. The green lobe was capped so hard that every
  // pasture, canopy and hedge collapsed to the same sage. The real game's
  // greens are strong (docs/reference/vc-072.jpg, vc-088.jpg).
  hsv.y = min(hsv.y, mix(1.0, 0.62, g));
  return vcHsv2Rgb(hsv);
}
`;

// ----------------------------------------------------- band quantisation
export const GLSL_BANDS = /* glsl */`
// Quantise a 0..1 light term into "bands" flat steps whose boundary WANDERS.
//
// This is the single defining feature of the CANVAS engine, and round 1 did not
// have it: a critic scanned a terrain shadow ramp and measured
// 83,77,79,82,93,106,119,118,121,106,123,133,149,157,164 — a continuous 80->164
// gradient with ZERO plateaus. Two bugs produced that, and both are fixed here.
//
//  1. The feathered zone was up to 0.30 of a band wide. Feather a boundary that
//     hard and you have simply rebuilt the smooth ramp you were quantising. The
//     smoothstep is now 0.024..0.076 of a band — a genuinely HARD edge, so the
//     plateau between two boundaries is genuinely FLAT.
//  2. The irregularity was a per-pixel SHIFT inside the smoothstep, fed from
//     a high-frequency field, which dissolves the edge into noise. It is now a
//     warp of the band COORDINATE applied BEFORE the floor, so the whole
//     boundary moves bodily off the geometric iso-line. Feed n2 a LOW
//     frequency field (30-60 screen px lobes) and the terminator creeps like
//     pigment into damp cold-press; feed it a high frequency one and you get
//     dissolve, which is wrong.
//
//   n1    boundary WIDTH noise 0..1 — some edges are crisp, some feathered
//   n2    boundary WARP  noise 0..1 (0.5 = no shift), scaled by bleed in
//         units of one band
//
// Returns: x = banded value, y = wet-edge pooling (pigment runs to the rim of a
// drying wash and dries darker there — it lives ONLY at the boundary, so it
// cannot leak back into the plateau).
vec2 vcQuantiseBands(float lightTerm, float bands, float bleed, float n1, float n2) {
  float t = clamp(lightTerm, 0.0, 1.0) * bands + (n2 - 0.5) * bleed * 1.15;
  float fi = floor(t);
  float fr = t - fi;
  float w = clamp(0.012 + 0.026 * n1, 0.010, 0.038);
  float e = smoothstep(0.5 - w, 0.5 + w, fr);
  float banded = clamp((fi + e) / bands, 0.0, 1.0);
  float pool = 1.0 - smoothstep(0.0, 0.085, abs(fr - 0.5));
  return vec2(banded, pool);
}

// The wet-edge warp field to feed vcQuantiseBands as n2, in 0..1 about 0.5.
//
// Sampling this in pure WORLD space is what killed round 1 on characters: the
// field ran at 0.62 cycles/m, so a 0.22 m head traversed 0.14 of a cycle, the
// warp degenerated to a constant DC offset and no boundary wandered anywhere on
// a face. Sampling it in pure SCREEN space instead makes the terminator crawl
// across the geometry whenever the camera moves, which reads as a filter.
//
// So the FREQUENCY comes from the on-screen size of a metre at this depth —
// ~46 px lobes on a hillside 60 m away and on a cheek 1.5 m away alike — while
// the PHASE stays world-locked, so the edge sits still when the camera does.
//   mPerPx : metres per CSS pixel here, i.e. viewDepth * uProjScale
//   fibre  : a cold-press paper fetch, for tooth on the edge itself
// ------------------------------------------------------ pigment quantisation
// The second quantiser, and the one round 2 was missing.
//
// vcQuantiseBands above quantises the LIGHT term, which is right — but every
// scrap of tonal variation that arrives AFTER it (albedo maps, per-vertex
// colour, ground detail, aerial perspective, rim light, a curved thigh) then
// rides over the top of those plateaus unquantised. That is precisely what the
// round-2 critics measured: a tank road ramping 122->82 over 300 px inside one
// shade mass, and a hero's thigh running 99,100,103,100,96,88 across its width.
// The wet-edge machinery was real code doing nothing visible because nothing
// visible was going through it.
//
// So: after the wash is composited, quantise its LUMINANCE too, in a perceptual
// space (a linear quantiser puts all its steps in the highlights), with the same
// wandering boundary, and scale the colour onto the result. Hue and saturation
// are untouched — this only forces value onto steps.
//
//   col    composited colour
//   lv     levels across the 0..1 perceptual range
//   n1,n2  the same boundary width / warp fields the light quantiser uses
//   amt    0..1 blend, so a material can opt out
//   warp   how far, in LEVELS, n2 may drag the boundary
//
// WHY 'warp' IS A PARAMETER AND NOT THE OLD HARD-CODED 1.05. The warp field has
// ~46 px lobes. On a hillside that is a boundary creeping through pigment; on a
// 40 px torso it is a whole level of displacement applied nearly uniformly
// across the entire object, which slides every boundary clean off it. That is
// exactly what four rounds of critics have measured — "focal figure y=395
// x786-816 -> 1 plateau, 1 level; x=804 y380-428 -> ZERO plateaus" — while the
// terrain in the same frame quantised correctly off the same code. A small
// object needs a short leash.
vec3 vcQuantisePigment(vec3 col, float lv, float n1, float n2, float amt, float warp) {
  float y = max(vcLum(col), 1e-5);
  float p = pow(min(y, 4.0), 0.4545);
  float t = p * lv + (n2 - 0.5) * warp;
  float fi = floor(t);
  float fr = t - fi;
  float w = clamp(0.020 + 0.045 * n1, 0.014, 0.075);
  float q = (fi + smoothstep(0.5 - w, 0.5 + w, fr)) / lv;
  float ly = pow(max(q, 0.0), 2.2);
  return col * mix(1.0, ly / y, clamp(amt, 0.0, 1.0));
}

float vcWetEdge(vec3 wp, vec3 wn, float mPerPx, float fibre) {
  float f = 1.0 / max(mPerPx * 46.0, 1e-5);          // cycles per metre
  // vcSurfUV, not 'wp.xz + wp.y * k': see the note there. The old form made the
  // wet edge a 45-degree ruling on every vertical surface in frame.
  vec2 q = vcSurfUV(wp, wn) * f;
  // fbm of value noise clusters hard around 0.5; stretch it or the boundary
  // barely leaves the iso-line
  float a = clamp((vcFbm2(q) - 0.5) * 2.1 + 0.5, 0.0, 1.0);
  float b = vcNoise2(q * 0.38 + 19.3);               // ~120 px swell
  return 0.5 + (a - 0.5) * 0.72 + (b - 0.5) * 0.46 + (fibre - 0.5) * 0.22;
}
`;

// ------------------------------------------------------------ pencil hatch
export const GLSL_HATCH = /* glsl */`
// One field of hand-drawn parallel strokes.
//   px      : SCREEN pixels (divide by pixel ratio before calling, so strokes
//             are the same physical width on a retina panel)
//   ang     : stroke direction, radians — a NOMINAL angle, drifted below
//   spacing : nominal pixels between stroke centres, also drifted
//
// Round 1 scored 1-4 on this axis and the reason is visible in the old code: a
// fixed angle, a fixed spacing and a soft pressure fade produced a machine-
// regular unidirectional screen at a constant ~7 px period. That is a printed
// halftone, not graphite. Three things separate the two, and all three are here:
//
//   * the hand does not hold one angle or one spacing across a passage — both
//     drift under a very low frequency field, so the ruling is never parallel
//     for more than a few strokes,
//   * stroke WIDTH is specified in PIXELS and divided by the (drifted) spacing,
//     so line weight is constant regardless of depth, zoom or spacing jitter,
//   * a real stroke LIFTS OFF the paper — it breaks, it does not fade. The
//     pressure envelope is thresholded, not smoothed, so strokes are broken.
float vcHatchField(vec2 px, float ang, float spacing, float seed) {
  // ~300 px drift lobes: the ruling wanders a couple of degrees at a time
  ang += (vcNoise2(px * 0.0034 + seed * 3.1) - 0.5) * 0.34;
  spacing *= 1.0 + (vcNoise2(px * 0.0021 + seed * 7.7 + 53.0) - 0.5) * 0.34;

  float ca = cos(ang), sa = sin(ang);
  vec2 dir = vec2(ca, sa);
  vec2 nrm = vec2(-sa, ca);
  float along = dot(px, dir);
  float across = dot(px, nrm) / spacing;

  float si = floor(across);
  float r = vcHash21(vec2(si, seed));

  // lateral wander: the hand does not draw straight lines
  float wander = (vcNoise2(vec2(along * 0.016, si * 3.31 + seed)) - 0.5) * 0.62
               + (vcNoise2(vec2(along * 0.058, si * 9.11 + seed)) - 0.5) * 0.16;

  float x = fract(across + wander) - 0.5;
  // constant stroke width in SCREEN PIXELS: spacing cancels out of the ratio
  float wpx = 1.00 + 0.85 * r;
  float w = wpx / max(spacing, 1e-3);
  float line = 1.0 - smoothstep(w * 0.5, w * 1.0, abs(x));

  // pressure along the stroke, with genuine lift-off rather than a fade
  float press = vcFbm2(vec2(along * 0.0125, si * 7.13 + seed * 0.7));
  float lift = smoothstep(0.33, 0.47, press);
  // per-stroke pressure: some strokes are laid in harder than others
  float amp = mix(0.52, 1.0, vcHash21(vec2(si, seed + 19.0)));
  // and the hand's weight drifts across the whole passage, so a bank of strokes
  // is never one flat density — this is the term whose absence made an
  // autocorrelation of a shadow row decay monotonically, i.e. read as a screen
  amp *= mix(0.58, 1.18, vcFbm2(px * 0.020 + seed * 11.3));

  return line * lift * amp;
}
`;

// --------------------------------------------------------- paper tooth
export const GLSL_TOOTH = /* glsl */`
// A gradient of world-space fibre noise, used to nudge shading normals so a
// perfectly flat wall still shows pigment sitting unevenly on the tooth.
//
// This was the loudest of the 'wp.xz + wp.y * k' collapses (see vcSurfUV): the
// field was a 2D noise whose coordinate had y folded into BOTH components, and
// its gradient is what perturbs the shading normal — so every flat surface in
// frame got a shading ripple running along a single world diagonal, projected
// to a different screen angle on every object. A genuinely 3D field has no
// such axis anywhere, and the gradient is the honest three-component one.
float vcToothFbm3d(vec3 p) {              // 2 octaves; the third is invisible
  float s = vcNoise3(p) * 0.6667;         // once this is only nudging a normal
  s += vcNoise3(p * 2.03 + 11.3) * 0.3333;
  return s;
}
// IT ALSO HAS TO BE BAND-LIMITED, and round 6 was not.
//
// This field lives in WORLD space at a fixed scale, and it perturbs a SHADING
// normal — so its screen frequency rises without bound as a surface turns away
// from the camera, and there is no mip chain to catch it because it is
// procedural. On a ground plane running to the horizon the finest octave passes
// Nyquist a few metres out and folds back as a coherent beat, compressed in y
// by the same perspective that compressed the field: a horizontal ruling.
//
// Measured on the round-6 closeup, windowed 2D FFT of the 1.5-4 px band over
// the lit road patch (250,620,128x128): angular power concentrated in ONE of 36
// bins, dominant 85 deg, with the vertical 1D spectrum a broad hump at 5-7 px —
// exactly a world-space field aliasing on a receding plane, on the brightest
// surface in the frame, where axis 4 says the sheet must be invisible.
//
// fwidth(wp) is the world-space footprint of one screen pixel, so it knows
// about the compression directly — including the fact that on a grazing plane
// the footprint is enormous along one axis and tiny along the other. Fade the
// whole term out once the field's own period drops under about two and a half
// pixels. Everything the camera can actually resolve is untouched.
vec3 vcToothGradient(vec3 wp, float scale) {
  vec3 q = wp * scale;
  const float e = 0.21;
  vec3 fw = fwidth(wp);
  float wpp = max(max(fw.x, fw.y), fw.z);       // world units per screen pixel
  float fade = 1.0 - smoothstep(0.22, 0.72, wpp * scale);
  if (fade <= 0.002) return vec3(0.0);
  float n0 = vcToothFbm3d(q);
  float nx = vcToothFbm3d(q + vec3(e, 0.0, 0.0));
  float ny = vcToothFbm3d(q + vec3(0.0, e, 0.0));
  float nz = vcToothFbm3d(q + vec3(0.0, 0.0, e));
  return vec3(nx - n0, ny - n0, nz - n0) * (fade / e);
}
`;

// -------------------------------------------------------------- tonemapping
export const GLSL_TONEMAP = /* glsl */`
// A filmic curve deliberately detuned from ACES: the shoulder rolls into a
// CREAM white point rather than pure white, and the toe lifts so the darkest
// value in frame lands on a warm brown-violet instead of crushing to zero.
vec3 vcCanvasTonemap(vec3 x, float exposure, vec3 paperWhite, vec3 inkBlack, float contrast) {
  x = max(x, vec3(0.0)) * exposure;
  // Hable-ish shoulder with a softened toe.
  const float A = 0.22, B = 0.30, C = 0.10, D = 0.20, E = 0.018, F = 0.30;
  vec3 c = ((x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F)) - E / F;
  // A LOW white point (not the film-standard 11.2). Our scene values live in
  // 0..1.8, and a curve built for an 11-stop HDR range compresses that into a
  // narrow grey wedge — which is exactly how a stylised frame turns to mud.
  // 2.45 rather than 2.05 buys ~20% more highlight headroom, which is what
  // keeps a bright sky graded instead of clipping to one flat cream slab; the
  // 1.10 pre-gain at the call site puts the midtones back where they were.
  const float W = 2.45;
  float wS = ((W * (A * W + C * B) + D * E) / (W * (A * W + B) + D * F)) - E / F;
  c = clamp(c / wS, 0.0, 1.0);

  // Gouache S-curve, in a PERCEPTUAL space (an S applied to linear values
  // crushes the shadow end into mud). This runs BEFORE the ink-floor lift so
  // the floor still holds afterwards. Without it a banded NPR frame reads flat:
  // all the values pile into the middle third and no amount of hue work makes
  // that look like paint.
  vec3 p = pow(c, vec3(0.4545));
  p = mix(p, p * p * (3.0 - 2.0 * p), clamp(contrast, 0.0, 1.0));
  c = pow(p, vec3(2.2));

  // Lift the floor to a warm brown-violet, but let the CREAM white point arrive
  // only near the top of the range. Applying it flat would drag every midtone
  // toward the same sepia and kill the sage/teal half of the palette.
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  vec3 top = mix(vec3(1.0), paperWhite, smoothstep(0.45, 1.0, l));
  return inkBlack * (1.0 - c) + c * top;
}
`;

// The complete common preamble every NPR surface shader wants.
export const GLSL_NPR_COMMON =
  GLSL_HASH + GLSL_NOISE + GLSL_COLOR + GLSL_BANDS + GLSL_HATCH + GLSL_TOOTH;

// ------------------------------------------------------------ fullscreen
export const FS_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;
