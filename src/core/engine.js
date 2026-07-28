import * as THREE from 'three';
import { CFG } from './config.js';
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
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, CFG.render.maxPixelRatio));
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, CFG.render.maxPixelRatio));
    this.renderer.setSize(w, h, false);
    this.pipeline?.setSize(w, h);
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
