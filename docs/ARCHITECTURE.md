# Valkyrie Chronicles — Architecture Contract

**This document is the interface contract between parallel agents. Do not change
an exported signature without updating this file.**

Target: a browser tactical-RPG-with-shooter (BLiTZ system) rendered in Three.js,
in the CANVAS engine art style of *Valkyria Chronicles Remastered* (PS4).

## Hard rules for every agent

1. **No external asset downloads.** Everything — meshes, textures, animation,
   audio — is generated procedurally in code at runtime. No CDN, no fetch.
2. **ES modules, no TypeScript.** `import * as THREE from 'three'`.
3. **Own only your files.** Never edit a file owned by another module.
4. **Deterministic where possible.** Use `rng.js` seeded RNG, never `Math.random()`
   in world generation (gameplay/VFX jitter may use it).
5. **60 fps budget on integrated GPU.** Instance everything repeated. No per-frame
   allocation in hot loops — reuse scratch vectors.
6. Units: **1 world unit = 1 metre**. +Y is up. Grid cell = 1 m.

## Module map / ownership

```
src/core/      engine loop, input, RNG, math scratch, event bus, config
src/render/    CANVAS-style renderer: materials, outline pass, post FX stack
src/world/     terrain, vegetation, props, cover, buildings, skybox
src/actors/    procedural character meshes, skeleton, animation clips, tanks
src/game/      BLiTZ state machine, CP/AP, combat resolution, AI, mission
src/ui/        HUD, command-mode overlay, menus, damage numbers, book frame
src/audio/     procedural WebAudio SFX + adaptive music
```

## Core contracts (`src/core/`)

```js
// engine.js
export class Engine {
  constructor(canvas)          // creates renderer, scene, clock
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  renderer: THREE.WebGLRenderer
  add(system)                  // system = { update(dt, t), dispose?() }
  start()
  onResize()
}

// input.js
export const Input = {
  keys: Set<string>,           // lowercase 'w','shift',' '
  down(code): boolean,
  pressed(code): boolean,      // true only on the frame it went down
  mouse: { x, y, dx, dy, left, right, wheel },
  pointerLocked: boolean,
  requestLock(), exitLock(),
  update()                     // called at END of frame by Engine
}

// rng.js
export function makeRng(seed): () => number   // mulberry32, [0,1)
export function rngRange(rng, a, b)
export function rngPick(rng, arr)

// bus.js — global event bus
export const Bus = { on(evt, fn), off(evt, fn), emit(evt, payload) }

// config.js
export const CFG = { quality, debug, ... }   // tunables, hot-editable
```

### Canonical events on `Bus`

| event | payload |
|---|---|
| `phase:change` | `{ from, to }` — `'command' \| 'action' \| 'enemy' \| 'result'` |
| `unit:selected` | `{ unit }` |
| `unit:damaged` | `{ unit, amount, crit, source, worldPos }` |
| `unit:downed` | `{ unit }` |
| `shot:fired` | `{ unit, origin, dir, weapon }` |
| `shot:hit` | `{ point, normal, material, unit? }` |
| `interception` | `{ shooter, target }` |
| `cp:changed` | `{ team, cp }` |
| `turn:changed` | `{ team, turn }` |
| `mission:end` | `{ victory, turns, stats }` |
| `order:used` | `{ order, unit }` |
| `explosion` | `{ pos, radius, power }` |
| `sfx` | `{ name, pos?, vol? }` |

## Render contract (`src/render/`)

```js
// canvasRenderer.js — owns the whole post pipeline
export class CanvasRenderPipeline {
  constructor(renderer, scene, camera)
  render(dt)                   // call INSTEAD of renderer.render()
  setSize(w, h)
  setQuality(level)            // 0 low .. 2 ultra
}

// materials.js
export function makeCanvasMaterial(opts) -> THREE.ShaderMaterial
//   opts: { color, roughness, hatch, rim, paper, skinning, instanced,
//           emissive, subsurface, outlineWidth }
export function makeGrassMaterial(opts)
export function makeTerrainMaterial(opts)
export const MaterialRegistry   // { update(dt, camera, lights) } — drives uniforms
```

All world/actor meshes MUST use materials from `materials.js` so the NPR look and
the outline pass stay coherent. Meshes opt into outlining via
`mesh.userData.outline = true` (default true for actors, false for terrain).

## World contract (`src/world/`)

```js
// terrain.js
export class Terrain {
  constructor(opts)  // { size, seed, resolution }
  mesh: THREE.Mesh
  heightAt(x, z): number
  normalAt(x, z): THREE.Vector3
  slopeAt(x, z): number
  raycast(origin, dir): hit|null
}

// world.js — assembles everything
export class World {
  constructor(scene, seed)
  terrain: Terrain
  colliders: Collider[]         // { type:'box'|'sphere', ... , cover: 0..1, destructible }
  navQuery(x, z): { walkable, cost, cover }
  update(dt, camera)
  coverAt(pos, fromDir): 0..1   // 0 none, 0.5 half, 1 full
}
```

## Actors contract (`src/actors/`)

```js
// character.js
export class Character {
  constructor(cfg)  // { class:'scout'|'shock'|'lancer'|'engineer'|'sniper',
                    //   team:0|1, name, seed }
  root: THREE.Group
  play(clip, opts)             // 'idle','walk','run','crouchIdle','crouchWalk',
                               // 'aim','fire','reload','hit','death','prone','cheer'
  setAimAngles(yaw, pitch)     // additive upper-body aim
  update(dt)
  muzzlePoint(): THREE.Vector3
  headPoint(): THREE.Vector3
  dispose()
}

// tank.js
export class Tank { /* same shape; hull+turret+treads, radiator weak point */ }
```

## Game contract (`src/game/`)

```js
// unit.js
export class Unit {
  character | tank
  team, cls, name, hp, maxHp, ap, maxAp, aim, defense, weapon
  pos: THREE.Vector3, yaw
  alive, downed, hasActed, actionsThisTurn
  takeDamage(n, source)
}

// battle.js — the BLiTZ state machine
export class Battle {
  constructor(world, scene)
  phase: 'command'|'action'|'enemy'|'result'
  cp: { 0: n, 1: n }
  units: Unit[]
  selectUnit(unit), endAction(), endTurn()
  update(dt)
}
```

## UI contract (`src/ui/`)

DOM overlay (not canvas 2D) so text is crisp. Root element `#hud`.
`export class HUD { constructor(battle); update(dt); }`
Subscribes to `Bus` events only — never reaches into game internals to mutate.

## Audio contract (`src/audio/`)

```js
export class AudioEngine {
  init()            // must be called from a user gesture
  play(name, opts)  // { pos, vol, pitch }
  setMusicState(s)  // 'menu'|'command'|'action'|'tension'|'victory'|'defeat'
  update(dt, listenerMatrix)
}
```
Listens to `sfx` on the Bus.

## Art direction — CANVAS engine reference

Non-negotiable look targets, in priority order:

1. **Pencil-sketch outlines** — dark brown-grey, *variable width*, slightly wobbly,
   drawn from depth+normal discontinuity, thicker on silhouettes, thinner inside.
2. **Watercolour banding** — lighting quantised to 3–4 bands with soft bleeding
   edges, colours *warmer* in light, *violet-blue* in shade (never grey).
3. **Paper grain** — a persistent, subtly animated cold-press watercolour paper
   texture multiplied over everything, strongest in mid-tones.
4. **Pencil hatching** in shadow regions, screen-space aligned, cross-hatching in
   the darkest band.
5. **Bloom + warm bleed** — soft, generous, slightly blown-out highlights.
6. **Colour grade** — sepia-warm, desaturated greens, cream highlights, low
   contrast blacks (never pure black; darkest is a warm brown-violet).
7. **Vignette + edge paper fibre**, subtle chromatic fringing at frame edges.
8. UI reads as an **illustrated field journal**: cream paper, ink serif titles,
   red ribbon accents, hand-ruled boxes.
