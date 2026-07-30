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
  }

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
   * Turn the resolution down (or back up) and re-derive everything that depends
   * on it. Returns true only if the renderer's pixel ratio actually MOVED, so a
   * caller can stop stepping when the floor is reached; a no-op is rolled back.
   *
   * This is the ONLY dynamic-quality lever the game pulls now. Measured, the
   * shader-quality tiers were the wrong knob: ultra -> low saved 10.9 ms of a
   * 58.4 ms frame and cost 38 fresh shader compiles (a multi-second stall, which
   * is itself what tripped the ratchet again), while the resolution knob saved
   * 24.8 ms with zero recompiles and no change to the art direction — same ink,
   * same wash steps, same paper, fewer samples of it.
   */
  setDynScale(scale) {
    const prevScale = CFG.render.dynScale;
    const prevRatio = this.renderer.getPixelRatio();
    CFG.render.dynScale = Math.max(0.25, Math.min(1, scale));
    if (Math.abs(pixelRatio() - prevRatio) < 1e-3) {
      CFG.render.dynScale = prevScale;
      return false;
    }
    this.onResize();
    return true;
  }

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
