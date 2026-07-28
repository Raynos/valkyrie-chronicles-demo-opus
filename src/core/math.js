import * as THREE from 'three';

// Scratch objects — reuse instead of allocating in hot loops.
export const V0 = new THREE.Vector3();
export const V1 = new THREE.Vector3();
export const V2 = new THREE.Vector3();
export const V3 = new THREE.Vector3();
export const Q0 = new THREE.Quaternion();
export const Q1 = new THREE.Quaternion();
export const M0 = new THREE.Matrix4();
export const M1 = new THREE.Matrix4();
export const C0 = new THREE.Color();
export const E0 = new THREE.Euler();

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => clamp01((v - a) / (b - a));
export const smoothstep = (a, b, v) => { const t = invLerp(a, b, v); return t * t * (3 - 2 * t); };
export const smootherstep = (a, b, v) => { const t = invLerp(a, b, v); return t * t * t * (t * (t * 6 - 15) + 10); };

// Frame-rate independent exponential smoothing.
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
export function dampV(out, target, lambda, dt) {
  const t = 1 - Math.exp(-lambda * dt);
  out.lerp(target, t);
  return out;
}

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export function shortestAngle(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}
export function dampAngle(a, b, lambda, dt) {
  return a + shortestAngle(a, b) * (1 - Math.exp(-lambda * dt));
}

// Cheap easing set
export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
export const easeInCubic = (t) => t * t * t;
export const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOutBack = (t) => 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2);
export const easeOutElastic = (t) =>
  t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
export const easeOutQuint = (t) => 1 - Math.pow(1 - t, 5);
