// Temporary self-test harness for src/render/. Not part of the game.
import * as THREE from 'three';
import { CFG } from '../core/config.js';
import { CanvasRenderPipeline } from './canvasRenderPipeline.js';
import { makeCanvasMaterial, makeGrassMaterial, makeTerrainMaterial, makeSkyMaterial, MaterialRegistry, PALETTE } from './materials.js';
import { createLightRig } from './lighting.js';
import { FxSystem } from './fx.js';
import { warmTextureCache } from './textures.js';

const errors = [];
window.addEventListener('error', (e) => errors.push(String(e.message)));
window.__ERRORS__ = errors;

const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.NoToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xc9c3a6, 60, 380);
const camera = new THREE.PerspectiveCamera(34, innerWidth / innerHeight, 0.15, 900);
camera.position.set(9, 5.2, 13);
camera.lookAt(0, 1.1, 0);

warmTextureCache();

// --- sky
const sky = new THREE.Mesh(new THREE.SphereGeometry(500, 32, 20), makeSkyMaterial({}));
sky.userData.outline = false;
scene.add(sky);

// --- terrain: a gently rolling plane
const tg = new THREE.PlaneGeometry(220, 220, 120, 120);
tg.rotateX(-Math.PI / 2);
{
  const p = tg.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    const y = Math.sin(x * 0.07) * 1.3 + Math.cos(z * 0.055) * 1.7 + Math.sin((x + z) * 0.021) * 3.1;
    p.setY(i, y);
  }
  tg.computeVertexNormals();
}
const terrain = new THREE.Mesh(tg, makeTerrainMaterial({ mudLevel: -2.4 }));
terrain.receiveShadow = true;
terrain.userData.outline = false;
scene.add(terrain);

const heightAt = (x, z) => Math.sin(x * 0.07) * 1.3 + Math.cos(z * 0.055) * 1.7 + Math.sin((x + z) * 0.021) * 3.1;

// --- grass
{
  const blade = new THREE.PlaneGeometry(0.055, 0.55, 1, 3);
  blade.translate(0, 0.275, 0);
  const N = 6000;
  const gm = makeGrassMaterial({ bladeHeight: 0.55 });
  const im = new THREE.InstancedMesh(blade, gm, N);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
  for (let i = 0; i < N; i++) {
    const x = (Math.random() - 0.5) * 46, z = (Math.random() - 0.5) * 46;
    p.set(x, heightAt(x, z) - 0.02, z);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.random() * Math.PI);
    s.set(1, 0.7 + Math.random() * 0.7, 1);
    m.compose(p, q, s);
    im.setMatrixAt(i, m);
  }
  im.instanceMatrix.needsUpdate = true;
  im.frustumCulled = false;
  im.userData.outline = false;
  scene.add(im);
}

// --- a few solid props with outlines
const props = [];
{
  const mat = makeCanvasMaterial({ color: 0x9a6250, roughness: 0.85 });
  for (let i = 0; i < 7; i++) {
    const g = new THREE.BoxGeometry(1.2 + Math.random(), 1.4 + Math.random() * 2, 1.1 + Math.random());
    const mesh = new THREE.Mesh(g, mat);
    const x = (Math.random() - 0.5) * 22, z = (Math.random() - 0.5) * 22;
    mesh.position.set(x, heightAt(x, z) + g.parameters.height * 0.5, z);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.userData.outline = true;
    scene.add(mesh);
    props.push(mesh);
  }
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(1.3, 32, 20),
    makeCanvasMaterial({ color: 0x8d9670, roughness: 0.5, rim: 1.4 }));
  sphere.position.set(-2.5, heightAt(-2.5, 1) + 1.35, 1);
  sphere.castShadow = sphere.receiveShadow = true;
  scene.add(sphere);
  props.push(sphere);
}

// --- instanced material variant
{
  const mat = makeCanvasMaterial({ color: 0x7a5a3a, instanced: true, roughness: 0.9 });
  const im = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.18, 0.22, 2.6, 7), mat, 40);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
  for (let i = 0; i < 40; i++) {
    const x = (Math.random() - 0.5) * 40, z = (Math.random() - 0.5) * 40;
    p.set(x, heightAt(x, z) + 1.3, z);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.random() * 3);
    m.compose(p, q, s);
    im.setMatrixAt(i, m);
  }
  im.instanceMatrix.needsUpdate = true;
  im.castShadow = true;
  scene.add(im);
}

// --- a real SkinnedMesh to prove the skinning path compiles + animates
{
  const bones = [];
  const root = new THREE.Bone(); root.position.set(0, 0, 0); bones.push(root);
  let prev = root;
  for (let i = 1; i < 4; i++) {
    const b = new THREE.Bone(); b.position.set(0, 0.7, 0); prev.add(b); bones.push(b); prev = b;
  }
  const geo = new THREE.CylinderGeometry(0.28, 0.34, 2.8, 10, 12);
  geo.translate(0, 1.4, 0);
  const pos = geo.attributes.position;
  const si = [], sw = [];
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const f = Math.max(0, Math.min(2.999, y / 0.7));
    const i0 = Math.floor(f), w = f - i0;
    si.push(i0, Math.min(3, i0 + 1), 0, 0);
    sw.push(1 - w, w, 0, 0);
  }
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  const mat = makeCanvasMaterial({ color: 0x6f7a4e, skinning: true, roughness: 0.7, subsurface: 0.12 });
  const sk = new THREE.SkinnedMesh(geo, mat);
  const skel = new THREE.Skeleton(bones);
  sk.add(root);
  sk.bind(skel);
  sk.position.set(3.4, heightAt(3.4, -2), -2);
  sk.castShadow = true;
  scene.add(sk);
  window.__SKEL__ = bones;
}

// --- lights + pipeline + fx
const rig = createLightRig(scene, { timeOfDay: 0.78 });
const pipeline = new CanvasRenderPipeline(renderer, scene, camera);
pipeline.setLightRig(rig);
const fx = new FxSystem(scene);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight, false);
  pipeline.setSize(innerWidth, innerHeight);
});

const clock = new THREE.Clock();
let t = 0, frames = 0;
const focus = new THREE.Vector3(0, 1, 0);
const v = new THREE.Vector3();

function loop() {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, clock.getDelta());
  t += dt; frames++;

  for (let i = 1; i < window.__SKEL__.length; i++) {
    window.__SKEL__[i].rotation.z = Math.sin(t * 1.5 + i) * 0.22;
  }

  if (frames % 20 === 0) {
    fx.muzzleFlash(v.set(3.4, heightAt(3.4, -2) + 2.2, -2), new THREE.Vector3(1, 0.1, 0.4).normalize());
    fx.shellCasing(v.set(3.4, heightAt(3.4, -2) + 2.1, -2), new THREE.Vector3(1.8, 2.2, 0.5), heightAt(3.4, -2));
    fx.tracer(v.set(3.4, heightAt(3.4, -2) + 2.2, -2), new THREE.Vector3(-8, heightAt(-8, 6) + 1.4, 6), 120);
  }
  if (frames % 90 === 0) fx.explosion(v.set(-6, heightAt(-6, -6) + 0.4, -6), 2.6);
  if (frames % 30 === 0) fx.impact(v.set(-2.5, heightAt(-2.5, 1) + 1.6, 1), new THREE.Vector3(0.5, 0.6, 0.6).normalize(), 'stone');
  if (frames % 25 === 0) fx.dustKick(v.set(1, heightAt(1, 4), 4));

  rig.update(dt, focus);
  fx.update(dt);
  pipeline.render(dt);

  if (frames === 60) window.__READY__ = true;
}
loop();

window.__PIPE__ = pipeline;
window.__FX__ = fx;
window.__RIG__ = rig;
window.__INFO__ = () => ({ calls: renderer.info.render.calls, tris: renderer.info.render.triangles, programs: renderer.info.programs.length });
