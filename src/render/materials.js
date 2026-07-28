// src/render/materials.js
// -----------------------------------------------------------------------------
// The CANVAS-engine surface shaders.
//
// Every world/actor mesh uses a material from this file so the whole frame
// shares one pigment vocabulary:
//
//   * Half-Lambert wrap diffuse quantised into CFG.render.bands values, with the
//     band boundary softened by a NOISE-MODULATED smoothstep so the edge bleeds
//     irregularly the way pigment creeps into damp cold-press paper. Boundaries
//     also darken slightly (a drying wash pulls pigment to its rim).
//   * Two-tone temperature grading. Light shifts toward cream; SHADE IS NOT GREY
//     — the albedo hue is rotated ~45% of the way toward violet-blue, kept
//     saturated, and floored at a warm brown-violet so nothing hits black.
//   * Screen-pixel-locked pencil hatching in the two darkest bands, cross-hatched
//     in the darkest, with per-stroke wander/pressure so it reads as drawn.
//   * Cream rim light on the lit side of silhouettes, faint sky rim on the dark.
//   * A world-space paper-tooth normal perturbation so flat surfaces still catch
//     uneven pigment.
//
// Everything is a hand-written THREE.ShaderMaterial with UniformsLib.lights +
// UniformsLib.fog merged in and `lights = true`, rather than onBeforeCompile —
// three recompiles materials whenever the light count or shadow config changes
// and onBeforeCompile patching is fragile across those recompiles.
//
// Each material also carries a matching depth+normal PREPASS VARIANT in
// `material.userData.vcPrepass`, generated from the *same* vertex code, so
// skinning, instancing, wind animation and alpha cutout are all reproduced
// exactly in the G-buffer that the outline pass reads.
// -----------------------------------------------------------------------------

import * as THREE from 'three';
import { CFG } from '../core/config.js';
import { GLSL_NPR_COMMON, GLSL_HASH, GLSL_NOISE } from './shaderLib.js';
import {
  getPaperTexture, getHatchTexture, getBlotchTexture,
  getNoiseTexture, getGroundDetailTexture,
} from './textures.js';

// ---------------------------------------------------------------- palette
// Authored as sRGB hex; three's ColorManagement converts to the linear working
// space on construction, which is what the shaders expect.
export const PALETTE = {
  cream:      new THREE.Color(0xfff2d6),
  warmLight:  new THREE.Color(0xffdfae),
  violet:     new THREE.Color(0x5d5080),
  inkFloor:   new THREE.Color(0x3a2f33),   // the darkest value allowed in frame
  graphite:   new THREE.Color(0x40332e),
  sage:       new THREE.Color(0x8d9670),
  olive:      new THREE.Color(0x6f7a4e),
  ochre:      new THREE.Color(0xb08a4e),
  umber:      new THREE.Color(0x7a5a3a),
  brick:      new THREE.Color(0x9a6250),
  stone:      new THREE.Color(0x9a958a),
  mud:        new THREE.Color(0x5f4a36),
  skyHigh:    new THREE.Color(0x7f9aa8),
  skyLow:     new THREE.Color(0xd8c79c),
  cloudShade: new THREE.Color(0xa9a4ad),
};

// ------------------------------------------------------------ shared state
let SHARED = null;

function shared() {
  if (SHARED) return SHARED;
  SHARED = {
    uTime:       { value: 0 },
    uResolution: { value: new THREE.Vector2(1280, 720) },
    uPixelRatio: { value: 1 },
    uCamPos:     { value: new THREE.Vector3() },
    uSunDirW:    { value: new THREE.Vector3(0.42, 0.74, 0.32).normalize() },
    uSunDirV:    { value: new THREE.Vector3(0, 0, 1) },
    uSunColor:   { value: new THREE.Color(0xffe9c8) },
    uKeyGain:    { value: 0.74 },
    uFillGain:   { value: 0.30 },
    uCream:      { value: PALETTE.cream },
    uViolet:     { value: PALETTE.violet },
    uInkFloor:   { value: PALETTE.inkFloor },
    uGraphite:   { value: PALETTE.graphite },
    // dir.xy (normalised), strength, gust bias
    uWind:       { value: new THREE.Vector4(0.86, 0.51, 1.0, 0.0) },
    uPaperTex:   { value: getPaperTexture() },
    uHatchTex:   { value: getHatchTexture() },
    uBlotchTex:  { value: getBlotchTexture() },
    uNoiseTex:   { value: getNoiseTexture() },
    uFar:        { value: CFG.camera.far },
    // The pipeline publishes its G-buffer here so soft particles can depth-fade
    // against the scene without a second depth resolve. Null until the pipeline
    // exists; the FX shaders fall back to "no fade" in that case.
    uDepthTex:   { value: null },
  };
  return SHARED;
}

// Uniform names that are shared by reference across every material.
const SHARED_KEYS = [
  'uTime', 'uResolution', 'uPixelRatio', 'uCamPos', 'uSunDirW', 'uSunDirV',
  'uSunColor', 'uKeyGain', 'uFillGain', 'uCream', 'uViolet', 'uInkFloor',
  'uGraphite', 'uWind', 'uPaperTex', 'uHatchTex', 'uBlotchTex', 'uNoiseTex', 'uFar',
];

function bindShared(uniforms) {
  const s = shared();
  for (const k of SHARED_KEYS) if (k in uniforms) uniforms[k] = s[k];
  return uniforms;
}

// =========================================================== VERTEX STAGE
// One generator for every surface kind. The prepass variant is produced from
// the identical code path with `prepass:true`, which is the only way animated
// geometry (skinned soldiers, wind-blown grass) can produce a G-buffer that
// actually lines up with the colour pass.

function buildVertex({ prepass = false, wind = false, needNoise = false } = {}) {
  return /* glsl */`
#if defined( VC_SKINNED ) && !defined( USE_SKINNING )
  #define USE_SKINNING
#endif
#if defined( VC_INSTANCED ) && !defined( USE_INSTANCING )
  #define USE_INSTANCING
#endif

#include <common>
#include <batching_pars_vertex>
#include <skinning_pars_vertex>
${prepass ? '' : '#include <shadowmap_pars_vertex>\n#include <fog_pars_vertex>'}

${needNoise ? GLSL_HASH + GLSL_NOISE : ''}

uniform float uTime;
${wind ? 'uniform vec4 uWind;\nuniform float uBladeHeight;\nuniform float uSway;' : ''}

varying vec3 vViewPos;
varying vec3 vViewNormal;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec2 vUvC;
varying vec2 vAux;

#if defined( USE_COLOR_ALPHA ) || defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
  varying vec4 vColorC;
#endif

void main() {

  vUvC = uv;
  vAux = vec2( 0.0 );

  #if defined( USE_COLOR_ALPHA ) || defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
    vColorC = vec4( 1.0 );
    #ifdef USE_COLOR_ALPHA
      vColorC *= color;
    #elif defined( USE_COLOR )
      vColorC.rgb *= color;
    #endif
    #ifdef USE_INSTANCING_COLOR
      vColorC.rgb *= instanceColor.rgb;
    #endif
  #endif

  #include <batching_vertex>
  #include <beginnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>

  vec3 transformed = vec3( position );
  #include <skinning_vertex>

${wind ? WIND_BLOCK : ''}

  #include <defaultnormal_vertex>

  // three's <worldpos_vertex> only fires under a shadow/envmap define; we always
  // need world position for the world-locked pigment fields.
  vec4 worldPosition = vec4( transformed, 1.0 );
  #ifdef USE_BATCHING
    worldPosition = batchingMatrix * worldPosition;
  #endif
  #ifdef USE_INSTANCING
    worldPosition = instanceMatrix * worldPosition;
  #endif
  worldPosition = modelMatrix * worldPosition;
  vWorldPos = worldPosition.xyz;

  vec3 wn = objectNormal;
  #ifdef USE_BATCHING
    wn = mat3( batchingMatrix ) * wn;
  #endif
  #ifdef USE_INSTANCING
    wn = mat3( instanceMatrix ) * wn;
  #endif
  vWorldNormal = normalize( mat3( modelMatrix ) * wn );

  #include <project_vertex>

  vViewPos = mvPosition.xyz;
  vViewNormal = transformedNormal;

${prepass ? '' : '  #include <shadowmap_vertex>\n  #include <fog_vertex>'}
}
`;
}

// Two-frequency gust + per-blade phase. The phase comes from the instance's
// world base position so no extra attribute is required; supply your own
// per-blade variation through instanceColor if you want more.
const WIND_BLOCK = /* glsl */`
  {
    vec3 instBase = vec3( 0.0 );
    #ifdef USE_INSTANCING
      instBase = instanceMatrix[ 3 ].xyz;
    #endif
    vec3 bladeBaseW = ( modelMatrix * vec4( instBase, 1.0 ) ).xyz;

    float phase = vcHash21( bladeBaseW.xz * 3.17 + bladeBaseW.y );
    vec2 wdir = normalize( uWind.xy + vec2( 1e-5, 0.0 ) );
    float travel = dot( bladeBaseW.xz, wdir );

    // slow travelling gust front + a second slower swell + high-freq flutter
    float gust  = sin( uTime * 0.85 - travel * 0.135 + phase * 6.2831 );
    float swell = sin( uTime * 0.29 - travel * 0.048 + phase * 3.1 );
    float flut  = sin( uTime * 5.15 + phase * 21.7 ) * ( 0.55 + 0.45 * gust );

    float amp = ( gust * 0.52 + swell * 0.34 + flut * 0.17 ) * uWind.z * uSway;

    float hN = clamp( position.y / max( uBladeHeight, 1e-3 ), 0.0, 1.0 );
    float bend = hN * hN * ( 1.35 - 0.35 * hN );   // stiff root, loose tip

    transformed.xz += wdir * amp * bend;
    // a leaning blade is shorter in Y — keeps the tip from stretching
    transformed.y -= bend * amp * amp * 0.42;

    objectNormal = normalize( objectNormal + vec3( wdir.x, 0.0, wdir.y ) * amp * bend * 0.55 );

    vAux = vec2( hN, phase );
  }
`;

// ======================================================== NPR FRAGMENT CORE
// Shared by makeCanvasMaterial / makeGrassMaterial / makeTerrainMaterial. The
// caller supplies `albedo`, `alpha` and an optional extra normal perturbation
// before including VC_SHADE_BODY.

const NPR_UNIFORMS_GLSL = /* glsl */`
uniform vec3  uColor;
uniform float uOpacity;
uniform float uBands;
uniform float uBandBleed;
uniform float uWrap;
uniform float uHatch;
uniform float uHatchSpacing;
uniform float uRim;
uniform float uPaper;
uniform float uBlotch;
uniform float uBlotchScale;
uniform float uToothScale;
uniform float uSubsurface;
uniform vec3  uEmissive;
uniform float uEmissiveIntensity;
uniform float uAlphaTest;
uniform float uShadowSoften;

uniform float uTime;
uniform vec2  uResolution;
uniform float uPixelRatio;
uniform float uKeyGain;
uniform float uFillGain;
uniform vec3  uCream;
uniform vec3  uViolet;
uniform vec3  uInkFloor;
uniform vec3  uGraphite;
uniform sampler2D uHatchTex;
uniform sampler2D uBlotchTex;

varying vec3 vViewPos;
varying vec3 vViewNormal;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec2 vUvC;
varying vec2 vAux;

#if defined( USE_COLOR_ALPHA ) || defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
  varying vec4 vColorC;
#endif
`;

// The body. Expects `vec3 albedo`, `float alpha`, `vec3 extraN` in scope.
const NPR_SHADE_BODY = /* glsl */`
  vec3 N = normalize( vViewNormal );
  #ifdef DOUBLE_SIDED
    N *= ( gl_FrontFacing ? 1.0 : -1.0 );
  #endif

  // ---- paper tooth: nudge the shading normal with world-locked fibre noise so
  // a perfectly flat wall still shows pigment sitting unevenly on the sheet.
  vec3 tooth = vcToothGradient( vWorldPos, uToothScale );
  vec3 toothV = ( viewMatrix * vec4( tooth, 0.0 ) ).xyz;
  N = normalize( N + toothV * uPaper * 0.075 + extraN );

  vec3 V = normalize( -vViewPos );

  float shadowMask = getShadowMask();
  // Soften the shadow terminator: a hard shadow map edge fights the band bleed.
  shadowMask = mix( 1.0, shadowMask, clamp( uShadowSoften, 0.0, 1.0 ) );

  // ---- gather light ---------------------------------------------------------
  // The band drive is deliberately NORMALISED rather than physical: a painting
  // does not care that the sun is 2.2 units bright, it cares that the lit side
  // lands in the top band and the shaded side in the bottom one. Intensity and
  // colour still drive the TINT — they just don't get to squash the value range.
  float key = 0.0;
  float keyW = 0.0;
  vec3  keyCol = vec3( 0.0 );
  vec3  primaryL = normalize( vec3( 0.35, 0.6, 0.72 ) );
  float primaryW = 0.0;

  #if NUM_DIR_LIGHTS > 0
  for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {
    vec3 L = directionalLights[ i ].direction;
    float raw = dot( N, L );
    float hl = clamp( ( raw + uWrap ) / ( 1.0 + uWrap ), 0.0, 1.0 );
    float w = vcLum( directionalLights[ i ].color ) + 1e-4;
    key += hl * w * shadowMask;
    keyW += w;
    keyCol += directionalLights[ i ].color * hl;
    if ( w > primaryW ) { primaryW = w; primaryL = L; }
  }
  #endif
  float keyN = keyW > 0.0 ? key / keyW : 0.0;

  vec3 ambientCol = ambientLightColor;
  #if NUM_HEMI_LIGHTS > 0
  for ( int i = 0; i < NUM_HEMI_LIGHTS; i ++ ) {
    float d = 0.5 + 0.5 * dot( N, hemisphereLights[ i ].direction );
    ambientCol += mix( hemisphereLights[ i ].groundColor, hemisphereLights[ i ].skyColor, d );
  }
  #endif

  // Punctual lights (muzzle flash, lamps) push the surface up a band rather
  // than adding a smooth specular-looking pool of light.
  vec3 punct = vec3( 0.0 );
  #if NUM_POINT_LIGHTS > 0
  for ( int i = 0; i < NUM_POINT_LIGHTS; i ++ ) {
    vec3 lv = pointLights[ i ].position - vViewPos;
    float dist = length( lv );
    vec3 L = lv / max( dist, 1e-4 );
    float att = getDistanceAttenuation( dist, pointLights[ i ].distance, pointLights[ i ].decay );
    float hl = clamp( ( dot( N, L ) + 0.4 ) / 1.4, 0.0, 1.0 );
    punct += pointLights[ i ].color * hl * att;
  }
  #endif
  #if NUM_SPOT_LIGHTS > 0
  for ( int i = 0; i < NUM_SPOT_LIGHTS; i ++ ) {
    vec3 lv = spotLights[ i ].position - vViewPos;
    float dist = length( lv );
    vec3 L = lv / max( dist, 1e-4 );
    float cone = getSpotAttenuation( spotLights[ i ].coneCos, spotLights[ i ].penumbraCos, dot( L, spotLights[ i ].direction ) );
    float att = cone * getDistanceAttenuation( dist, spotLights[ i ].distance, spotLights[ i ].decay );
    float hl = clamp( ( dot( N, L ) + 0.4 ) / 1.4, 0.0, 1.0 );
    punct += spotLights[ i ].color * hl * att;
  }
  #endif

  float ambientLum = vcLum( ambientCol );
  keyCol += punct;

  // How much sky this facet can see — the fill gradient that keeps shaded
  // surfaces from flattening into one dead violet slab.
  vec3 upV = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
  float ambTerm = 0.30 + 0.70 * ( dot( N, upV ) * 0.5 + 0.5 );

  float punctN = clamp( vcLum( punct ) * 0.9, 0.0, 1.4 );

  float drive = clamp( keyN * uKeyGain + ambTerm * uFillGain + punctN, 0.0, 1.0 );

  // ---- band quantisation with a bleeding, irregular boundary ---------------
  vec2 bq = vWorldPos.xz + vWorldPos.y * 0.83;
  float n1 = vcFbm3( bq * 0.62 );                      // how WIDE the wet edge is
  float n2 = vcFbm4( bq * 1.85 + 31.7 );               // where the edge actually sits
  // a little paper-locked variation in the *width* only — width does not move
  // the boundary, so this adds tooth without making the bands crawl on camera
  // motion, which would instantly read as a shader effect.
  vec2 sPx = gl_FragCoord.xy / uPixelRatio;
  n1 = mix( n1, vcFbm2( sPx * 0.0072 ), 0.14 );

  vec2 band = vcQuantiseBands( drive, uBands, uBandBleed, n1, n2 );
  float g = band.x;
  float pool = band.y;

  // ---- two-tone temperature grading ---------------------------------------
  vec3 shadeCol = vcShadowColour( albedo, uViolet, uInkFloor );
  vec3 midCol   = albedo * 0.94 + shadeCol * 0.13;
  vec3 litCol   = mix( albedo, uCream, 0.40 ) * 1.16;

  vec3 col = mix( shadeCol, midCol, smoothstep( 0.0, 0.58, g ) );
  col = mix( col, litCol, smoothstep( 0.46, 1.0, g ) );

  vec3 keyTint = keyCol / max( vcLum( keyCol ) + 1e-4, 1e-4 );
  col *= mix( vec3( 1.0 ), keyTint, 0.42 * smoothstep( 0.12, 0.9, g ) );

  vec3 ambTint = ambientCol / max( ambientLum + 1e-4, 1e-4 );
  col = mix( col, col * ambTint, 0.34 * ( 1.0 - smoothstep( 0.0, 0.62, g ) ) );

  // wet edge dries darker where the wash pooled
  col *= 1.0 - pool * 0.19 * uBandBleed * ( 1.12 - g * 0.5 );

  // ---- pigment granulation (world-locked, so it sticks to the surface) -----
  #ifndef VC_LOW
  {
    vec2 bu = vWorldPos.xz * uBlotchScale;
    vec2 bv = vec2( vWorldPos.x + vWorldPos.z, vWorldPos.y ) * uBlotchScale;
    float vert = 1.0 - abs( vWorldNormal.y );
    vec3 blot = mix( texture2D( uBlotchTex, bu ).rgb, texture2D( uBlotchTex, bv ).rgb, vert );
    col *= mix( 1.0, mix( 0.88, 1.12, blot.r ), uBlotch );
    col *= 1.0 - blot.g * 0.11 * uBlotch;
  }
  #endif

  // ---- pencil hatching in the two darkest bands ---------------------------
  {
    float bandDark = 1.0 - smoothstep( 0.10, 0.55, g );   // darkest two bands
    float bandCross = 1.0 - smoothstep( 0.0, 0.27, g );   // darkest band only
    float h = vcHatchField( sPx, 0.6109, uHatchSpacing, 1.7 ) * bandDark;
    #ifndef VC_LOW
      float hx = vcHatchField( sPx + vec2( 37.0, 11.0 ), -0.2618, uHatchSpacing * 1.27, 5.3 ) * bandCross;
      h = max( h, hx * 0.94 );
    #endif
    // real graphite tooth from the drawn stroke bank, so the procedural lines
    // pick up pencil texture instead of reading as a printed screen
    vec3 hs = texture2D( uHatchTex, sPx * 0.0047 ).rgb;
    h *= mix( 0.52, 1.28, hs.r * 0.5 + hs.g * 0.5 );
    h = clamp( h * uHatch, 0.0, 0.85 );
    vec3 hatchCol = mix( col * 0.40, uGraphite, 0.42 );
    col = mix( col, hatchCol, h );
  }

  // ---- rim / backlight ----------------------------------------------------
  {
    float fres = pow( 1.0 - clamp( dot( N, V ), 0.0, 1.0 ), 2.6 );
    float litSide = smoothstep( -0.15, 0.62, dot( N, primaryL ) );
    col += uCream * fres * litSide * uRim * 0.80 * ( 0.32 + 0.68 * shadowMask );
    col += ambTint * fres * ( 1.0 - litSide ) * uRim * 0.16;
  }

  // ---- translucency (leaves, cloth, skin) ---------------------------------
  if ( uSubsurface > 0.0 ) {
    float trans = pow( clamp( dot( -V, primaryL ), 0.0, 1.0 ), 3.0 );
    trans *= mix( 1.0, shadowMask, 0.6 );
    col += albedo * keyTint * uSubsurface * trans * 1.45;
  }

  col += uEmissive * uEmissiveIntensity;
`;

// The chunk preamble every NPR fragment shader needs, in three's required order.
const NPR_FRAG_PREAMBLE = /* glsl */`
#include <common>
#include <packing>
#include <fog_pars_fragment>
#include <lights_pars_begin>
#include <shadowmap_pars_fragment>
#include <shadowmask_pars_fragment>
` + GLSL_NPR_COMMON;

// ==================================================== prepass (G-buffer) mat
// GLSL3 so we can declare two colour attachments. Attachment 0 carries the
// view-space normal + linear depth the outline pass edge-detects on;
// attachment 1 carries a per-object id + outline weight so two objects at the
// same depth and orientation still get a line drawn between them.

function prepassFragment({ alphaTest = false, map = false } = {}) {
  return /* glsl */`
precision highp float;
layout(location = 0) out vec4 gNormalDepth;
layout(location = 1) out vec4 gMeta;

uniform float uFar;
uniform vec4  uMeta;
${alphaTest ? 'uniform float uAlphaTest;\nuniform float uOpacity;' : ''}
${map ? 'uniform sampler2D uMap;\nuniform vec2 uMapRepeat;' : ''}

varying vec3 vViewPos;
varying vec3 vViewNormal;
varying vec2 vUvC;
varying vec2 vAux;

void main() {
${alphaTest ? `  float a = uOpacity${map ? ' * texture2D( uMap, vUvC * uMapRepeat ).a' : ''};
  if ( a < uAlphaTest ) discard;` : ''}
  vec3 N = normalize( vViewNormal );
  #ifdef DOUBLE_SIDED
    N *= ( gl_FrontFacing ? 1.0 : -1.0 );
  #endif
  gNormalDepth = vec4( N, ( -vViewPos.z ) / uFar );
  gMeta = uMeta;
}
`;
}

function attachPrepass(mat, vertOpts, fragOpts, extraUniforms) {
  const s = shared();
  const uniforms = Object.assign({
    uFar: s.uFar,
    uTime: s.uTime,
    uMeta: { value: new THREE.Vector4(0, 0, 0.5, 1) },
  }, extraUniforms || {});

  const pm = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms,
    vertexShader: buildVertex(Object.assign({}, vertOpts, { prepass: true })),
    fragmentShader: prepassFragment(fragOpts),
    lights: false,
    fog: false,
    side: mat.side,
    name: (mat.name || 'vc') + ':prepass',
  });
  if (mat.defines) {
    pm.defines = Object.assign({}, mat.defines);
    delete pm.defines.VC_LOW;
  }
  pm.userData.vcIsPrepass = true;
  mat.userData.vcPrepass = pm;
  return pm;
}

// ================================================================ registry

export const MaterialRegistry = {
  materials: new Set(),
  quality: CFG.quality,
  _last: -1,

  register(m) { if (m) this.materials.add(m); return m; },
  unregister(m) { this.materials.delete(m); },

  get uniforms() { return shared(); },

  /**
   * Drive the shared uniforms. Safe to call from either the pipeline or a
   * game system — a second call inside the same frame will not double-advance
   * time.
   * @param {number} dt
   * @param {THREE.Camera} camera
   * @param {THREE.DirectionalLight|Array|{sun:THREE.DirectionalLight}} sun
   */
  update(dt, camera, sun) {
    const u = shared();
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (now - this._last > 2) {
      u.uTime.value += dt;
      this._last = now;
    }

    if (camera) {
      u.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
      if (camera.isPerspectiveCamera) u.uFar.value = camera.far;
    }

    const key = resolveSun(sun);
    if (key) {
      u.uSunDirW.value.copy(key.position);
      if (key.target) u.uSunDirW.value.sub(key.target.getWorldPosition(_v3));
      u.uSunDirW.value.normalize();
      if (camera) {
        u.uSunDirV.value.copy(u.uSunDirW.value).transformDirection(camera.matrixWorldInverse);
      }
      u.uSunColor.value.copy(key.color);
      // Auto-normalise the band drive to whatever intensity the rig runs at, so
      // the quantisation always spans its full range regardless of exposure.
      u.uKeyGain.value = 1 / Math.max(0.35, key.intensity * 1.55);
    }
  },

  setQuality(level) {
    this.quality = level;
    const low = level <= 0;
    for (const m of this.materials) {
      const had = m.defines && m.defines.VC_LOW !== undefined;
      if (low && !had) { m.defines = m.defines || {}; m.defines.VC_LOW = ''; m.needsUpdate = true; }
      else if (!low && had) { delete m.defines.VC_LOW; m.needsUpdate = true; }
    }
  },

  setResolution(w, h, pixelRatio = 1) {
    const u = shared();
    u.uResolution.value.set(w, h);
    u.uPixelRatio.value = pixelRatio;
  },

  /** Wind for grass/foliage. dir is a world XZ direction. */
  setWind(dx, dz, strength = 1) {
    const u = shared();
    const l = Math.hypot(dx, dz) || 1;
    u.uWind.value.set(dx / l, dz / l, strength, u.uWind.value.w);
  },

  dispose() {
    for (const m of this.materials) {
      m.userData.vcPrepass?.dispose();
      m.dispose();
    }
    this.materials.clear();
  },
};

const _v3 = new THREE.Vector3();

function resolveSun(sun) {
  if (!sun) return null;
  if (sun.isDirectionalLight) return sun;
  if (sun.sun && sun.sun.isDirectionalLight) return sun.sun;
  if (Array.isArray(sun)) {
    for (const l of sun) if (l && l.isDirectionalLight) return l;
  }
  return null;
}

// ======================================================== makeCanvasMaterial

/**
 * The general NPR surface material. Everything that is not terrain, grass or
 * sky uses this.
 *
 * @param {object} opts
 *  color            base albedo (hex or THREE.Color)                default sage
 *  roughness        0..1 — softens the rim and widens the wet edge  default 0.7
 *  hatch            multiplier on CFG.render.hatchStrength          default 1
 *  rim              cream silhouette light strength                 default 1
 *  paper            paper-tooth normal perturbation strength        default 1
 *  skinning         true for THREE.SkinnedMesh                      default false
 *  instanced        true for THREE.InstancedMesh                    default false
 *  emissive         emissive colour (survives into bloom)           default black
 *  emissiveIntensity                                                default 1
 *  subsurface       0..1 backlit translucency                       default 0
 *  outlineWidth     per-object graphite line weight multiplier      default 1
 *  outline          write into the outline id buffer                default true
 *  vertexColors     use the geometry colour attribute               default false
 *  map              THREE.Texture albedo/alpha map                  default null
 *  alphaTest        >0 enables cutout                               default 0
 *  bands            quantisation levels                    default CFG.render.bands
 *  bandBleed        wet-edge width multiplier                       default 1
 *  wrap             half-Lambert wrap amount                        default 0.45
 *  side, transparent, opacity, depthWrite, name
 */
export function makeCanvasMaterial(opts = {}) {
  const o = Object.assign({
    color: PALETTE.sage,
    roughness: 0.7,
    hatch: 1,
    rim: 1,
    paper: 1,
    skinning: false,
    instanced: false,
    emissive: 0x000000,
    emissiveIntensity: 1,
    subsurface: 0,
    outlineWidth: 1,
    outline: true,
    vertexColors: false,
    map: null,
    mapRepeat: [1, 1],
    alphaTest: 0,
    bands: CFG.render.bands,
    bandBleed: 1,
    wrap: 0.45,
    blotch: 1,
    blotchScale: 0.085,
    toothScale: 1.7,
    hatchSpacing: 5.4,
    shadowSoften: 1,
    side: THREE.FrontSide,
    transparent: false,
    opacity: 1,
    depthWrite: undefined,
    name: 'vcCanvas',
  }, opts);

  const defines = {};
  if (o.map) defines.VC_MAP = '';
  if (o.alphaTest > 0) defines.VC_ALPHATEST = '';
  if (o.skinning) defines.VC_SKINNED = '';
  if (o.instanced) defines.VC_INSTANCED = '';
  if (CFG.quality <= 0) defines.VC_LOW = '';

  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.lights,
    THREE.UniformsLib.fog,
    {
      uColor: { value: new THREE.Color() },
      uOpacity: { value: 1 },
      uBands: { value: 4 },
      uBandBleed: { value: 1 },
      uWrap: { value: 0.45 },
      uHatch: { value: 1 },
      uHatchSpacing: { value: 5.4 },
      uRim: { value: 1 },
      uPaper: { value: 1 },
      uBlotch: { value: 1 },
      uBlotchScale: { value: 0.085 },
      uToothScale: { value: 1.7 },
      uSubsurface: { value: 0 },
      uEmissive: { value: new THREE.Color() },
      uEmissiveIntensity: { value: 1 },
      uAlphaTest: { value: 0 },
      uShadowSoften: { value: 1 },
      uMap: { value: null },
      uMapRepeat: { value: new THREE.Vector2(1, 1) },
      uTime: { value: 0 },
      uResolution: { value: new THREE.Vector2() },
      uPixelRatio: { value: 1 },
      uKeyGain: { value: 0.74 },
      uFillGain: { value: 0.30 },
      uCream: { value: new THREE.Color() },
      uViolet: { value: new THREE.Color() },
      uInkFloor: { value: new THREE.Color() },
      uGraphite: { value: new THREE.Color() },
      uHatchTex: { value: null },
      uBlotchTex: { value: null },
    },
  ]);
  bindShared(uniforms);

  uniforms.uColor.value.set(o.color);
  uniforms.uOpacity.value = o.opacity;
  uniforms.uBands.value = o.bands;
  uniforms.uBandBleed.value = o.bandBleed * (0.7 + o.roughness * 0.6);
  uniforms.uWrap.value = o.wrap;
  uniforms.uHatch.value = o.hatch * CFG.render.hatchStrength;
  uniforms.uHatchSpacing.value = o.hatchSpacing;
  uniforms.uRim.value = o.rim * (1.25 - o.roughness * 0.5);
  uniforms.uPaper.value = o.paper * CFG.render.paperStrength * 2.2;
  uniforms.uBlotch.value = o.blotch;
  uniforms.uBlotchScale.value = o.blotchScale;
  uniforms.uToothScale.value = o.toothScale;
  uniforms.uSubsurface.value = o.subsurface;
  uniforms.uEmissive.value.set(o.emissive);
  uniforms.uEmissiveIntensity.value = o.emissiveIntensity;
  uniforms.uAlphaTest.value = o.alphaTest;
  uniforms.uShadowSoften.value = o.shadowSoften;
  uniforms.uMap.value = o.map;
  uniforms.uMapRepeat.value.set(o.mapRepeat[0], o.mapRepeat[1]);

  const frag = /* glsl */`
${NPR_FRAG_PREAMBLE}
${NPR_UNIFORMS_GLSL}
#ifdef VC_MAP
  uniform sampler2D uMap;
  uniform vec2 uMapRepeat;
#endif

void main() {
  vec3 albedo = uColor;
  float alpha = uOpacity;

  #if defined( USE_COLOR_ALPHA ) || defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
    albedo *= vColorC.rgb;
    #ifdef USE_COLOR_ALPHA
      alpha *= vColorC.a;
    #endif
  #endif

  #ifdef VC_MAP
    vec4 texel = texture2D( uMap, vUvC * uMapRepeat );
    albedo *= texel.rgb;
    alpha *= texel.a;
  #endif

  #ifdef VC_ALPHATEST
    if ( alpha < uAlphaTest ) discard;
  #endif

  vec3 extraN = vec3( 0.0 );
${NPR_SHADE_BODY}

  gl_FragColor = vec4( col, alpha );
  #include <fog_fragment>
  #include <colorspace_fragment>
}
`;

  const mat = new THREE.ShaderMaterial({
    defines,
    uniforms,
    vertexShader: buildVertex({ needNoise: false }),
    fragmentShader: frag,
    lights: true,
    fog: true,
    transparent: o.transparent,
    opacity: o.opacity,
    side: o.side,
    vertexColors: o.vertexColors,
    depthWrite: o.depthWrite !== undefined ? o.depthWrite : !o.transparent,
    name: o.name,
  });

  mat.userData.vcOutline = o.outline;
  mat.userData.vcOutlineWidth = o.outlineWidth;
  mat.userData.vcKind = 'canvas';

  attachPrepass(mat, { needNoise: false },
    { alphaTest: o.alphaTest > 0, map: !!o.map },
    o.alphaTest > 0
      ? Object.assign({ uAlphaTest: uniforms.uAlphaTest, uOpacity: uniforms.uOpacity },
        o.map ? { uMap: uniforms.uMap, uMapRepeat: uniforms.uMapRepeat } : {})
      : null);

  return MaterialRegistry.register(mat);
}

// ========================================================= makeGrassMaterial

/**
 * Instanced grass blades. Expects a THREE.InstancedMesh whose blade geometry
 * grows from y = 0 up to `opts.bladeHeight`.
 *
 * @param {object} opts
 *  rootColor / tipColor   colour ramp along the blade
 *  bladeHeight            geometry height in metres, drives the bend curve (0.55)
 *  sway                   metres of lateral travel at full gust (0.28)
 *  subsurface             backlit glow (0.85 — grass is very translucent)
 *  variation              per-blade hue/value scatter (0.22)
 */
export function makeGrassMaterial(opts = {}) {
  const o = Object.assign({
    rootColor: 0x4d5a33,
    tipColor: 0xa8a866,
    bladeHeight: 0.55,
    sway: 0.28,
    subsurface: 0.85,
    variation: 0.22,
    bands: Math.max(3, CFG.render.bands - 1),
    hatch: 0.55,
    rim: 1.35,
    alphaTest: 0,
    map: null,
    side: THREE.DoubleSide,
    name: 'vcGrass',
  }, opts);

  const defines = { VC_INSTANCED: '' };
  if (o.alphaTest > 0) defines.VC_ALPHATEST = '';
  if (o.map) defines.VC_MAP = '';
  if (CFG.quality <= 0) defines.VC_LOW = '';

  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.lights,
    THREE.UniformsLib.fog,
    {
      uColor: { value: new THREE.Color(1, 1, 1) },
      uRootColor: { value: new THREE.Color() },
      uTipColor: { value: new THREE.Color() },
      uVariation: { value: 0.22 },
      uBladeHeight: { value: 0.55 },
      uSway: { value: 0.28 },
      uOpacity: { value: 1 },
      uBands: { value: 3 },
      uBandBleed: { value: 1.25 },
      uWrap: { value: 0.62 },
      uHatch: { value: 0.55 },
      uHatchSpacing: { value: 6.2 },
      uRim: { value: 1.35 },
      uPaper: { value: 0.7 },
      uBlotch: { value: 0.9 },
      uBlotchScale: { value: 0.12 },
      uToothScale: { value: 3.1 },
      uSubsurface: { value: 0.85 },
      uEmissive: { value: new THREE.Color(0, 0, 0) },
      uEmissiveIntensity: { value: 0 },
      uAlphaTest: { value: 0 },
      uShadowSoften: { value: 0.75 },
      uMap: { value: null },
      uMapRepeat: { value: new THREE.Vector2(1, 1) },
      uTime: { value: 0 },
      uWind: { value: new THREE.Vector4() },
      uResolution: { value: new THREE.Vector2() },
      uPixelRatio: { value: 1 },
      uKeyGain: { value: 0.74 },
      uFillGain: { value: 0.30 },
      uCream: { value: new THREE.Color() },
      uViolet: { value: new THREE.Color() },
      uInkFloor: { value: new THREE.Color() },
      uGraphite: { value: new THREE.Color() },
      uHatchTex: { value: null },
      uBlotchTex: { value: null },
    },
  ]);
  bindShared(uniforms);

  uniforms.uRootColor.value.set(o.rootColor);
  uniforms.uTipColor.value.set(o.tipColor);
  uniforms.uVariation.value = o.variation;
  uniforms.uBladeHeight.value = o.bladeHeight;
  uniforms.uSway.value = o.sway;
  uniforms.uBands.value = o.bands;
  uniforms.uHatch.value = o.hatch * CFG.render.hatchStrength;
  uniforms.uRim.value = o.rim;
  uniforms.uSubsurface.value = o.subsurface;
  uniforms.uAlphaTest.value = o.alphaTest;
  uniforms.uMap.value = o.map;

  const frag = /* glsl */`
${NPR_FRAG_PREAMBLE}
${NPR_UNIFORMS_GLSL}
uniform vec3 uRootColor;
uniform vec3 uTipColor;
uniform float uVariation;
#ifdef VC_MAP
  uniform sampler2D uMap;
  uniform vec2 uMapRepeat;
#endif

void main() {
  float hN = clamp( vAux.x, 0.0, 1.0 );
  float phase = vAux.y;

  // root -> tip ramp, plus per-blade scatter so a field never looks flat
  vec3 albedo = mix( uRootColor, uTipColor, pow( hN, 0.78 ) );
  vec3 hsv = vcRgb2Hsv( albedo );
  hsv.x = fract( hsv.x + ( phase - 0.5 ) * 0.045 * uVariation * 4.0 );
  hsv.y = clamp( hsv.y * ( 1.0 + ( vcHash11( phase * 91.7 ) - 0.5 ) * uVariation ), 0.0, 1.0 );
  hsv.z = clamp( hsv.z * ( 1.0 + ( vcHash11( phase * 37.1 ) - 0.5 ) * uVariation * 1.4 ), 0.0, 2.0 );
  albedo = vcHsv2Rgb( hsv );

  // blades darken sharply into the sward at the base — that shadowed mat is
  // most of what sells a grass field as painted rather than modelled
  albedo *= mix( 0.52, 1.0, smoothstep( 0.0, 0.45, hN ) );

  float alpha = uOpacity;
  #ifdef VC_MAP
    vec4 texel = texture2D( uMap, vUvC * uMapRepeat );
    albedo *= texel.rgb;
    alpha *= texel.a;
  #endif
  #ifdef VC_ALPHATEST
    if ( alpha < uAlphaTest ) discard;
  #endif

  // splay the shading normal outward toward the tip so a blade catches light
  // across its whole width instead of behaving like a flat ribbon
  vec3 extraN = vec3( 0.0, hN * 0.22, 0.0 );

${NPR_SHADE_BODY}

  gl_FragColor = vec4( col, alpha );
  #include <fog_fragment>
  #include <colorspace_fragment>
}
`;

  const mat = new THREE.ShaderMaterial({
    defines,
    uniforms,
    vertexShader: buildVertex({ wind: true, needNoise: true }),
    fragmentShader: frag,
    lights: true,
    fog: true,
    side: o.side,
    transparent: false,
    name: o.name,
  });

  mat.userData.vcOutline = false;      // blades must never get graphite outlines
  mat.userData.vcOutlineWidth = 0;
  mat.userData.vcKind = 'grass';

  attachPrepass(mat, { wind: true, needNoise: true },
    { alphaTest: o.alphaTest > 0, map: !!o.map },
    Object.assign({
      uWind: uniforms.uWind,
      uBladeHeight: uniforms.uBladeHeight,
      uSway: uniforms.uSway,
    }, o.alphaTest > 0 ? { uAlphaTest: uniforms.uAlphaTest, uOpacity: uniforms.uOpacity } : {},
    o.map ? { uMap: uniforms.uMap, uMapRepeat: uniforms.uMapRepeat } : {}));

  return MaterialRegistry.register(mat);
}

// ======================================================= makeTerrainMaterial

/**
 * Multi-layer ground. Layer weights come from slope, height, a procedural
 * macro-variation field and (optionally) a vertex-colour splat where
 * R=grass G=dry dirt B=rock A=mud. Each layer gets its own detail fetch from
 * the generated ground atlas, triplanar-blended so cliffs don't smear.
 *
 * @param {object} opts
 *  grass/dirt/rock/mud   layer colours
 *  splatFromVertexColor  multiply procedural weights by the colour attribute
 *  detailScale           metres per detail tile (default 0.11 => ~9 m tile)
 *  macroScale            metres per macro-variation tile
 *  rockSlope             slope (0..1) at which rock takes over
 *  mudLevel              world Y below which mud appears
 */
export function makeTerrainMaterial(opts = {}) {
  const o = Object.assign({
    grass: 0x74804a,
    dirt: 0xa07c48,
    rock: 0x8b8479,
    mud: 0x59452f,
    splatFromVertexColor: false,
    detailScale: 0.11,
    detailScale2: 0.031,
    macroScale: 0.017,
    rockSlope: 0.46,
    mudLevel: -900,
    mudFade: 1.4,
    bands: CFG.render.bands,
    hatch: 0.8,
    rim: 0.55,
    outline: false,
    name: 'vcTerrain',
  }, opts);

  const defines = {};
  if (o.splatFromVertexColor) defines.VC_SPLAT_VCOL = '';
  if (CFG.quality <= 0) defines.VC_LOW = '';

  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.lights,
    THREE.UniformsLib.fog,
    {
      uColor: { value: new THREE.Color(1, 1, 1) },
      uGrass: { value: new THREE.Color() },
      uDirt: { value: new THREE.Color() },
      uRock: { value: new THREE.Color() },
      uMud: { value: new THREE.Color() },
      uGroundTex: { value: getGroundDetailTexture() },
      uDetailScale: { value: 0.11 },
      uDetailScale2: { value: 0.031 },
      uMacroScale: { value: 0.017 },
      uRockSlope: { value: 0.46 },
      uMudLevel: { value: -900 },
      uMudFade: { value: 1.4 },
      uOpacity: { value: 1 },
      uBands: { value: 4 },
      uBandBleed: { value: 1.1 },
      uWrap: { value: 0.5 },
      uHatch: { value: 0.8 },
      uHatchSpacing: { value: 5.9 },
      uRim: { value: 0.55 },
      uPaper: { value: 1.15 },
      uBlotch: { value: 1.25 },
      uBlotchScale: { value: 0.028 },
      uToothScale: { value: 0.85 },
      uSubsurface: { value: 0 },
      uEmissive: { value: new THREE.Color(0, 0, 0) },
      uEmissiveIntensity: { value: 0 },
      uAlphaTest: { value: 0 },
      uShadowSoften: { value: 1 },
      uTime: { value: 0 },
      uResolution: { value: new THREE.Vector2() },
      uPixelRatio: { value: 1 },
      uKeyGain: { value: 0.74 },
      uFillGain: { value: 0.30 },
      uCream: { value: new THREE.Color() },
      uViolet: { value: new THREE.Color() },
      uInkFloor: { value: new THREE.Color() },
      uGraphite: { value: new THREE.Color() },
      uHatchTex: { value: null },
      uBlotchTex: { value: null },
    },
  ]);
  bindShared(uniforms);

  uniforms.uGrass.value.set(o.grass);
  uniforms.uDirt.value.set(o.dirt);
  uniforms.uRock.value.set(o.rock);
  uniforms.uMud.value.set(o.mud);
  uniforms.uDetailScale.value = o.detailScale;
  uniforms.uDetailScale2.value = o.detailScale2;
  uniforms.uMacroScale.value = o.macroScale;
  uniforms.uRockSlope.value = o.rockSlope;
  uniforms.uMudLevel.value = o.mudLevel;
  uniforms.uMudFade.value = o.mudFade;
  uniforms.uBands.value = o.bands;
  uniforms.uHatch.value = o.hatch * CFG.render.hatchStrength;
  uniforms.uRim.value = o.rim;

  const frag = /* glsl */`
${NPR_FRAG_PREAMBLE}
${NPR_UNIFORMS_GLSL}
uniform vec3 uGrass, uDirt, uRock, uMud;
uniform sampler2D uGroundTex;
uniform float uDetailScale, uDetailScale2, uMacroScale;
uniform float uRockSlope, uMudLevel, uMudFade;

void main() {
  vec3 wp = vWorldPos;
  vec3 wn = normalize( vWorldNormal );
  float slope = 1.0 - clamp( wn.y, 0.0, 1.0 );

  // ---- triplanar-ish detail fetch -----------------------------------------
  vec3 bw = pow( abs( wn ), vec3( 4.0 ) );
  bw /= max( bw.x + bw.y + bw.z, 1e-4 );

  vec4 dY  = texture2D( uGroundTex, wp.xz * uDetailScale );
  vec4 dX  = texture2D( uGroundTex, wp.zy * uDetailScale );
  vec4 dZ  = texture2D( uGroundTex, wp.xy * uDetailScale );
  vec4 det = dX * bw.x + dY * bw.y + dZ * bw.z;

  // a second, much larger detail octave keeps the ground from tiling visibly
  vec4 det2 = texture2D( uGroundTex, wp.xz * uDetailScale2 + 0.371 );

  // ---- layer weights -------------------------------------------------------
  float macro  = vcFbm3( wp.xz * uMacroScale );
  float macro2 = vcFbm2( wp.xz * uMacroScale * 0.41 + 13.1 );
  float mottle = vcFbm4( wp.xz * uMacroScale * 3.7 + 5.9 );

  float wRock = smoothstep( uRockSlope, uRockSlope + 0.22, slope );
  wRock = max( wRock, smoothstep( 0.74, 0.93, macro ) * 0.55 );
  wRock = clamp( wRock + ( det.b - 0.5 ) * 0.18, 0.0, 1.0 );

  float bare = smoothstep( 0.58, 0.30, macro2 ) * ( 0.55 + 0.45 * mottle );
  bare = max( bare, smoothstep( uRockSlope - 0.22, uRockSlope, slope ) * 0.7 );
  float wDirt = clamp( bare * ( 1.0 - wRock ), 0.0, 1.0 );

  float wMud = smoothstep( uMudLevel + uMudFade, uMudLevel, wp.y );
  wMud *= 0.35 + 0.65 * smoothstep( 0.35, 0.75, det2.a );
  wMud = clamp( wMud * ( 1.0 - wRock * 0.7 ), 0.0, 1.0 );

  float wGrass = clamp( 1.0 - wRock - wDirt - wMud, 0.0, 1.0 );

  #ifdef VC_SPLAT_VCOL
    // an explicit splat from the terrain generator overrides the procedural
    // guess where it is authored (R grass, G dirt, B rock, A mud)
    #if defined( USE_COLOR_ALPHA ) || defined( USE_COLOR )
      wGrass *= 0.25 + 1.5 * vColorC.r;
      wDirt  *= 0.25 + 1.5 * vColorC.g;
      wRock  *= 0.25 + 1.5 * vColorC.b;
      #ifdef USE_COLOR_ALPHA
        wMud *= 0.25 + 1.5 * vColorC.a;
      #endif
    #endif
  #endif

  float wSum = max( wGrass + wDirt + wRock + wMud, 1e-4 );
  wGrass /= wSum; wDirt /= wSum; wRock /= wSum; wMud /= wSum;

  // ---- per-layer pigment ---------------------------------------------------
  vec3 cGrass = uGrass * mix( 0.76, 1.20, det.r ) * mix( 0.90, 1.10, det2.r );
  cGrass = mix( cGrass, cGrass * vec3( 1.06, 0.98, 0.82 ), smoothstep( 0.55, 0.9, det2.a ) * 0.5 );

  vec3 cDirt = uDirt * mix( 0.80, 1.18, det.g );
  cDirt = mix( cDirt, cDirt * vec3( 1.10, 1.02, 0.86 ), det2.b * 0.35 );

  vec3 cRock = uRock * mix( 0.66, 1.22, det.b );
  cRock *= 1.0 - smoothstep( 0.62, 0.95, det.b ) * 0.22;      // fissures read dark

  vec3 cMud = uMud * mix( 0.74, 1.14, det.a ) * mix( 1.0, 0.86, det2.a );

  vec3 albedo = cGrass * wGrass + cDirt * wDirt + cRock * wRock + cMud * wMud;
  float alpha = uOpacity;

  // micro-relief: rock and dirt get real normal break-up, grass stays smooth
  float relief = ( det.b - 0.5 ) * wRock * 1.6 + ( det.g - 0.5 ) * wDirt * 0.7;
  vec3 extraN = vec3( relief * 0.55, 0.0, relief * 0.45 );

${NPR_SHADE_BODY}

  gl_FragColor = vec4( col, alpha );
  #include <fog_fragment>
  #include <colorspace_fragment>
}
`;

  const mat = new THREE.ShaderMaterial({
    defines,
    uniforms,
    vertexShader: buildVertex({ needNoise: false }),
    fragmentShader: frag,
    lights: true,
    fog: true,
    vertexColors: !!o.splatFromVertexColor,
    name: o.name,
  });

  mat.userData.vcOutline = o.outline;
  mat.userData.vcOutlineWidth = 0.35;
  mat.userData.vcKind = 'terrain';

  attachPrepass(mat, { needNoise: false }, {}, null);

  return MaterialRegistry.register(mat);
}

// =========================================================== makeSkyMaterial

/**
 * Painted sky dome. Muted teal-grey at the horizon warming to pale gold, with
 * quantised gouache cloud banks and a soft sun bloom. Put it on a large
 * BackSide sphere or box; it writes no depth and is excluded from the G-buffer
 * so the outline pass never draws a line inside the sky.
 */
export function makeSkyMaterial(opts = {}) {
  const o = Object.assign({
    top: 0x6f8ea0,
    horizon: 0xc9c3a6,
    horizonWarm: 0xe8cf98,
    cloud: 0xfff4dd,
    cloudShade: 0xa8a3aa,
    sunGlow: 0xffe2ac,
    cloudAmount: 0.85,
    cloudScale: 0.62,
    exposure: 1,
    name: 'vcSky',
  }, opts);

  const s = shared();
  const uniforms = {
    uTop: { value: new THREE.Color(o.top) },
    uHorizon: { value: new THREE.Color(o.horizon) },
    uHorizonWarm: { value: new THREE.Color(o.horizonWarm) },
    uCloud: { value: new THREE.Color(o.cloud) },
    uCloudShade: { value: new THREE.Color(o.cloudShade) },
    uSunGlow: { value: new THREE.Color(o.sunGlow) },
    uCloudAmount: { value: o.cloudAmount },
    uCloudScale: { value: o.cloudScale },
    uSkyExposure: { value: o.exposure },
    uTime: s.uTime,
    uSunDirW: s.uSunDirW,
    uPixelRatio: s.uPixelRatio,
    uCream: s.uCream,
    uNoiseTex: s.uNoiseTex,
  };

  const vert = /* glsl */`
varying vec3 vWorldPos;
void main() {
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

  const frag = /* glsl */`
${GLSL_NPR_COMMON}
uniform vec3 uTop, uHorizon, uHorizonWarm, uCloud, uCloudShade, uSunGlow, uCream;
uniform float uCloudAmount, uCloudScale, uSkyExposure, uTime, uPixelRatio;
uniform vec3 uSunDirW;
varying vec3 vWorldPos;

void main() {
  vec3 dir = normalize( vWorldPos - cameraPosition );
  float h = dir.y;

  // vertical wash: cool teal-grey overhead falling to warm straw at the horizon
  float t = pow( clamp( h * 1.18 + 0.06, 0.0, 1.0 ), 0.60 );
  vec3 col = mix( uHorizon, uTop, t );
  col = mix( col, uHorizonWarm, smoothstep( 0.20, -0.04, h ) );

  // sun: a tight core plus a very broad warm bleed, both of which are meant to
  // survive into the bloom pass
  float sd = max( dot( dir, uSunDirW ), 0.0 );
  col += uSunGlow * ( pow( sd, 220.0 ) * 2.6 + pow( sd, 14.0 ) * 0.32 + pow( sd, 3.0 ) * 0.09 );

  // ---- gouache cloud banks -------------------------------------------------
  // project onto a plane above the camera so bands stretch toward the horizon
  vec2 cp = dir.xz / max( abs( h ) + 0.13, 0.06 );
  vec2 drift = vec2( uTime * 0.0045, uTime * 0.0016 );
  float c1 = vcFbm4( cp * uCloudScale + drift );
  float c2 = vcFbm3( cp * uCloudScale * 2.6 - drift * 1.7 );
  float mass = c1 * 0.72 + c2 * 0.28;
  float cover = smoothstep( 0.47, 0.70, mass ) * smoothstep( -0.03, 0.16, h );

  // quantise the cloud body into three painted values with a bleeding edge
  vec2 q = vcQuantiseBands( cover, 3.0, 1.35, c2, c1 );
  float lit = clamp( 0.35 + 0.9 * dot( normalize( vec3( cp.x, 1.6, cp.y ) ), uSunDirW ), 0.0, 1.0 );
  vec3 cloudCol = mix( uCloudShade, uCloud, smoothstep( 0.25, 0.85, lit ) );
  cloudCol = mix( cloudCol, uCream, q.x * 0.35 * lit );
  cloudCol *= 1.0 - q.y * 0.22;                       // pooled rim on the cloud edge

  col = mix( col, cloudCol, clamp( q.x * uCloudAmount, 0.0, 1.0 ) );

  // paper-locked tooth so the sky is not a mathematically clean gradient
  vec2 sp = gl_FragCoord.xy / uPixelRatio;
  col *= mix( 0.97, 1.03, vcFbm3( sp * 0.0045 ) );

  gl_FragColor = vec4( col * uSkyExposure, 1.0 );
  #include <colorspace_fragment>
}
`;

  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: vert,
    fragmentShader: frag,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
    fog: false,
    lights: false,
    name: o.name,
  });

  mat.userData.vcSky = true;
  mat.userData.vcNoPrepass = true;      // never let the dome pollute the G-buffer
  mat.userData.vcOutline = false;
  mat.userData.vcKind = 'sky';

  return MaterialRegistry.register(mat);
}

// ============================================ generic G-buffer fallback mat
// Used by the pipeline for any mesh whose material did not come from this file
// (a debug helper, a stock three material). Keeps depth/normal continuity so
// outlines still occlude correctly around foreign geometry.

let _genericPrepass = null;
export function getGenericPrepassMaterial() {
  if (_genericPrepass) return _genericPrepass;
  const s = shared();
  _genericPrepass = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: { uFar: s.uFar, uTime: s.uTime, uMeta: { value: new THREE.Vector4(0, 0, 0.5, 1) } },
    vertexShader: buildVertex({ prepass: true }),
    fragmentShader: prepassFragment({}),
    lights: false,
    fog: false,
    name: 'vcGenericPrepass',
  });
  _genericPrepass.userData.vcIsPrepass = true;
  return _genericPrepass;
}
