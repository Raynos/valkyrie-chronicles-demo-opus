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

// The single most important colour rule of the CANVAS look: shade is not a
// darker copy of the lit colour and it is certainly not grey. It is the SAME
// pigment dragged most of the way round the wheel toward violet-blue, kept
// saturated, and floored at a warm brown-violet so nothing ever reaches black.
vec3 vcShadowColour(vec3 albedo, vec3 violet, vec3 floorCol) {
  vec3 hsv = vcRgb2Hsv(albedo);
  float target = 0.735;                       // ~265 deg, violet-blue
  float dh = target - hsv.x;
  dh -= floor(dh + 0.5);                      // shortest arc round the wheel
  // A warm pigment takes the short arc BACKWARDS through magenta, which lands
  // on pink and still reads warm. Push those further so a brick wall's shade is
  // genuinely purple rather than a paler brick.
  float warmth = 1.0 - smoothstep(0.14, 0.46, min(hsv.x, 1.0 - hsv.x));
  hsv.x = fract(hsv.x + dh * mix(0.46, 0.62, warmth));
  hsv.y = clamp(hsv.y * 0.80 + 0.17, 0.0, 0.88);
  hsv.z = hsv.z * 0.33 + 0.032;
  vec3 c = vcHsv2Rgb(hsv);
  c = mix(c, violet * (0.35 + 0.9 * vcLum(c)), 0.38);
  // never darker than the warm brown-violet floor, scaled by how dark the
  // pigment itself is (a black boot still reads darker than a cream wall)
  return max(c, floorCol * (0.42 + 0.58 * vcLum(albedo)));
}

// The other half of the rule. Lit pigment must stay the SAME pigment — brighter,
// a touch warmer, slightly less saturated. Mixing toward neutral cream is what
// turns sage grass into khaki and an olive field into a desert, so the lift is
// done in HSV and only a whisper of paper white is added on top.
vec3 vcLitColour(vec3 albedo, vec3 cream) {
  vec3 hsv = vcRgb2Hsv(albedo);
  float target = 0.105;                       // ~38 deg, straw / low sun
  float dh = target - hsv.x;
  dh -= floor(dh + 0.5);
  hsv.x = fract(hsv.x + dh * 0.26);
  hsv.y *= 0.84;
  hsv.z = min(1.0, hsv.z * 1.42 + 0.11);
  return mix(vcHsv2Rgb(hsv), cream, 0.14);
}
`;

// ----------------------------------------------------- band quantisation
export const GLSL_BANDS = /* glsl */`
// Quantise a 0..1 light term into "bands" steps, but let the boundary BLEED.
// n1 modulates how wide the wet edge is (some boundaries are crisp, some are
// a centimetre of feathered pigment) and n2 pushes the boundary back and forth
// so it never follows the geometric iso-line. That irregularity is the tell.
//
// Returns: x = banded value, y = wet-edge pooling amount (pigment runs to the
// rim of a drying wash and dries darker there).
vec2 vcQuantiseBands(float lightTerm, float bands, float bleed, float n1, float n2) {
  float t = clamp(lightTerm, 0.0, 1.0) * bands;
  float fi = floor(t);
  float fr = t - fi;
  // Keep the feathered zone NARROW — a wide one just reconstructs the smooth
  // gradient we were trying to destroy. The irregularity comes from the shift
  // term dragging the boundary off the geometric iso-line, not from softness.
  float w = clamp(bleed * (0.02 + 0.22 * n1 * n1), 0.010, 0.30);
  float shift = (n2 - 0.5) * (w * 1.5 + 0.30);
  float e = smoothstep(0.5 - w, 0.5 + w, fr + shift);
  float banded = (fi + e) / bands;
  float pool = 1.0 - abs(e * 2.0 - 1.0);
  pool *= smoothstep(0.02, 0.14, w);
  return vec2(banded, pool);
}
`;

// ------------------------------------------------------------ pencil hatch
export const GLSL_HATCH = /* glsl */`
// One field of hand-drawn parallel strokes.
//   px      : SCREEN pixels (divide by pixel ratio before calling, so strokes
//             are the same physical width on a retina panel)
//   ang     : stroke direction, radians
//   spacing : pixels between stroke centres
// Stroke index drives per-stroke width/pressure; a slow noise along the stroke
// makes it wander and lift off the paper, which is what separates "drawn" from
// "printed". Frequency is pixel-locked so zooming never changes line weight.
float vcHatchField(vec2 px, float ang, float spacing, float seed) {
  float ca = cos(ang), sa = sin(ang);
  vec2 dir = vec2(ca, sa);
  vec2 nrm = vec2(-sa, ca);
  float along = dot(px, dir);
  float across = dot(px, nrm) / spacing;

  float si = floor(across);
  float r = vcHash21(vec2(si, seed));

  // lateral wander: the hand does not draw straight lines
  float wander = (vcNoise2(vec2(along * 0.017, si * 3.31 + seed)) - 0.5) * 0.66
               + (vcNoise2(vec2(along * 0.061, si * 9.11 + seed)) - 0.5) * 0.18;

  float x = fract(across + wander) - 0.5;
  float w = 0.15 + 0.21 * r;
  float line = 1.0 - smoothstep(w * 0.5, w * 1.4, abs(x));

  // pressure envelope along the stroke; strokes skip the paper in places
  float press = vcNoise2(vec2(along * 0.0095, si * 7.13 + seed * 0.7));
  press = smoothstep(0.20, 0.80, press);

  return line * mix(0.28, 1.0, press);
}
`;

// --------------------------------------------------------- paper tooth
export const GLSL_TOOTH = /* glsl */`
// A gradient of world-space fibre noise, used to nudge shading normals so a
// perfectly flat wall still shows pigment sitting unevenly on the tooth.
vec3 vcToothGradient(vec3 wp, float scale) {
  vec2 q = wp.xz * scale + wp.y * (scale * 0.71);
  const float e = 0.21;
  float n0 = vcFbm3(q);
  float nx = vcFbm3(q + vec2(e, 0.0));
  float ny = vcFbm3(q + vec2(0.0, e));
  return vec3(nx - n0, (nx + ny - 2.0 * n0) * 0.5, ny - n0) * (1.0 / e);
}
`;

// -------------------------------------------------------------- tonemapping
export const GLSL_TONEMAP = /* glsl */`
// A filmic curve deliberately detuned from ACES: the shoulder rolls into a
// CREAM white point rather than pure white, and the toe lifts so the darkest
// value in frame lands on a warm brown-violet instead of crushing to zero.
vec3 vcCanvasTonemap(vec3 x, float exposure, vec3 paperWhite, vec3 inkBlack) {
  x = max(x, vec3(0.0)) * exposure;
  // Hable-ish shoulder with a softened toe.
  const float A = 0.22, B = 0.30, C = 0.10, D = 0.20, E = 0.018, F = 0.30;
  vec3 c = ((x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F)) - E / F;
  // A LOW white point (~2, not the film-standard 11.2). Our scene values live
  // in 0..1.5, and a curve built for a 11-stop HDR range compresses that into a
  // narrow grey wedge — which is exactly how a stylised frame turns to mud.
  const float W = 2.05;
  float wS = ((W * (A * W + C * B) + D * E) / (W * (A * W + B) + D * F)) - E / F;
  c = clamp(c / wS, 0.0, 1.0);

  // Lift the floor to a warm brown-violet, but let the CREAM white point arrive
  // only near the top of the range. Applying it flat would drag every midtone
  // toward the same sepia and kill the sage/teal half of the palette.
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  vec3 top = mix(vec3(1.0), paperWhite, smoothstep(0.28, 1.0, l));
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
