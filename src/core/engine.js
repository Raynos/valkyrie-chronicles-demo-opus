import * as THREE from 'three';
import { CFG, pixelRatio } from './config.js';
import { Input } from './input.js';

export class Engine {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,          // we do our own AA in the post stack
      powerPreference: 'high-performance',
      stencil: false,
      alpha: false,
    });
    this.renderer.setPixelRatio(pixelRatio());
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.renderer.shadowMap.enabled = true;
    // PCFSoftShadowMap is deprecated in three r185 and silently falls back to
    // PCFShadowMap, so ask for what we were already getting.
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.NoToneMapping;   // handled in the grade pass
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.autoClear = true;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      CFG.camera.fov, innerWidth / innerHeight, CFG.camera.near, CFG.camera.far
    );

    this.clock = new THREE.Clock();
    this.systems = [];
    this.time = 0;
    this.frame = 0;
    this.paused = false;
    this._raf = null;
    this.pipeline = null;      // set by main.js — CanvasRenderPipeline

    Input.attach(canvas);
    addEventListener('resize', () => this.onResize());

    // Measurement handle for the PLAYED build. `window.__VC__` is published only
    // under ?capture, so every performance and playtest harness before round 22
    // had to reach into vite's module graph to find the battle — and after any
    // src edit vite serves `/src/game/battle.js?t=NNN`, so a plain dynamic
    // import returns a SECOND module instance with null state. Two rounds were
    // spent rediscovering that. The engine is the one object that reaches
    // everything (`engine.systems` holds battle, hud, physics and fx; the
    // renderer and pipeline hang off it directly), so it publishes itself.
    // Unconditional on purpose: gating it on a query flag means a harness that
    // forgets the flag silently measures nothing.
    if (typeof window !== 'undefined') window.__ENGINE__ = this;

    // See CFG.pinModules. `vite:beforeFullReload` is a client-wide event, so any
    // module may veto the reload; the engine is the module that is always loaded
    // exactly once.
    //
    // THE VETO ONLY WORKS IF THE PATH ENDS IN '.html'. vite's client is
    //   if (payload.path && payload.path.endsWith('.html')) { ...reload only if it
    //     names THIS page... return } else pageReload()
    // so any other sentinel — including an empty string — falls straight through
    // to the `else` and reloads. `pinModulesForCapture()` in main.js sets
    // '/__vc_capture_never_reload__', which does not end in .html, so the capture
    // pin has never actually suppressed anything; every "close-up of a stone
    // wall" frame it was written to prevent can still happen. Not my file to fix,
    // but this is why this line looks the way it does.
    // It is installed as an un-overwritable accessor rather than an assignment
    // because main.js registers its (broken) handler AFTER this one — the Engine
    // is built at main.js:150, pinModulesForCapture() is called at main.js:1028 —
    // so a plain `payload.path = ...` here would be overwritten by the value that
    // does not work. The setter swallows that write instead of throwing.
    if ((CFG.pinModules || CFG.capture) && typeof import.meta !== 'undefined' && import.meta.hot) {
      import.meta.hot.on('vite:beforeFullReload', (payload) => {
        if (!payload) return;
        try {
          Object.defineProperty(payload, 'path', {
            get: () => '/__vc_pinned_never_reload__.html',
            set: () => {},
            configurable: true,
          });
        } catch (e) { payload.path = '/__vc_pinned_never_reload__.html'; }
      });
    }
  }

  /** The registered system that looks like the Battle, for harnesses. */
  get battle() { return this.systems.find((s) => s && s.units && s.phase !== undefined) || null; }

  /** The live config, so a harness can retune a knob without a reload. */
  get cfg() { return CFG; }

  add(system) { this.systems.push(system); return system; }
  remove(system) {
    const i = this.systems.indexOf(system);
    if (i >= 0) this.systems.splice(i, 1);
    system.dispose?.();
  }

  onResize() {
    const w = innerWidth, h = innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(pixelRatio());
    this.renderer.setSize(w, h, false);
    this.pipeline?.setSize(w, h);
  }

  /**
   * RETIRED IN ROUND 22. The dynamic-resolution ratchet is gone; this refuses.
   *
   * Round 21 replaced the old shader-tier ratchet with a resolution ratchet,
   * which was the right knob but still the wrong idea, and it failed in exactly
   * the way its predecessor did. Measured in a played session:
   *
   *   * It is decided by a camera nobody plays in. The pre-battle orbit — 30 m up
   *     with the whole valley in frustum, behind the title card and the briefing —
   *     runs at 31 ms a frame, against 19 ms for the command map and 14 ms for
   *     action mode. The ratchet arms 8 s in, i.e. in the middle of that orbit,
   *     and 100% of orbit frames are over its 23.8 ms slow threshold, so it has
   *     its 90 slow frames about three seconds later.
   *   * It never recovers, and cannot. Stepping back up needs 240 frames under
   *     18.2 ms; the command map sits at 19.3 ms, so the counter that has to
   *     reach 240 is being decremented more often than incremented for as long as
   *     the player is looking at the tactical map. Every session therefore ends at
   *     0.85 or below, permanently, and every screenshot anyone has judged was of
   *     a renderer that had quietly turned itself down.
   *   * It corrupts measurement. Round 22's first pass profiler reported every
   *     disabled pass as SLOWER than all-on, because turning a pass off made
   *     frames fast, the ratchet stepped the buffer back up, and the resolution
   *     change swamped the pass it was trying to price.
   *
   * A game that silently degrades its own look is worse than one that starts at
   * the lower setting honestly, so the setting is now honest and fixed:
   * CFG.render.renderScale, overridable with ?rs=<n> for a machine that needs it.
   * The method stays because main.js still calls it; returning false is the whole
   * contract its caller checks, so the ratchet in main.js is now inert.
   */
  setDynScale() { return false; }

  start() {
    const loop = () => {
      this._raf = requestAnimationFrame(loop);
      let dt = this.clock.getDelta();
      if (dt > 0.1) dt = 0.1;                 // clamp after a stall
      if (!this.paused) {
        this.time += dt;
        this.frame++;
        for (const s of this.systems) s.update?.(dt, this.time);
      }
      if (this.pipeline) this.pipeline.render(dt);
      else this.renderer.render(this.scene, this.camera);
      Input.update();
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() { if (this._raf) cancelAnimationFrame(this._raf); this._raf = null; }
}
