// src/audio/sfx.js — procedural sound-effect synthesis.
//
// Everything here is *pure DSP*: sounds are rendered sample-by-sample into
// Float32Arrays with hand-written filters and resonator banks, then handed to
// AudioEngine which wraps them in AudioBuffers once at startup. No AudioContext
// dependency, no assets, fully deterministic for a given (name, variant, sr).
//
// Why hand DSP instead of an OfflineAudioContext node graph: modal impact
// bodies, per-cylinder engine firing jitter and wrap-around seamless loops all
// need sample-accurate control that the node graph can't express, and baking
// this way is ~5x faster than spinning up an OfflineAudioContext per sound.

import { makeRng } from '../core/rng.js';

const TAU = Math.PI * 2;

// Decay envelope that is exponential in the body but reaches *exactly* zero at
// t=1 so baked buffers never end on a discontinuity (which would click).
export const dEnv = (t, c) => Math.exp(-c * t) * (1 - t * t * t * t);

// ---------------------------------------------------------------------------
// DSP primitives
// ---------------------------------------------------------------------------

/** Transposed-direct-form-II biquad. Coefficients may be re-set while running
 *  (state is preserved) which is how the sweeping filters below work. */
export class Biquad {
  constructor() {
    this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0;
    this.z1 = 0; this.z2 = 0;
  }
  reset() { this.z1 = 0; this.z2 = 0; return this; }
  _set(b0, b1, b2, a0, a1, a2) {
    const ia = 1 / a0;
    this.b0 = b0 * ia; this.b1 = b1 * ia; this.b2 = b2 * ia;
    this.a1 = a1 * ia; this.a2 = a2 * ia;
    return this;
  }
  _w(sr, f) { return TAU * Math.min(Math.max(f, 8), sr * 0.487) / sr; }
  lowpass(sr, f, q = 0.7071) {
    const w = this._w(sr, f), cs = Math.cos(w), al = Math.sin(w) / (2 * q);
    return this._set((1 - cs) * 0.5, 1 - cs, (1 - cs) * 0.5, 1 + al, -2 * cs, 1 - al);
  }
  highpass(sr, f, q = 0.7071) {
    const w = this._w(sr, f), cs = Math.cos(w), al = Math.sin(w) / (2 * q);
    return this._set((1 + cs) * 0.5, -(1 + cs), (1 + cs) * 0.5, 1 + al, -2 * cs, 1 - al);
  }
  bandpass(sr, f, q = 1) {           // unity peak gain
    const w = this._w(sr, f), cs = Math.cos(w), al = Math.sin(w) / (2 * q);
    return this._set(al, 0, -al, 1 + al, -2 * cs, 1 - al);
  }
  peaking(sr, f, q, dB) {
    const A = Math.pow(10, dB / 40);
    const w = this._w(sr, f), cs = Math.cos(w), al = Math.sin(w) / (2 * q);
    return this._set(1 + al * A, -2 * cs, 1 - al * A, 1 + al / A, -2 * cs, 1 - al / A);
  }
  process(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

/** Bank of two-pole resonators — the workhorse for struck-object timbres
 *  (metal, wood, stone, gun receivers, timpani).
 *
 *  The impulse response of y[n] = g·x[n] + a1·y[n-1] + a2·y[n-2] is
 *  g·rⁿ·sin((n+1)w)/sin(w), so its peak is g/sin(w). Setting g = A·sin(w)
 *  makes every mode peak at exactly A regardless of frequency *or* decay
 *  time — without that, low or long-ringing modes vanish under short ones. */
export class Modes {
  constructor(sr, freqs, t60s, amps) {
    const n = freqs.length;
    this.n = n;
    this.a1 = new Float64Array(n); this.a2 = new Float64Array(n);
    this.g = new Float64Array(n);
    this.y1 = new Float64Array(n); this.y2 = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const w = TAU * Math.min(freqs[i], sr * 0.482) / sr;
      const t60 = Math.max(1e-4, t60s[i % t60s.length]);
      const r = Math.exp(-6.907755 / (t60 * sr));
      this.a1[i] = 2 * r * Math.cos(w);
      this.a2[i] = -r * r;
      this.g[i] = (amps ? (amps[i % amps.length] ?? 1) : 1) * Math.sin(w);
    }
  }
  process(x) {
    let s = 0;
    for (let i = 0; i < this.n; i++) {
      const y = this.g[i] * x + this.a1[i] * this.y1[i] + this.a2[i] * this.y2[i];
      this.y2[i] = this.y1[i]; this.y1[i] = y;
      s += y;
    }
    return s;
  }
}

// ---------------------------------------------------------------------------
// Buffer helpers
// ---------------------------------------------------------------------------

export const monoBuf = (sr, dur) => new Float32Array(Math.max(1, Math.ceil(sr * dur)));

export function mixInto(dst, src, off, gain = 1) {
  const n = Math.min(src.length, dst.length - off);
  for (let i = 0; i < n; i++) dst[off + i] += src[i] * gain;
}

/** Filtered noise burst. `type` lp|hp|bp, optional exponential cutoff sweep
 *  f0 -> f1. Coefficients update at control rate (every 32 samples). */
export function noiseBurst(out, sr, rng, o) {
  const t0 = o.t0 || 0, dur = o.dur, amp = o.amp ?? 1;
  const s0 = Math.floor(t0 * sr);
  const n = Math.min(out.length - s0, Math.ceil(dur * sr));
  if (n <= 0) return;
  const type = o.type || 'lp', q = o.q ?? 0.7071;
  const f0 = o.f0 ?? 8000, f1 = o.f1 ?? f0, ratio = f1 / f0;
  const curve = o.curve ?? 6;
  const atk = Math.max(1, Math.floor((o.attack ?? 0.0008) * sr));
  const bq = new Biquad();
  const hpf = o.hp ? new Biquad().highpass(sr, o.hp, 0.707) : null;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    if ((i & 31) === 0) {
      const cf = ratio === 1 ? f0 : f0 * Math.pow(ratio, t);
      if (type === 'lp') bq.lowpass(sr, cf, q);
      else if (type === 'bp') bq.bandpass(sr, cf, q);
      else bq.highpass(sr, cf, q);
    }
    let x = bq.process(rng() * 2 - 1);
    if (hpf) x = hpf.process(x);
    const a = i < atk ? i / atk : 1;
    out[s0 + i] += x * a * dEnv(t, curve) * amp;
  }
}

/** Pitched tone with exponential frequency sweep and optional tanh drive.
 *  wave: sin | tri | saw | sqr. */
export function tone(out, sr, o) {
  const t0 = o.t0 || 0, dur = o.dur, amp = o.amp ?? 1;
  const s0 = Math.floor(t0 * sr);
  const n = Math.min(out.length - s0, Math.ceil(dur * sr));
  if (n <= 0) return;
  const f0 = o.f0, f1 = o.f1 ?? f0, ratio = f1 / f0;
  const curve = o.curve ?? 5, wave = o.wave || 'sin', drive = o.drive || 0;
  const atk = Math.max(1, Math.floor((o.attack ?? 0.0012) * sr));
  const fmA = o.fm || 0, fmR = o.fmRate || 0;
  let ph = o.phase || 0, fmPh = 0;
  const k = drive > 0 ? 1 + drive * 9 : 1;
  const norm = drive > 0 ? 1 / Math.tanh(k) : 1;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    let f = f0 * Math.pow(ratio, t);
    if (fmA) { fmPh += TAU * fmR / sr; f *= 1 + fmA * Math.sin(fmPh); }
    ph += TAU * f / sr;
    if (ph > TAU) ph -= TAU;
    let x;
    if (wave === 'sin') x = Math.sin(ph);
    else if (wave === 'tri') x = 1 - 4 * Math.abs(((ph / TAU) % 1) - 0.5);
    else if (wave === 'sqr') x = Math.sin(ph) >= 0 ? 1 : -1;
    else x = 2 * ((ph / TAU) % 1) - 1;
    if (drive > 0) x = Math.tanh(x * k) * norm;
    const a = i < atk ? i / atk : 1;
    out[s0 + i] += x * a * dEnv(t, curve) * amp;
  }
}

/** Struck resonant body: short noise/impulse excitation into a modal bank.
 *  `amp` is the *peak* contribution — the layer is rendered to scratch and
 *  peak-normalised, because a resonator's impulse response amplitude otherwise
 *  scales with its decay time and a long-ringing bell would come out silent
 *  next to a short wooden knock. */
export function modalHit(out, sr, rng, o) {
  const t0 = o.t0 || 0;
  const s0 = Math.floor(t0 * sr);
  let maxT = 0;
  for (const t of o.t60s) if (t > maxT) maxT = t;
  const dur = o.dur ?? maxT * 1.25;
  const n = Math.min(out.length - s0, Math.ceil(dur * sr));
  if (n <= 0) return;
  const modes = new Modes(sr, o.freqs, o.t60s, o.amps);
  const ex = new Biquad().lowpass(sr, o.exciteLp ?? 9000, 0.8);
  const ne = Math.max(2, Math.floor((o.exciteDur ?? 0.0035) * sr));
  const tmp = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    let x = 0;
    if (i < ne) {
      const e = 1 - i / ne;
      x = ex.process((rng() * 2 - 1) * e * e);
      if (i === 0) x += 1;          // hard impulse for the initial "tick"
    }
    const y = modes.process(x);
    tmp[i] = y;
    const a = y < 0 ? -y : y;
    if (a > peak) peak = a;
  }
  if (peak <= 1e-12) return;
  const g = (o.amp ?? 1) / peak;
  for (let i = 0; i < n; i++) out[s0 + i] += tmp[i] * g;
}

/** Discrete echo taps — used for gun slapback off valley walls / ruins. */
export function addTaps(buf, sr, taps) {
  const src = buf.slice();
  for (const tp of taps) {
    const d = Math.floor(tp.t * sr);
    if (d >= buf.length) continue;
    const lp = new Biquad().lowpass(sr, tp.lp ?? 3000, 0.707);
    const hp = tp.hp ? new Biquad().highpass(sr, tp.hp, 0.707) : null;
    const n = buf.length - d;
    for (let i = 0; i < n; i++) {
      let x = lp.process(src[i]);
      if (hp) x = hp.process(x);
      buf[i + d] += x * tp.g;
    }
  }
}

/** Schroeder allpass chain — smears transients into a diffuse tail without
 *  changing the magnitude spectrum. */
export function allpassChain(buf, sr, delaysMs, g = 0.6) {
  for (let k = 0; k < delaysMs.length; k++) {
    const d = Math.max(1, Math.floor(delaysMs[k] * 0.001 * sr));
    const z = new Float32Array(d);
    let p = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = z[p], x = buf[i];
      const y = -g * x + v;
      z[p] = x + g * y;
      p = p + 1 === d ? 0 : p + 1;
      buf[i] = y;
    }
  }
}

/** Soft-knee saturation — tames peaks and adds the small amount of harmonic
 *  glue that makes synthesised transients read as "recorded". */
export function softLimit(buf, thresh = 0.72, ceiling = 0.985) {
  const range = ceiling - thresh;
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i], a = Math.abs(x);
    if (a > thresh) {
      const over = (a - thresh) / range;
      buf[i] = Math.sign(x) * (thresh + range * Math.tanh(over));
    }
  }
}

/** Soft-limit both channels of a stereo pair (the allpass decorrelation in
 *  stereoize() can push a mono-limited signal back over unity). */
export function stereoLimit(pair, thresh = 0.72) {
  softLimit(pair[0], thresh);
  softLimit(pair[1], thresh);
  return pair;
}

export function fadeEdges(buf, sr, inMs = 0.6, outMs = 6) {
  const ni = Math.min(buf.length, Math.floor(inMs * 0.001 * sr));
  const no = Math.min(buf.length, Math.floor(outMs * 0.001 * sr));
  for (let i = 0; i < ni; i++) buf[i] *= i / ni;
  for (let i = 0; i < no; i++) buf[buf.length - 1 - i] *= i / no;
}

/** Scatter n micro-events across [t0,t1]; fn(t, i, rng) does the work. */
export function scatter(rng, n, t0, t1, fn) {
  for (let i = 0; i < n; i++) fn(t0 + (t1 - t0) * Math.pow(rng(), 1.6), i);
}

/** Decorrelate a mono render into a stereo pair using short, mutually prime
 *  allpass chains plus a few ms of Haas offset. Keeps the mono transient
 *  intact but opens the tail. */
export function stereoize(mono, sr, rng, width = 1) {
  const L = mono.slice(), R = mono.slice();
  allpassChain(L, sr, [5.3, 9.1, 14.9], 0.42 * width);
  allpassChain(R, sr, [6.7, 11.3, 17.3], 0.42 * width);
  const d = Math.floor(0.0011 * sr * width);
  if (d > 0) {
    for (let i = R.length - 1; i >= d; i--) R[i] = R[i - d];
    for (let i = 0; i < d; i++) R[i] = 0;
  }
  // Re-centre the direct transient so the attack stays phase-coherent.
  const nDirect = Math.floor(0.004 * sr);
  for (let i = 0; i < nDirect && i < mono.length; i++) {
    const k = 1 - i / nDirect;
    L[i] = L[i] * (1 - k) + mono[i] * k;
    R[i] = R[i] * (1 - k) + mono[i] * k;
  }
  return [L, R];
}

const hashStr = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
};

// ---------------------------------------------------------------------------
// Impulse responses (used by AudioEngine's space convolver and MusicEngine's
// concert hall). Rendered as exponentially-decaying noise with progressive
// high-frequency damping plus discrete early reflections.
// ---------------------------------------------------------------------------

export function renderIR(sr, o = {}) {
  const dur = o.dur ?? 2.0;
  const n = Math.ceil(sr * dur);
  const predelay = Math.floor((o.predelay ?? 0.012) * sr);
  const damp = o.damp ?? 4200;        // cutoff at t=0
  const dampEnd = o.dampEnd ?? 620;   // cutoff at the tail
  const early = o.early || [];
  const rng = makeRng(o.seed ?? 991);
  const out = [new Float32Array(n), new Float32Array(n)];
  const decay = 6.907755 / Math.max(0.05, dur * (o.decay ?? 0.85));

  for (let c = 0; c < 2; c++) {
    const buf = out[c];
    const lp = new Biquad();
    const hp = new Biquad().highpass(sr, o.hp ?? 90, 0.7);
    // Diffuse late field.
    for (let i = predelay; i < n; i++) {
      const t = (i - predelay) / sr;
      if ((i & 63) === 0) {
        const k = Math.min(1, t / (dur * 0.7));
        lp.lowpass(sr, damp * Math.pow(dampEnd / damp, k), 0.6);
      }
      // Build-up over the first 25 ms so the tail swells rather than clicks.
      const build = Math.min(1, t / 0.025);
      const e = Math.exp(-decay * t) * build;
      buf[i] += hp.process(lp.process(rng() * 2 - 1)) * e;
    }
    // Discrete early reflections give the space its identity (valley walls,
    // ruin masonry) far more than the late tail does.
    for (let k = 0; k < early.length; k++) {
      const er = early[k];
      const jitter = 1 + (rng() - 0.5) * 0.06;
      const d = Math.floor(er.t * jitter * sr) + predelay;
      if (d < n) {
        const w = Math.max(1, Math.floor(0.0016 * sr));
        const erLp = new Biquad().lowpass(sr, er.lp ?? 3000, 0.8);
        for (let i = 0; i < w && d + i < n; i++) {
          buf[d + i] += erLp.process(rng() * 2 - 1) * er.g * (1 - i / w);
        }
      }
    }
  }
  allpassChain(out[0], sr, [8.3, 13.7, 21.1], 0.5);
  allpassChain(out[1], sr, [9.7, 15.1, 23.3], 0.5);
  // Peak-normalise. ConvolverNode does its own power normalisation, but an IR
  // whose samples run well past 1.0 loses precision through the node graph and
  // makes A/B-ing two spaces unpredictable.
  let peak = 0;
  for (let c = 0; c < 2; c++) {
    for (let i = 0; i < n; i++) { const a = Math.abs(out[c][i]); if (a > peak) peak = a; }
  }
  const g = (o.gain ?? 1) * 0.9 / Math.max(1e-9, peak);
  for (let c = 0; c < 2; c++) for (let i = 0; i < n; i++) out[c][i] *= g;
  return out;
}

export const IR_PRESETS = {
  // Wide alpine valley: long, dark, sparse slap off the far ridge.
  outdoor: { dur: 2.6, decay: 0.8, predelay: 0.028, damp: 3200, dampEnd: 380, hp: 110, seed: 4241,
    early: [{ t: 0.055, g: 0.32, lp: 2600 }, { t: 0.118, g: 0.24, lp: 1800 },
            { t: 0.205, g: 0.19, lp: 1300 }, { t: 0.34, g: 0.13, lp: 900 },
            { t: 0.52, g: 0.09, lp: 640 }] },
  // Shelled stone ruin: short, dense, bright, strong early masonry slap.
  ruin: { dur: 1.35, decay: 1.0, predelay: 0.007, damp: 6200, dampEnd: 900, hp: 140, seed: 8123,
    early: [{ t: 0.011, g: 0.5, lp: 6000 }, { t: 0.019, g: 0.42, lp: 5200 },
            { t: 0.031, g: 0.36, lp: 4400 }, { t: 0.048, g: 0.28, lp: 3600 },
            { t: 0.072, g: 0.2, lp: 2800 }] },
  // Music hall — wider, warmer, longer pre-delay for clarity under the strings.
  hall: { dur: 2.9, decay: 0.75, predelay: 0.034, damp: 5200, dampEnd: 700, hp: 70, seed: 1777,
    early: [{ t: 0.021, g: 0.26, lp: 5000 }, { t: 0.037, g: 0.2, lp: 4200 },
            { t: 0.058, g: 0.16, lp: 3400 }] },
};

// ---------------------------------------------------------------------------
// The sound bank
// ---------------------------------------------------------------------------
// v    = number of baked variants (round-robin/random at play time)
// gain = static mix level
// ref/roll/max = PannerNode inverse-distance parameters (metres)
// pri  = voice-steal priority (higher wins)
// cat  = de-dup category for Bus auto-wiring
// pv   = playback-rate jitter (± fraction) applied at trigger time

export const SFX_DEFS = {
  // --- weapons ---
  rifle:        { v: 4, gain: 0.95, ref: 10, roll: 1.05, max: 420, pri: 6, cat: 'gun', pv: 0.045, wet: 0.5 },
  smg:          { v: 4, gain: 0.62, ref: 8,  roll: 1.2,  max: 300, pri: 4, cat: 'gun', pv: 0.06,  wet: 0.4 },
  smgBurst:     { v: 2, gain: 0.7,  ref: 9,  roll: 1.15, max: 330, pri: 6, cat: 'gun', pv: 0.04,  wet: 0.45 },
  mg:           { v: 4, gain: 0.8,  ref: 11, roll: 1.0,  max: 460, pri: 5, cat: 'gun', pv: 0.05,  wet: 0.5 },
  mgBurst:      { v: 2, gain: 0.88, ref: 12, roll: 0.95, max: 500, pri: 7, cat: 'gun', pv: 0.03,  wet: 0.55 },
  sniper:       { v: 3, gain: 1.05, ref: 13, roll: 0.88, max: 620, pri: 8, cat: 'gun', pv: 0.03,  wet: 0.6 },
  lance:        { v: 3, gain: 1.0,  ref: 12, roll: 0.95, max: 520, pri: 8, cat: 'gun', pv: 0.05,  wet: 0.55 },
  tankGun:      { v: 2, gain: 1.2,  ref: 18, roll: 0.7,  max: 950, pri: 10, cat: 'boom', pv: 0.03, wet: 0.75 },
  whizz:        { v: 4, gain: 0.5,  ref: 4,  roll: 1.6,  max: 90,  pri: 3, cat: 'gun', pv: 0.09,  wet: 0.2 },

  // --- impacts ---
  impactDirt:   { v: 4, gain: 0.85,  ref: 6, roll: 1.4, max: 160, pri: 3, cat: 'impact', pv: 0.09, wet: 0.3 },
  impactStone:  { v: 4, gain: 0.62, ref: 6, roll: 1.4, max: 180, pri: 3, cat: 'impact', pv: 0.1,  wet: 0.45 },
  impactWood:   { v: 4, gain: 0.6,  ref: 6, roll: 1.4, max: 170, pri: 3, cat: 'impact', pv: 0.1,  wet: 0.35 },
  impactMetal:  { v: 4, gain: 0.6,  ref: 6, roll: 1.35, max: 220, pri: 4, cat: 'impact', pv: 0.11, wet: 0.5 },
  impactFlesh:  { v: 4, gain: 0.7,  ref: 5, roll: 1.5, max: 120, pri: 4, cat: 'impact', pv: 0.08, wet: 0.2 },
  impactSandbag:{ v: 4, gain: 0.9, ref: 5, roll: 1.5, max: 130, pri: 3, cat: 'impact', pv: 0.09, wet: 0.25 },
  impactWater:  { v: 4, gain: 1.1,  ref: 6, roll: 1.4, max: 150, pri: 3, cat: 'impact', pv: 0.1,  wet: 0.3 },
  ricochet:     { v: 4, gain: 1.1,  ref: 7, roll: 1.25, max: 260, pri: 4, cat: 'impact', pv: 0.14, wet: 0.6 },

  // --- ordnance ---
  explosion:        { v: 3, gain: 1.15, ref: 16, roll: 0.75, max: 800, pri: 10, cat: 'boom', pv: 0.05, wet: 0.7, stereo: true },
  explosionDistant: { v: 2, gain: 0.85, ref: 40, roll: 0.5,  max: 1400, pri: 7, cat: 'boom', pv: 0.06, wet: 0.85, stereo: true },
  grenadePin:       { v: 2, gain: 0.45, ref: 4, roll: 1.6, max: 60, pri: 2, cat: 'foley', pv: 0.08, wet: 0.25 },
  grenadeBounce:    { v: 3, gain: 0.85,  ref: 5, roll: 1.5, max: 90, pri: 3, cat: 'foley', pv: 0.1, wet: 0.35 },

  // --- handling / foley ---
  reload:       { v: 2, gain: 0.55, ref: 4, roll: 1.6, max: 70, pri: 3, cat: 'foley', pv: 0.05, wet: 0.2 },
  reloadMagOut: { v: 2, gain: 0.5,  ref: 4, roll: 1.6, max: 60, pri: 2, cat: 'foley', pv: 0.06, wet: 0.2 },
  reloadMagIn:  { v: 2, gain: 0.5,  ref: 4, roll: 1.6, max: 60, pri: 2, cat: 'foley', pv: 0.06, wet: 0.2 },
  reloadBolt:   { v: 2, gain: 0.52, ref: 4, roll: 1.6, max: 65, pri: 2, cat: 'foley', pv: 0.06, wet: 0.2 },
  footGrass:    { v: 4, gain: 0.8, ref: 3, roll: 1.9, max: 45, pri: 1, cat: 'foot', pv: 0.13, wet: 0.15 },
  footDirt:     { v: 4, gain: 0.82, ref: 3, roll: 1.9, max: 45, pri: 1, cat: 'foot', pv: 0.13, wet: 0.15 },
  footStone:    { v: 4, gain: 0.5, ref: 3, roll: 1.85, max: 55, pri: 1, cat: 'foot', pv: 0.13, wet: 0.35 },
  footWood:     { v: 4, gain: 0.38, ref: 3, roll: 1.85, max: 50, pri: 1, cat: 'foot', pv: 0.13, wet: 0.25 },
  footWater:    { v: 4, gain: 0.95,  ref: 3, roll: 1.85, max: 55, pri: 1, cat: 'foot', pv: 0.13, wet: 0.2 },
  cloth:        { v: 4, gain: 0.75,  ref: 3, roll: 2.0, max: 35, pri: 1, cat: 'foley', pv: 0.14, wet: 0.12 },
  bodyFall:     { v: 3, gain: 0.75, ref: 6, roll: 1.4, max: 140, pri: 5, cat: 'foley', pv: 0.07, wet: 0.3 },
  trackSqueak:  { v: 4, gain: 0.6,  ref: 7, roll: 1.3, max: 180, pri: 2, cat: 'foley', pv: 0.12, wet: 0.35 },

  // --- UI (2D, non-spatial) ---
  uiPage:      { v: 3, gain: 1.35,  spatial: false, pri: 4, cat: 'ui', pv: 0.05 },
  uiStamp:     { v: 2, gain: 0.65, spatial: false, pri: 5, cat: 'ui', pv: 0.04 },
  uiRibbon:    { v: 2, gain: 1.5, spatial: false, pri: 3, cat: 'ui', pv: 0.05 },
  uiTick:      { v: 3, gain: 0.34, spatial: false, pri: 2, cat: 'ui', pv: 0.07 },
  uiConfirm:   { v: 1, gain: 0.46, spatial: false, pri: 5, cat: 'ui', pv: 0.02 },
  uiCancel:    { v: 1, gain: 0.42, spatial: false, pri: 4, cat: 'ui', pv: 0.02 },
  uiCp:        { v: 2, gain: 0.44, spatial: false, pri: 4, cat: 'ui', pv: 0.03 },
  uiAlert:     { v: 1, gain: 0.7,  spatial: false, pri: 9, cat: 'ui', pv: 0.01, stereo: true },
  uiRankStamp: { v: 1, gain: 0.85, spatial: false, pri: 9, cat: 'ui', pv: 0.01, stereo: true },
};

/** Aliases so other systems can emit whatever reads naturally. */
export const SFX_ALIASES = {
  shot: 'rifle', gunshot: 'rifle', gun: 'rifle', fire: 'rifle',
  rifleShot: 'rifle', scout: 'smg', shock: 'smg', smgShot: 'smg',
  machinegun: 'mg', machineGun: 'mg', hmg: 'mg',
  rocket: 'lance', lancer: 'lance', launcher: 'lance', at: 'lance',
  snipe: 'sniper', sniperShot: 'sniper',
  tank: 'tankGun', cannon: 'tankGun', tankShot: 'tankGun', mortar: 'tankGun',
  bulletWhizz: 'whizz', flyby: 'whizz', crack: 'whizz',
  hit: 'impactDirt', impact: 'impactDirt', bulletHit: 'impactDirt',
  hitFlesh: 'impactFlesh', hitMetal: 'impactMetal', hitStone: 'impactStone',
  hitWood: 'impactWood', hitDirt: 'impactDirt', hitWater: 'impactWater',
  boom: 'explosion', blast: 'explosion', grenade: 'explosion', explode: 'explosion',
  artillery: 'explosionDistant', distantBoom: 'explosionDistant',
  pin: 'grenadePin', bounce: 'grenadeBounce',
  magOut: 'reloadMagOut', magIn: 'reloadMagIn', bolt: 'reloadBolt',
  step: 'footGrass', footstep: 'footGrass', foot: 'footGrass',
  rustle: 'cloth', death: 'bodyFall', downed: 'bodyFall', fall: 'bodyFall',
  squeak: 'trackSqueak', treads: 'trackSqueak',
  page: 'uiPage', pageTurn: 'uiPage', stamp: 'uiStamp', ribbon: 'uiRibbon',
  cursor: 'uiTick', tick: 'uiTick', hover: 'uiTick', move: 'uiTick',
  confirm: 'uiConfirm', accept: 'uiConfirm', select: 'uiConfirm', ok: 'uiConfirm',
  cancel: 'uiCancel', back: 'uiCancel', deny: 'uiCancel',
  cp: 'uiCp', cpSpend: 'uiCp', order: 'uiStamp',
  alert: 'uiAlert', sting: 'uiAlert', warning: 'uiAlert', intercept: 'uiAlert',
  rank: 'uiRankStamp', rankStamp: 'uiRankStamp', result: 'uiRankStamp',
};

/** `shot:hit` payload material -> impact sound. */
export const MATERIAL_IMPACT = {
  dirt: 'impactDirt', soil: 'impactDirt', ground: 'impactDirt', grass: 'impactDirt',
  gravel: 'impactDirt', mud: 'impactDirt',
  stone: 'impactStone', rock: 'impactStone', concrete: 'impactStone',
  brick: 'impactStone', masonry: 'impactStone', wall: 'impactStone',
  wood: 'impactWood', plank: 'impactWood', crate: 'impactWood', fence: 'impactWood',
  metal: 'impactMetal', steel: 'impactMetal', armour: 'impactMetal',
  armor: 'impactMetal', tank: 'impactMetal', vehicle: 'impactMetal',
  flesh: 'impactFlesh', body: 'impactFlesh', unit: 'impactFlesh', infantry: 'impactFlesh',
  sandbag: 'impactSandbag', sand: 'impactSandbag', cloth: 'impactSandbag',
  water: 'impactWater', river: 'impactWater',
};

/** Class -> primary weapon sound, for `shot:fired` auto-wiring. */
export const WEAPON_SFX = {
  rifle: 'rifle', scout: 'rifle', smg: 'smg', shock: 'smg', mg: 'mg',
  hmg: 'mg', sniper: 'sniper', lance: 'lance', lancer: 'lance',
  engineer: 'rifle', tank: 'tankGun', cannon: 'tankGun', mortar: 'tankGun',
};

export function resolveSfxName(name, material) {
  if (!name) return material ? (MATERIAL_IMPACT[material] || 'impactDirt') : null;
  if (SFX_DEFS[name]) {
    if (material && name.startsWith('impact')) return MATERIAL_IMPACT[material] || name;
    return name;
  }
  const a = SFX_ALIASES[name];
  if (a) {
    if (material && a.startsWith('impact')) return MATERIAL_IMPACT[material] || a;
    return a;
  }
  if (material && MATERIAL_IMPACT[material]) return MATERIAL_IMPACT[material];
  return null;
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------
// Each returns a mono Float32Array (or [L,R] when SFX_DEFS marks it stereo).
// `v` is the variant index; sounds vary tuning/decay per variant so repeated
// gunfire never sounds machine-stamped.

const GEN = {

  // Gallian bolt/semi rifle: hard supersonic transient, receiver body, valley slap.
  rifle(sr, rng, v) {
    const b = monoBuf(sr, 1.15);
    const dt = 1 + (v - 1.5) * 0.028;
    noiseBurst(b, sr, rng, { dur: 0.028, amp: 0.95, type: 'hp', f0: 2600, q: 0.9, curve: 42 });
    tone(b, sr, { dur: 0.07, f0: 1500 * dt, f1: 112, amp: 0.62, curve: 24, drive: 0.55 });
    noiseBurst(b, sr, rng, { dur: 0.24, amp: 0.5, type: 'lp', f0: 6200, f1: 850, q: 0.95, curve: 12 });
    modalHit(b, sr, rng, {
      freqs: [158 * dt, 384 * dt, 731 * dt, 1265 * dt],
      t60s: [0.095, 0.062, 0.041, 0.03], amps: [1, 0.6, 0.4, 0.24],
      amp: 0.34, exciteDur: 0.004, dur: 0.3,
    });
    noiseBurst(b, sr, rng, { t0: 0.045, dur: 0.72, amp: 0.1, type: 'lp', f0: 2400, f1: 480, curve: 5 });
    addTaps(b, sr, [{ t: 0.086, g: 0.3, lp: 2600 }, { t: 0.191, g: 0.16, lp: 1500 },
                    { t: 0.372, g: 0.085, lp: 880 }]);
    allpassChain(b, sr, [6.1, 11.3], 0.3);
    softLimit(b); fadeEdges(b, sr);
    return b;
  },

  // SMG: less powder, brighter, snappier, almost no tail.
  smg(sr, rng, v) {
    const b = monoBuf(sr, 0.6);
    const dt = 1 + (v - 1.5) * 0.04;
    noiseBurst(b, sr, rng, { dur: 0.018, amp: 0.8, type: 'hp', f0: 3200, q: 0.9, curve: 55 });
    tone(b, sr, { dur: 0.045, f0: 1750 * dt, f1: 190, amp: 0.45, curve: 30, drive: 0.4 });
    noiseBurst(b, sr, rng, { dur: 0.13, amp: 0.42, type: 'lp', f0: 7200, f1: 1400, q: 1.0, curve: 18 });
    modalHit(b, sr, rng, {
      freqs: [246 * dt, 612 * dt, 1180 * dt], t60s: [0.05, 0.035, 0.024],
      amps: [1, 0.55, 0.3], amp: 0.24, dur: 0.16,
    });
    noiseBurst(b, sr, rng, { t0: 0.03, dur: 0.3, amp: 0.07, type: 'lp', f0: 2000, f1: 600, curve: 7 });
    addTaps(b, sr, [{ t: 0.072, g: 0.2, lp: 2200 }, { t: 0.165, g: 0.1, lp: 1200 }]);
    softLimit(b); fadeEdges(b, sr);
    return b;
  },

  // Heavier MG: more low-end thump and receiver mass than the SMG.
  mg(sr, rng, v) {
    const b = monoBuf(sr, 0.85);
    const dt = 1 + (v - 1.5) * 0.03;
    noiseBurst(b, sr, rng, { dur: 0.022, amp: 0.9, type: 'hp', f0: 2400, q: 0.9, curve: 46 });
    tone(b, sr, { dur: 0.08, f0: 1200 * dt, f1: 88, amp: 0.68, curve: 20, drive: 0.62 });
    noiseBurst(b, sr, rng, { dur: 0.2, amp: 0.5, type: 'lp', f0: 5400, f1: 700, q: 0.95, curve: 13 });
    modalHit(b, sr, rng, {
      freqs: [126 * dt, 289 * dt, 574 * dt, 1010 * dt], t60s: [0.11, 0.07, 0.05, 0.032],
      amps: [1, 0.62, 0.42, 0.25], amp: 0.4, dur: 0.32,
    });
    noiseBurst(b, sr, rng, { t0: 0.04, dur: 0.5, amp: 0.09, type: 'lp', f0: 2100, f1: 420, curve: 6 });
    addTaps(b, sr, [{ t: 0.093, g: 0.26, lp: 2300 }, { t: 0.21, g: 0.14, lp: 1300 }]);
    softLimit(b); fadeEdges(b, sr);
    return b;
  },

  // Anti-tank sniper: whip-crack transient, long ridge echo, minimal body.
  sniper(sr, rng, v) {
    const b = monoBuf(sr, 2.1);
    const dt = 1 + (v - 1) * 0.03;
    noiseBurst(b, sr, rng, { dur: 0.014, amp: 1.0, type: 'hp', f0: 4200, q: 1.1, curve: 70 });
    tone(b, sr, { dur: 0.055, f0: 2300 * dt, f1: 150, amp: 0.6, curve: 30, drive: 0.7 });
    noiseBurst(b, sr, rng, { dur: 0.3, amp: 0.52, type: 'lp', f0: 8000, f1: 620, q: 0.9, curve: 10 });
    modalHit(b, sr, rng, {
      freqs: [174 * dt, 452 * dt, 905 * dt], t60s: [0.13, 0.08, 0.05],
      amps: [1, 0.5, 0.3], amp: 0.3, dur: 0.36,
    });
    // Two ridges + a far treeline: progressively darker, wider spaced.
    addTaps(b, sr, [{ t: 0.278, g: 0.3, lp: 900, hp: 120 },
                    { t: 0.549, g: 0.19, lp: 620, hp: 110 },
                    { t: 0.951, g: 0.11, lp: 430, hp: 100 },
                    { t: 1.44, g: 0.06, lp: 300, hp: 90 }]);
    allpassChain(b, sr, [13.3, 19.7, 27.1], 0.45);
    softLimit(b); fadeEdges(b, sr, 0.6, 25);
    return b;
  },

  // Lancer rocket: ignition crack, chest thump, sustained motor roar.
  lance(sr, rng, v) {
    const b = monoBuf(sr, 1.9);
    const dt = 1 + (v - 1) * 0.05;
    noiseBurst(b, sr, rng, { dur: 0.02, amp: 0.7, type: 'hp', f0: 2000, curve: 40 });
    noiseBurst(b, sr, rng, { dur: 0.14, amp: 0.8, type: 'lp', f0: 4200, f1: 1100, q: 0.9, curve: 11 });
    tone(b, sr, { dur: 0.38, f0: 138 * dt, f1: 46, amp: 0.66, curve: 5, drive: 0.75 });
    // Motor: band-limited roar sliding down as the rocket departs.
    noiseBurst(b, sr, rng, { t0: 0.025, dur: 1.25, amp: 0.46, type: 'bp',
      f0: 980 * dt, f1: 240, q: 1.5, curve: 2.4, attack: 0.02 });
    noiseBurst(b, sr, rng, { t0: 0.03, dur: 1.1, amp: 0.2, type: 'lp',
      f0: 3200, f1: 900, curve: 2.6, attack: 0.03 });
    tone(b, sr, { t0: 0.05, dur: 0.9, f0: 92, f1: 58, amp: 0.14, curve: 2.2,
      attack: 0.05, fm: 0.06, fmRate: 27, wave: 'saw' });
    addTaps(b, sr, [{ t: 0.16, g: 0.18, lp: 1400 }, { t: 0.36, g: 0.1, lp: 800 }]);
    softLimit(b); fadeEdges(b, sr, 0.6, 20);
    return b;
  },

  // Tank main gun: the biggest thing in the mix. Sub-heavy, valley echo tail.
  tankGun(sr, rng, v) {
    const b = monoBuf(sr, 3.5);
    const dt = 1 + (v - 0.5) * 0.04;
    noiseBurst(b, sr, rng, { dur: 0.045, amp: 0.85, type: 'hp', f0: 1800, q: 0.9, curve: 38 });
    noiseBurst(b, sr, rng, { dur: 0.95, amp: 0.9, type: 'lp', f0: 3600, f1: 165, q: 0.8, curve: 6 });
    tone(b, sr, { dur: 0.9, f0: 224 * dt, f1: 37, amp: 1.0, curve: 3.6, drive: 0.85 });
    tone(b, sr, { dur: 1.7, f0: 88 * dt, f1: 25, amp: 0.72, curve: 2.0, drive: 0.5 });
    tone(b, sr, { t0: 0.004, dur: 0.16, f0: 620, f1: 190, amp: 0.35, curve: 16, drive: 0.6 });
    // Muzzle-brake blast returning off the valley sides.
    addTaps(b, sr, [{ t: 0.223, g: 0.36, lp: 950, hp: 70 },
                    { t: 0.497, g: 0.24, lp: 640, hp: 65 },
                    { t: 0.953, g: 0.15, lp: 420, hp: 60 },
                    { t: 1.61, g: 0.085, lp: 290, hp: 55 },
                    { t: 2.33, g: 0.04, lp: 220, hp: 50 }]);
    allpassChain(b, sr, [17.3, 26.1, 37.7], 0.52);
    softLimit(b, 0.66); fadeEdges(b, sr, 0.6, 40);
    return b;
  },

  // Supersonic bullet passing close: crack riding on a descending band of air.
  whizz(sr, rng, v) {
    const b = monoBuf(sr, 0.5);
    const c = 0.14 + v * 0.012;                  // time of closest approach
    const dt = 1 + (v - 1.5) * 0.12;
    // Approach: rising band. Recede: falling band. The crack sits at the apex.
    noiseBurst(b, sr, rng, { dur: c, amp: 0.4, type: 'bp',
      f0: 900 * dt, f1: 3400 * dt, q: 4.5, curve: -2.2, attack: 0.02 });
    noiseBurst(b, sr, rng, { t0: c, dur: 0.34, amp: 0.5, type: 'bp',
      f0: 3200 * dt, f1: 620 * dt, q: 5.0, curve: 7 });
    noiseBurst(b, sr, rng, { t0: c - 0.004, dur: 0.02, amp: 0.55, type: 'hp',
      f0: 4600, q: 0.9, curve: 60 });
    tone(b, sr, { t0: c - 0.003, dur: 0.05, f0: 2400 * dt, f1: 420, amp: 0.22, curve: 26 });
    softLimit(b, 0.8); fadeEdges(b, sr, 2, 8);
    return b;
  },

  // --- impacts -------------------------------------------------------------

  impactDirt(sr, rng, v) {
    const b = monoBuf(sr, 0.55);
    const dt = 1 + (v - 1.5) * 0.1;
    noiseBurst(b, sr, rng, { dur: 0.11, amp: 1.25, type: 'lp', f0: 1500 * dt, f1: 250, q: 0.8, curve: 15 });
    tone(b, sr, { dur: 0.075, f0: 168 * dt, f1: 68, amp: 0.34, curve: 18, drive: 0.3 });
    scatter(rng, 6, 0.05, 0.34, (t) => {
      noiseBurst(b, sr, rng, { t0: t, dur: 0.022, amp: 0.05 + rng() * 0.07,
        type: 'hp', f0: 2200 + rng() * 2600, curve: 30 });
    });
    softLimit(b, 0.85); fadeEdges(b, sr);
    return b;
  },

  impactStone(sr, rng, v) {
    const b = monoBuf(sr, 0.6);
    const dt = 1 + (v - 1.5) * 0.11;
    noiseBurst(b, sr, rng, { dur: 0.016, amp: 0.85, type: 'hp', f0: 3200, curve: 60 });
    modalHit(b, sr, rng, {
      freqs: [1460 * dt, 2680 * dt, 4230 * dt, 5910 * dt],
      t60s: [0.062, 0.045, 0.03, 0.02], amps: [1, 0.7, 0.45, 0.28],
      amp: 0.72, exciteDur: 0.002, exciteLp: 12000, dur: 0.2,
    });
    noiseBurst(b, sr, rng, { dur: 0.09, amp: 0.7, type: 'bp', f0: 2400 * dt, f1: 900, q: 1.2, curve: 20 });
    tone(b, sr, { dur: 0.05, f0: 240, f1: 120, amp: 0.16, curve: 22 });
    scatter(rng, 5, 0.03, 0.3, (t) => {
      noiseBurst(b, sr, rng, { t0: t, dur: 0.016, amp: 0.05 + rng() * 0.06,
        type: 'bp', f0: 3000 + rng() * 4000, q: 3, curve: 34 });
    });
    softLimit(b, 0.85); fadeEdges(b, sr);
    return b;
  },

  impactWood(sr, rng, v) {
    const b = monoBuf(sr, 0.55);
    const dt = 1 + (v - 1.5) * 0.12;
    modalHit(b, sr, rng, {
      freqs: [232 * dt, 548 * dt, 981 * dt, 1637 * dt],
      t60s: [0.125, 0.088, 0.058, 0.038], amps: [1, 0.68, 0.42, 0.24],
      amp: 0.8, exciteDur: 0.0032, exciteLp: 5200, dur: 0.35,
    });
    noiseBurst(b, sr, rng, { dur: 0.055, amp: 0.42, type: 'bp', f0: 2400, f1: 1100, q: 1.0, curve: 26 });
    scatter(rng, 4, 0.02, 0.18, (t) => {
      noiseBurst(b, sr, rng, { t0: t, dur: 0.02, amp: 0.04 + rng() * 0.05,
        type: 'hp', f0: 2600 + rng() * 2200, curve: 32 });
    });
    softLimit(b, 0.85); fadeEdges(b, sr);
    return b;
  },

  impactMetal(sr, rng, v) {
    const b = monoBuf(sr, 0.95);
    const dt = 1 + (v - 1.5) * 0.13;
    noiseBurst(b, sr, rng, { dur: 0.01, amp: 0.75, type: 'hp', f0: 4400, curve: 75 });
    modalHit(b, sr, rng, {
      // Slightly inharmonic ratios — plate steel, not a tuned bell.
      freqs: [1748 * dt, 2977 * dt, 4312 * dt, 6251 * dt, 8104 * dt],
      t60s: [0.42, 0.31, 0.22, 0.15, 0.1], amps: [1, 0.72, 0.5, 0.3, 0.18],
      amp: 0.62, exciteDur: 0.0018, exciteLp: 14000, dur: 0.75,
    });
    // The "tang": a shallow downward glide across the ring.
    tone(b, sr, { dur: 0.19, f0: 3260 * dt, f1: 2780 * dt, amp: 0.11, curve: 12 });
    tone(b, sr, { dur: 0.07, f0: 320, f1: 150, amp: 0.2, curve: 20, drive: 0.3 });
    softLimit(b, 0.85); fadeEdges(b, sr, 0.6, 12);
    return b;
  },

  impactFlesh(sr, rng, v) {
    const b = monoBuf(sr, 0.4);
    const dt = 1 + (v - 1.5) * 0.09;
    noiseBurst(b, sr, rng, { dur: 0.085, amp: 0.9, type: 'lp', f0: 760 * dt, f1: 170, q: 0.9, curve: 19 });
    tone(b, sr, { dur: 0.1, f0: 126 * dt, f1: 58, amp: 0.38, curve: 16, drive: 0.35 });
    // Wet band — the difference between "thud" and "hit".
    noiseBurst(b, sr, rng, { t0: 0.004, dur: 0.055, amp: 0.26, type: 'bp',
      f0: 980 * dt, f1: 620, q: 2.4, curve: 24 });
    noiseBurst(b, sr, rng, { t0: 0.01, dur: 0.12, amp: 0.08, type: 'bp', f0: 2400, q: 1.4, curve: 20 });
    softLimit(b, 0.85); fadeEdges(b, sr);
    return b;
  },

  impactSandbag(sr, rng, v) {
    const b = monoBuf(sr, 0.45);
    const dt = 1 + (v - 1.5) * 0.1;
    noiseBurst(b, sr, rng, { dur: 0.1, amp: 1.6, type: 'lp', f0: 980 * dt, f1: 210, q: 0.75, curve: 17 });
    tone(b, sr, { dur: 0.06, f0: 130, f1: 62, amp: 0.36, curve: 22 });
    // Sand grains spilling — many tiny high bursts, density decaying.
    scatter(rng, 16, 0.015, 0.3, (t) => {
      noiseBurst(b, sr, rng, { t0: t, dur: 0.012, amp: 0.025 + rng() * 0.04,
        type: 'hp', f0: 4000 + rng() * 4000, curve: 40 });
    });
    softLimit(b, 0.85); fadeEdges(b, sr);
    return b;
  },

  impactWater(sr, rng, v) {
    const b = monoBuf(sr, 0.75);
    const dt = 1 + (v - 1.5) * 0.1;
    noiseBurst(b, sr, rng, { dur: 0.13, amp: 1.4, type: 'bp',
      f0: 420 * dt, f1: 2600 * dt, q: 0.9, curve: 12 });
    noiseBurst(b, sr, rng, { dur: 0.06, amp: 0.7, type: 'lp', f0: 1400, f1: 500, curve: 22 });
    tone(b, sr, { dur: 0.05, f0: 190, f1: 95, amp: 0.16, curve: 20 });
    // Droplets: short rising sines, the classic water-blip cue.
    scatter(rng, 7, 0.08, 0.45, (t) => {
      const f = 1500 + rng() * 2400;
      tone(b, sr, { t0: t, dur: 0.035, f0: f * 0.7, f1: f * 1.35,
        amp: 0.05 + rng() * 0.06, curve: 16 });
    });
    softLimit(b, 0.85); fadeEdges(b, sr);
    return b;
  },

  // Ricochet: a high-Q band swept across the spectrum = the classic whine.
  ricochet(sr, rng, v) {
    const b = monoBuf(sr, 0.85);
    const up = (v & 1) === 1;
    const f0 = 2200 + rng() * 900;
    const f1 = up ? f0 * (2.4 + rng()) : f0 / (2.2 + rng());
    noiseBurst(b, sr, rng, { dur: 0.02, amp: 0.6, type: 'hp', f0: 3600, curve: 55 });
    noiseBurst(b, sr, rng, { dur: 0.42, amp: 1.7, type: 'bp', f0, f1, q: 13, curve: 4.5, attack: 0.004 });
    noiseBurst(b, sr, rng, { t0: 0.01, dur: 0.34, amp: 0.7, type: 'bp',
      f0: f0 * 1.98, f1: f1 * 1.98, q: 11, curve: 5.5, attack: 0.006 });
    noiseBurst(b, sr, rng, { dur: 0.05, amp: 0.3, type: 'bp', f0: 1400, f1: 800, q: 1.4, curve: 24 });
    addTaps(b, sr, [{ t: 0.13, g: 0.2, lp: 3200 }, { t: 0.27, g: 0.11, lp: 1800 }]);
    softLimit(b, 0.8); fadeEdges(b, sr, 0.6, 14);
    return b;
  },

  // --- ordnance ------------------------------------------------------------

  explosion(sr, rng, v) {
    const b = monoBuf(sr, 3.1);
    const dt = 1 + (v - 1) * 0.06;
    noiseBurst(b, sr, rng, { dur: 0.03, amp: 0.9, type: 'hp', f0: 2200, curve: 52 });
    noiseBurst(b, sr, rng, { dur: 1.15, amp: 0.95, type: 'lp', f0: 5200, f1: 130, q: 0.8, curve: 4.6 });
    tone(b, sr, { dur: 1.05, f0: 128 * dt, f1: 28, amp: 0.95, curve: 3.1, drive: 0.9 });
    tone(b, sr, { dur: 2.0, f0: 58 * dt, f1: 21, amp: 0.5, curve: 1.7, drive: 0.4 });
    // Debris rain — dirt clods and stone chips landing over ~1.5 s.
    scatter(rng, 22, 0.22, 1.7, (t) => {
      const hard = rng() < 0.35;
      if (hard) {
        modalHit(b, sr, rng, { t0: t, freqs: [900 + rng() * 2600, 1900 + rng() * 3000],
          t60s: [0.03, 0.02], amps: [1, 0.5], amp: 0.07, dur: 0.09 });
      } else {
        noiseBurst(b, sr, rng, { t0: t, dur: 0.05, amp: 0.03 + rng() * 0.05,
          type: 'lp', f0: 900 + rng() * 1400, f1: 260, curve: 18 });
      }
    });
    addTaps(b, sr, [{ t: 0.181, g: 0.34, lp: 1200, hp: 70 },
                    { t: 0.423, g: 0.23, lp: 760, hp: 65 },
                    { t: 0.857, g: 0.14, lp: 470, hp: 60 },
                    { t: 1.52, g: 0.08, lp: 310, hp: 55 }]);
    allpassChain(b, sr, [14.7, 23.3, 33.1], 0.5);
    softLimit(b, 0.66); fadeEdges(b, sr, 0.6, 40);
    return stereoLimit(stereoize(b, sr, rng, 1), 0.66);
  },

  // Off-map artillery: no transient at all, just a filtered rolling rumble.
  explosionDistant(sr, rng, v) {
    const b = monoBuf(sr, 3.8);
    const dt = 1 + (v - 0.5) * 0.08;
    noiseBurst(b, sr, rng, { dur: 2.3, amp: 0.85, type: 'lp',
      f0: 620 * dt, f1: 95, q: 0.7, curve: 1.5, attack: 0.055 });
    tone(b, sr, { dur: 2.4, f0: 46 * dt, f1: 19, amp: 0.55, curve: 1.5, attack: 0.08, drive: 0.25 });
    tone(b, sr, { t0: 0.06, dur: 1.5, f0: 82, f1: 33, amp: 0.28, curve: 2.1, attack: 0.05 });
    // Two later rolls — the sound bending back off the far ridges.
    noiseBurst(b, sr, rng, { t0: 0.55, dur: 1.6, amp: 0.3, type: 'lp',
      f0: 380, f1: 90, curve: 1.8, attack: 0.12 });
    noiseBurst(b, sr, rng, { t0: 1.25, dur: 1.9, amp: 0.16, type: 'lp',
      f0: 260, f1: 75, curve: 1.5, attack: 0.2 });
    allpassChain(b, sr, [23.3, 37.1, 51.7], 0.58);
    softLimit(b, 0.7); fadeEdges(b, sr, 5, 60);
    return stereoLimit(stereoize(b, sr, rng, 1.4), 0.7);
  },

  grenadePin(sr, rng, v) {
    const b = monoBuf(sr, 0.35);
    const dt = 1 + (v - 0.5) * 0.07;
    modalHit(b, sr, rng, {
      freqs: [2430 * dt, 3810 * dt, 5240 * dt], t60s: [0.055, 0.034, 0.022],
      amps: [1, 0.6, 0.35], amp: 0.5, exciteDur: 0.0012, dur: 0.14,
    });
    // Spring uncoiling.
    noiseBurst(b, sr, rng, { t0: 0.006, dur: 0.11, amp: 0.16, type: 'bp',
      f0: 3100, f1: 2200, q: 7, curve: 14 });
    noiseBurst(b, sr, rng, { dur: 0.012, amp: 0.3, type: 'hp', f0: 4200, curve: 60 });
    softLimit(b, 0.85); fadeEdges(b, sr);
    return b;
  },

  grenadeBounce(sr, rng, v) {
    const b = monoBuf(sr, 1.0);
    const times = [0, 0.19 + v * 0.02, 0.34 + v * 0.03, 0.45 + v * 0.035];
    const gains = [1, 0.6, 0.34, 0.18];
    for (let i = 0; i < times.length; i++) {
      const dt = 1 + i * 0.02;
      modalHit(b, sr, rng, {
        t0: times[i], freqs: [842 * dt, 1517 * dt, 2411 * dt],
        t60s: [0.05, 0.034, 0.022], amps: [1, 0.55, 0.3],
        amp: 0.5 * gains[i], exciteDur: 0.0015, dur: 0.13,
      });
      noiseBurst(b, sr, rng, { t0: times[i], dur: 0.05, amp: 0.3 * gains[i],
        type: 'lp', f0: 1300, f1: 320, curve: 20 });
      tone(b, sr, { t0: times[i], dur: 0.04, f0: 190, f1: 90, amp: 0.14 * gains[i], curve: 22 });
    }
    softLimit(b, 0.85); fadeEdges(b, sr);
    return b;
  },

  // --- handling ------------------------------------------------------------

  reloadMagOut(sr, rng, v) {
    const b = monoBuf(sr, 0.62);
    _magOut(b, sr, rng, 0, v);
    softLimit(b, 0.85); fadeEdges(b, sr);
    return b;
  },
  reloadMagIn(sr, rng, v) {
    const b = monoBuf(sr, 0.62);
    _magIn(b, sr, rng, 0, v);
    softLimit(b, 0.85); fadeEdges(b, sr);
    return b;
  },
  reloadBolt(sr, rng, v) {
    const b = monoBuf(sr, 0.7);
    _bolt(b, sr, rng, 0, v);
    softLimit(b, 0.85); fadeEdges(b, sr);
    return b;
  },
  // Full sequence, baked as one buffer so a reload is a single voice.
  reload(sr, rng, v) {
    const b = monoBuf(sr, 2.1);
    _magOut(b, sr, rng, 0.0, v);
    _magIn(b, sr, rng, 0.56 + v * 0.03, v);
    _bolt(b, sr, rng, 1.19 + v * 0.04, v);
    noiseBurst(b, sr, rng, { t0: 0.3, dur: 0.2, amp: 0.06, type: 'bp',
      f0: 3400, q: 0.8, curve: 8, attack: 0.04 });     // cloth of the sleeve
    softLimit(b, 0.85); fadeEdges(b, sr);
    return b;
  },

  // --- footsteps -----------------------------------------------------------

  footGrass(sr, rng, v) {
    const b = monoBuf(sr, 0.4);
    const dt = 1 + (v - 1.5) * 0.13;
    noiseBurst(b, sr, rng, { dur: 0.085, amp: 0.78, type: 'bp',
      f0: 2600 * dt, f1: 1500, q: 0.75, curve: 16, attack: 0.003 });
    noiseBurst(b, sr, rng, { dur: 0.06, amp: 0.52, type: 'lp', f0: 700, f1: 240, curve: 20 });
    tone(b, sr, { dur: 0.05, f0: 118 * dt, f1: 62, amp: 0.14, curve: 22 });
    scatter(rng, 7, 0.005, 0.16, (t) => {
      noiseBurst(b, sr, rng, { t0: t, dur: 0.01, amp: 0.03 + rng() * 0.05,
        type: 'hp', f0: 4200 + rng() * 3500, curve: 46 });
    });
    softLimit(b, 0.85); fadeEdges(b, sr);
    return b;
  },

  footDirt(sr, rng, v) {
    const b = monoBuf(sr, 0.4);
    const dt = 1 + (v - 1.5) * 0.12;
    noiseBurst(b, sr, rng, { dur: 0.09, amp: 0.85, type: 'lp',
      f0: 1000 * dt, f1: 280, q: 0.8, curve: 16 });
    tone(b, sr, { dur: 0.06, f0: 132 * dt, f1: 64, amp: 0.26, curve: 20, drive: 0.25 });
    scatter(rng, 8, 0.01, 0.2, (t) => {
      noiseBurst(b, sr, rng, { t0: t, dur: 0.012, amp: 0.02 + rng() * 0.04,
        type: 'hp', f0: 2600 + rng() * 3000, curve: 40 });
    });
    softLimit(b, 0.85); fadeEdges(b, sr);
    return b;
  },

  footStone(sr, rng, v) {
    const b = monoBuf(sr, 0.5);
    const dt = 1 + (v - 1.5) * 0.11;
    noiseBurst(b, sr, rng, { dur: 0.014, amp: 0.5, type: 'hp', f0: 2800, curve: 55 });
    modalHit(b, sr, rng, {
      freqs: [910 * dt, 2140 * dt, 3620 * dt], t60s: [0.055, 0.033, 0.02],
      amps: [1, 0.55, 0.3], amp: 0.42, exciteDur: 0.0018, dur: 0.18,
    });
    noiseBurst(b, sr, rng, { dur: 0.05, amp: 0.3, type: 'bp', f0: 1900, f1: 900, q: 1.1, curve: 24 });
    tone(b, sr, { dur: 0.045, f0: 150, f1: 78, amp: 0.16, curve: 22 });
    addTaps(b, sr, [{ t: 0.032, g: 0.16, lp: 3600 }, { t: 0.061, g: 0.09, lp: 2400 }]);
    softLimit(b, 0.85); fadeEdges(b, sr);
    return b;
  },

  footWood(sr, rng, v) {
    const b = monoBuf(sr, 0.55);
    const dt = 1 + (v - 1.5) * 0.12;
    modalHit(b, sr, rng, {
      freqs: [184 * dt, 421 * dt, 786 * dt, 1310 * dt],
      t60s: [0.135, 0.09, 0.06, 0.038], amps: [1, 0.6, 0.36, 0.2],
      amp: 0.6, exciteDur: 0.004, exciteLp: 4200, dur: 0.36,
    });
    noiseBurst(b, sr, rng, { dur: 0.04, amp: 0.28, type: 'bp', f0: 2000, f1: 1000, q: 1.0, curve: 28 });
    softLimit(b, 0.85); fadeEdges(b, sr);
    return b;
  },

  footWater(sr, rng, v) {
    const b = monoBuf(sr, 0.65);
    const dt = 1 + (v - 1.5) * 0.1;
    noiseBurst(b, sr, rng, { dur: 0.15, amp: 0.95, type: 'bp',
      f0: 520 * dt, f1: 2900 * dt, q: 0.85, curve: 10, attack: 0.004 });
    noiseBurst(b, sr, rng, { dur: 0.07, amp: 0.36, type: 'lp', f0: 1200, f1: 380, curve: 20 });
    scatter(rng, 6, 0.06, 0.36, (t) => {
      const f = 1300 + rng() * 2200;
      tone(b, sr, { t0: t, dur: 0.03, f0: f * 0.72, f1: f * 1.3,
        amp: 0.04 + rng() * 0.05, curve: 18 });
    });
    softLimit(b, 0.85); fadeEdges(b, sr);
    return b;
  },

  // --- body foley ----------------------------------------------------------

  cloth(sr, rng, v) {
    const b = monoBuf(sr, 0.5);
    const n = 3 + (v & 1);
    for (let i = 0; i < n; i++) {
      const t = i * (0.055 + rng() * 0.05);
      noiseBurst(b, sr, rng, { t0: t, dur: 0.1 + rng() * 0.08,
        amp: 0.36 + rng() * 0.22, type: 'bp',
        f0: 2600 + rng() * 2200, f1: 1400 + rng() * 1200,
        q: 0.65, curve: 9, attack: 0.012, hp: 900 });
    }
    softLimit(b, 0.85); fadeEdges(b, sr, 2, 12);
    return b;
  },

  bodyFall(sr, rng, v) {
    const b = monoBuf(sr, 1.35);
    const dt = 1 + (v - 1) * 0.06;
    // Torso.
    noiseBurst(b, sr, rng, { dur: 0.19, amp: 0.85, type: 'lp', f0: 720, f1: 140, q: 0.85, curve: 12 });
    tone(b, sr, { dur: 0.26, f0: 92 * dt, f1: 42, amp: 0.8, curve: 9, drive: 0.4 });
    // Limbs landing a beat later.
    noiseBurst(b, sr, rng, { t0: 0.145, dur: 0.13, amp: 0.42, type: 'lp',
      f0: 640, f1: 160, q: 0.8, curve: 15 });
    tone(b, sr, { t0: 0.15, dur: 0.15, f0: 110 * dt, f1: 55, amp: 0.34, curve: 13 });
    noiseBurst(b, sr, rng, { t0: 0.29, dur: 0.1, amp: 0.2, type: 'lp', f0: 520, f1: 150, curve: 17 });
    // Webbing, rifle sling, buckles.
    for (let i = 0; i < 5; i++) {
      const t = 0.03 + rng() * 0.5;
      modalHit(b, sr, rng, { t0: t, freqs: [1600 + rng() * 2400, 3200 + rng() * 2600],
        t60s: [0.05, 0.03], amps: [1, 0.5], amp: 0.07 + rng() * 0.07, dur: 0.12 });
    }
    for (let i = 0; i < 3; i++) {
      noiseBurst(b, sr, rng, { t0: rng() * 0.4, dur: 0.16, amp: 0.1,
        type: 'bp', f0: 2800, q: 0.7, curve: 8, attack: 0.02, hp: 900 });
    }
    softLimit(b, 0.8); fadeEdges(b, sr, 0.6, 18);
    return b;
  },

  // Steel track link binding against the sprocket — a wandering high-Q squeal.
  trackSqueak(sr, rng, v) {
    const dur = 0.75 + v * 0.12;
    const b = monoBuf(sr, dur + 0.2);
    const n = Math.floor(dur * sr);
    const base = 1500 + v * 260;
    const bq = new Biquad(), bq2 = new Biquad();
    let f = base, drift = 0;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      if ((i & 31) === 0) {
        // Bounded random walk gives the unsteady, organic squeal glide.
        drift = drift * 0.985 + (rng() - 0.5) * 34;
        f = Math.max(700, Math.min(4200, base + drift + Math.sin(t * 21) * 140));
        bq.bandpass(sr, f, 22);
        bq2.bandpass(sr, f * 2.02, 16);
      }
      const x = rng() * 2 - 1;
      const env = Math.min(1, t / 0.08) * Math.min(1, (1 - t) / 0.25);
      b[i] += (bq.process(x) * 0.9 + bq2.process(x) * 0.4) * env * 2.4;
    }
    // Grinding floor underneath.
    noiseBurst(b, sr, rng, { dur, amp: 0.34, type: 'lp', f0: 340, f1: 220,
      q: 0.9, curve: 1.2, attack: 0.06 });
    softLimit(b, 0.8); fadeEdges(b, sr, 5, 25);
    return b;
  },

  // --- UI: the illustrated field journal -----------------------------------

  // Heavy cream paper turning over.
  uiPage(sr, rng, v) {
    const b = monoBuf(sr, 0.6);
    const offs = [0, 0.075 + v * 0.01, 0.185 + v * 0.015];
    const amps = [0.72, 0.58, 0.42];
    for (let i = 0; i < 3; i++) {
      noiseBurst(b, sr, rng, { t0: offs[i], dur: 0.19, amp: amps[i], type: 'bp',
        f0: 1100 + i * 300, f1: 4200 - i * 600, q: 1.1, curve: 7, attack: 0.02, hp: 700 });
    }
    // The sheet settling flat.
    noiseBurst(b, sr, rng, { t0: 0.3, dur: 0.11, amp: 0.34, type: 'lp',
      f0: 2400, f1: 700, curve: 13 });
    softLimit(b, 0.85); fadeEdges(b, sr, 2, 15);
    return b;
  },

  // Rubber stamp onto the order sheet: wood thump + paper slap + ink squelch.
  uiStamp(sr, rng, v) {
    const b = monoBuf(sr, 0.55);
    const dt = 1 + (v - 0.5) * 0.05;
    modalHit(b, sr, rng, {
      freqs: [224 * dt, 486 * dt, 912 * dt], t60s: [0.085, 0.055, 0.032],
      amps: [1, 0.55, 0.3], amp: 0.62, exciteDur: 0.0035, exciteLp: 4000, dur: 0.25,
    });
    noiseBurst(b, sr, rng, { dur: 0.035, amp: 0.5, type: 'bp', f0: 3000, f1: 1500, q: 0.8, curve: 30 });
    noiseBurst(b, sr, rng, { t0: 0.004, dur: 0.055, amp: 0.2, type: 'bp',
      f0: 760, f1: 480, q: 2.2, curve: 22 });    // ink pad squelch
    tone(b, sr, { dur: 0.06, f0: 128, f1: 68, amp: 0.3, curve: 18, drive: 0.3 });
    addTaps(b, sr, [{ t: 0.026, g: 0.18, lp: 3000 }, { t: 0.049, g: 0.1, lp: 2000 }]);
    softLimit(b, 0.85); fadeEdges(b, sr);
    return b;
  },

  // Silk ribbon drawn across the page.
  uiRibbon(sr, rng, v) {
    const b = monoBuf(sr, 0.5);
    noiseBurst(b, sr, rng, { dur: 0.34, amp: 0.8, type: 'bp',
      f0: 700 + v * 120, f1: 2700 + v * 300, q: 1.7, curve: 3.2, attack: 0.1, hp: 500 });
    noiseBurst(b, sr, rng, { t0: 0.05, dur: 0.26, amp: 0.3, type: 'bp',
      f0: 4200, f1: 6200, q: 1.2, curve: 4, attack: 0.09 });
    softLimit(b, 0.85); fadeEdges(b, sr, 3, 20);
    return b;
  },

  uiTick(sr, rng, v) {
    const b = monoBuf(sr, 0.08);
    modalHit(b, sr, rng, {
      freqs: [2400 + v * 220, 4100 + v * 300], t60s: [0.016, 0.01],
      amps: [1, 0.45], amp: 0.5, exciteDur: 0.0008, dur: 0.05,
    });
    noiseBurst(b, sr, rng, { dur: 0.014, amp: 0.3, type: 'bp', f0: 2800, q: 2.4, curve: 40 });
    softLimit(b, 0.85); fadeEdges(b, sr, 0.4, 6);
    return b;
  },

  // Warm confirmation: a soft struck bell on a perfect fifth (A5 + E6).
  uiConfirm(sr, rng) {
    const b = monoBuf(sr, 1.0);
    modalHit(b, sr, rng, {
      freqs: [880, 1320, 1760, 2640, 3520], t60s: [0.62, 0.44, 0.3, 0.19, 0.12],
      amps: [1, 0.72, 0.4, 0.2, 0.1], amp: 0.4, exciteDur: 0.0022, exciteLp: 7000, dur: 0.9,
    });
    tone(b, sr, { dur: 0.5, f0: 440, amp: 0.2, curve: 5, attack: 0.006 });
    tone(b, sr, { t0: 0.055, dur: 0.45, f0: 660, amp: 0.15, curve: 5.5, attack: 0.006 });
    noiseBurst(b, sr, rng, { dur: 0.02, amp: 0.12, type: 'hp', f0: 5000, curve: 45 });
    softLimit(b, 0.85); fadeEdges(b, sr, 1, 25);
    return b;
  },

  // Cancel: muted wooden knock, minor second below the confirm.
  uiCancel(sr, rng) {
    const b = monoBuf(sr, 0.5);
    modalHit(b, sr, rng, {
      freqs: [330, 392, 660], t60s: [0.24, 0.16, 0.1], amps: [1, 0.5, 0.22],
      amp: 0.4, exciteDur: 0.003, exciteLp: 3200, dur: 0.42,
    });
    tone(b, sr, { dur: 0.14, f0: 330, f1: 311, amp: 0.16, curve: 9, attack: 0.004 });
    noiseBurst(b, sr, rng, { dur: 0.02, amp: 0.16, type: 'bp', f0: 1400, q: 1.4, curve: 35 });
    softLimit(b, 0.85); fadeEdges(b, sr);
    return b;
  },

  // CP spend: harp-like double pluck, slight upward gesture.
  uiCp(sr, rng, v) {
    const b = monoBuf(sr, 0.9);
    const f = v === 0 ? 587.33 : 659.25;           // D5 / E5
    modalHit(b, sr, rng, {
      freqs: [f, f * 2, f * 3, f * 4.02], t60s: [0.4, 0.27, 0.17, 0.1],
      amps: [1, 0.55, 0.3, 0.15], amp: 0.42, exciteDur: 0.0015, exciteLp: 6000, dur: 0.6,
    });
    modalHit(b, sr, rng, {
      t0: 0.085, freqs: [f * 1.5, f * 3, f * 4.5], t60s: [0.34, 0.22, 0.13],
      amps: [1, 0.5, 0.26], amp: 0.3, exciteDur: 0.0015, exciteLp: 6000, dur: 0.55,
    });
    softLimit(b, 0.85); fadeEdges(b, sr, 1, 20);
    return b;
  },

  // Interception / danger sting: minor second cluster + timpani + cymbal wash.
  uiAlert(sr, rng) {
    const b = monoBuf(sr, 1.7);
    for (const [f, a] of [[220, 0.3], [233.08, 0.26], [440, 0.18], [466.16, 0.15]]) {
      tone(b, sr, { dur: 1.0, f0: f, amp: a, curve: 3.4, attack: 0.09, wave: 'saw',
        fm: 0.004, fmRate: 5.4 });
    }
    // Timpani thump underneath.
    modalHit(b, sr, rng, {
      freqs: [73.4, 110, 165, 220], t60s: [0.85, 0.5, 0.3, 0.18],
      amps: [1, 0.5, 0.28, 0.14], amp: 0.5, exciteDur: 0.006, exciteLp: 1400, dur: 1.2,
    });
    noiseBurst(b, sr, rng, { dur: 0.9, amp: 0.1, type: 'hp', f0: 3600, curve: 3.6, attack: 0.05 });
    noiseBurst(b, sr, rng, { dur: 0.05, amp: 0.3, type: 'lp', f0: 2400, f1: 500, curve: 22 });
    allpassChain(b, sr, [11.3, 19.1], 0.4);
    softLimit(b, 0.78); fadeEdges(b, sr, 1, 40);
    return stereoLimit(stereoize(b, sr, rng, 0.8), 0.78);
  },

  // End-of-mission rank stamp: a slam you feel in the desk.
  uiRankStamp(sr, rng) {
    const b = monoBuf(sr, 1.5);
    modalHit(b, sr, rng, {
      freqs: [138, 297, 561, 984], t60s: [0.26, 0.16, 0.1, 0.06],
      amps: [1, 0.6, 0.34, 0.18], amp: 0.85, exciteDur: 0.0045, exciteLp: 3400, dur: 0.4,
    });
    tone(b, sr, { dur: 0.22, f0: 96, f1: 42, amp: 0.72, curve: 10, drive: 0.55 });
    noiseBurst(b, sr, rng, { dur: 0.05, amp: 0.6, type: 'bp', f0: 2600, f1: 1100, q: 0.8, curve: 26 });
    noiseBurst(b, sr, rng, { t0: 0.005, dur: 0.07, amp: 0.24, type: 'bp', f0: 700, f1: 420, q: 2, curve: 20 });
    addTaps(b, sr, [{ t: 0.037, g: 0.3, lp: 2600 }, { t: 0.081, g: 0.19, lp: 1700 },
                    { t: 0.152, g: 0.11, lp: 1100 }, { t: 0.29, g: 0.06, lp: 700 }]);
    allpassChain(b, sr, [9.7, 16.3, 24.1], 0.45);
    softLimit(b, 0.72); fadeEdges(b, sr, 0.6, 35);
    return stereoLimit(stereoize(b, sr, rng, 0.6), 0.72);
  },
};

// Composite bursts — rendered by mixing the single-shot generator at a
// realistic cyclic rate, so a burst is one voice instead of five.
GEN.smgBurst = (sr, rng, v) => _burst(sr, rng, v, 'smg', 5 + v, 0.082, 0.55);
GEN.mgBurst = (sr, rng, v) => _burst(sr, rng, v, 'mg', 6 + v, 0.098, 0.85);

function _burst(sr, rng, v, base, count, period, tail) {
  const single = GEN[base](sr, rng, v);
  const b = monoBuf(sr, (count - 1) * period + single.length / sr + tail);
  for (let i = 0; i < count; i++) {
    // Cyclic rate wobbles a few percent; first round is always the loudest.
    const t = i * period * (1 + (rng() - 0.5) * 0.05);
    const g = (i === 0 ? 1 : 0.86 + rng() * 0.12);
    mixInto(b, single, Math.floor(t * sr), g);
  }
  softLimit(b, 0.66);
  fadeEdges(b, sr, 0.6, 20);
  return b;
}

// --- reload sub-gestures, shared by the parts and the full sequence --------

function _magOut(b, sr, rng, t0, v) {
  const dt = 1 + (v - 0.5) * 0.04;
  modalHit(b, sr, rng, {                       // catch release
    t0, freqs: [1920 * dt, 3140 * dt], t60s: [0.03, 0.02], amps: [1, 0.5],
    amp: 0.35, exciteDur: 0.001, dur: 0.1,
  });
  noiseBurst(b, sr, rng, { t0: t0 + 0.04, dur: 0.17, amp: 0.4, type: 'bp',
    f0: 1200, f1: 2300, q: 3, curve: 7, attack: 0.02 });   // magazine sliding free
  modalHit(b, sr, rng, {                       // mag hits the webbing
    t0: t0 + 0.28, freqs: [412 * dt, 903 * dt, 1580 * dt], t60s: [0.07, 0.045, 0.028],
    amps: [1, 0.5, 0.26], amp: 0.4, exciteDur: 0.003, exciteLp: 5000, dur: 0.22,
  });
}

function _magIn(b, sr, rng, t0, v) {
  const dt = 1 + (v - 0.5) * 0.04;
  noiseBurst(b, sr, rng, { t0, dur: 0.14, amp: 0.36, type: 'bp',
    f0: 2200, f1: 1200, q: 3, curve: 8, attack: 0.015 });
  modalHit(b, sr, rng, {                       // solid seat
    t0: t0 + 0.19, freqs: [306 * dt, 648 * dt, 1121 * dt, 1940 * dt],
    t60s: [0.09, 0.06, 0.04, 0.025], amps: [1, 0.62, 0.36, 0.2],
    amp: 0.62, exciteDur: 0.0028, exciteLp: 6000, dur: 0.3,
  });
  tone(b, sr, { t0: t0 + 0.19, dur: 0.05, f0: 180, f1: 92, amp: 0.16, curve: 22 });
}

function _bolt(b, sr, rng, t0, v) {
  const dt = 1 + (v - 0.5) * 0.05;
  modalHit(b, sr, rng, {                       // bolt drawn back
    t0, freqs: [1460 * dt, 2610 * dt, 3980 * dt], t60s: [0.04, 0.026, 0.016],
    amps: [1, 0.55, 0.3], amp: 0.34, exciteDur: 0.0012, dur: 0.12,
  });
  noiseBurst(b, sr, rng, { t0: t0 + 0.02, dur: 0.1, amp: 0.3, type: 'bp',
    f0: 1700, f1: 2600, q: 4, curve: 9, attack: 0.008 });
  modalHit(b, sr, rng, {                       // slammed home — louder
    t0: t0 + 0.25, freqs: [1180 * dt, 2240 * dt, 3510 * dt, 5200 * dt],
    t60s: [0.06, 0.04, 0.026, 0.016], amps: [1, 0.6, 0.35, 0.2],
    amp: 0.6, exciteDur: 0.0014, dur: 0.2,
  });
  tone(b, sr, { t0: t0 + 0.25, dur: 0.045, f0: 260, f1: 130, amp: 0.14, curve: 24 });
}

// ---------------------------------------------------------------------------
// Public render entry point
// ---------------------------------------------------------------------------

/**
 * Render one variant of one sound.
 * @returns {{ channels: Float32Array[], sampleRate: number }}
 */
export function renderSfx(name, variant = 0, sr = 44100) {
  const gen = GEN[name];
  if (!gen) return null;
  const rng = makeRng((hashStr(name) ^ Math.imul(variant + 1, 2654435761)) >>> 0);
  const out = gen(sr, rng, variant);
  const channels = Array.isArray(out) ? out : [out];
  return { channels, sampleRate: sr };
}

export const SFX_NAMES = Object.keys(SFX_DEFS);

// ---------------------------------------------------------------------------
// Tank engine — a real firing-pulse model, not a looped drone.
// ---------------------------------------------------------------------------

export const ENGINE_BASE_RPM = 900;
const ENGINE_CYLINDERS = 6;
const ENGINE_LOOP_REVS = 12;       // long enough that the loop point is inaudible

/**
 * One seamless loop of cylinder firings at ENGINE_BASE_RPM. Pulses that run
 * past the end wrap to the front, so looping is click-free and the tail of the
 * last firing correctly overlaps the first.
 *
 * A 4-stroke engine fires cylinders/2 times per revolution. Per-cylinder
 * timing and level offsets are fixed across revolutions (they're mechanical,
 * not random), which is what gives a real engine its lumpy, recognisable beat.
 */
export function renderEngineLoop(sr, seed = 7717) {
  const rng = makeRng(seed);
  const firesPerRev = ENGINE_CYLINDERS / 2;
  const revDur = 60 / ENGINE_BASE_RPM;
  const dur = revDur * ENGINE_LOOP_REVS;
  const n = Math.ceil(dur * sr);
  const b = new Float32Array(n);
  const fireDur = revDur / firesPerRev;

  // Per-cylinder character, fixed for the life of the loop.
  const cylT = [], cylG = [], cylF = [];
  for (let c = 0; c < firesPerRev; c++) {
    cylT.push((rng() - 0.5) * 0.055 * fireDur);
    cylG.push(0.82 + rng() * 0.36);
    cylF.push(0.9 + rng() * 0.22);
  }

  const pulse = monoBuf(sr, fireDur * 1.9);
  const write = (t, g, fs) => {
    pulse.fill(0);
    const r = makeRng((seed ^ Math.imul(Math.floor(t * 1e5) + 1, 40503)) >>> 0);
    // Combustion: a hard low thump plus a burst of exhaust noise.
    tone(pulse, sr, { dur: 0.028, f0: 210 * fs, f1: 74 * fs, amp: 0.85 * g, curve: 22, drive: 0.5 });
    tone(pulse, sr, { dur: 0.05, f0: 96 * fs, f1: 52 * fs, amp: 0.4 * g, curve: 14 });
    noiseBurst(pulse, sr, r, { dur: 0.02, amp: 0.4 * g, type: 'bp',
      f0: 1600 * fs, f1: 700, q: 1.1, curve: 26 });
    noiseBurst(pulse, sr, r, { dur: 0.05, amp: 0.16 * g, type: 'lp',
      f0: 900, f1: 300, curve: 14 });
    // Valve/mechanical clatter — the "diesel" edge.
    noiseBurst(pulse, sr, r, { t0: 0.006, dur: 0.012, amp: 0.09 * g,
      type: 'hp', f0: 3200, curve: 40 });
    const off = Math.floor(t * sr);
    for (let i = 0; i < pulse.length; i++) b[(off + i) % n] += pulse[i];
  };

  for (let rev = 0; rev < ENGINE_LOOP_REVS; rev++) {
    for (let c = 0; c < firesPerRev; c++) {
      const t = rev * revDur + c * fireDur + cylT[c];
      write(((t % dur) + dur) % dur, cylG[c], cylF[c]);
    }
  }
  softLimit(b, 0.7);
  return b;
}

/** Track/roadwheel rattle loop: gravelly rumble plus sparse link clanks. */
export function renderTrackLoop(sr, seed = 3313) {
  const rng = makeRng(seed);
  const dur = 2.0;
  const n = Math.ceil(dur * sr);
  const b = new Float32Array(n);
  const lp = new Biquad().lowpass(sr, 260, 0.8);
  const bp = new Biquad().bandpass(sr, 900, 0.8);
  let g1 = 0, g2 = 0;
  for (let i = 0; i < n; i++) {
    const x = rng() * 2 - 1;
    // Two slow amplitude wobbles ~ roadwheel and sprocket periodicity.
    if ((i & 63) === 0) {
      const t = i / sr;
      g1 = 0.75 + 0.25 * Math.sin(t * TAU * 3.1);
      g2 = 0.7 + 0.3 * Math.sin(t * TAU * 1.7 + 1.1);
    }
    b[i] += lp.process(x) * 0.5 * g1 + bp.process(x) * 0.16 * g2;
  }
  // Link clanks, wrapped so the loop stays seamless.
  const clank = monoBuf(sr, 0.16);
  for (let k = 0; k < 26; k++) {
    clank.fill(0);
    const r = makeRng((seed ^ Math.imul(k + 1, 2246822519)) >>> 0);
    modalHit(clank, sr, r, {
      freqs: [780 + r() * 900, 1600 + r() * 1400, 2900 + r() * 1800],
      t60s: [0.035, 0.022, 0.014], amps: [1, 0.5, 0.26],
      amp: 0.18 + r() * 0.14, exciteDur: 0.0012, dur: 0.14,
    });
    const off = Math.floor((k / 26 + (rng() - 0.5) * 0.02) * n);
    for (let i = 0; i < clank.length; i++) b[((off + i) % n + n) % n] += clank[i];
  }
  softLimit(b, 0.7);
  return b;
}

/**
 * Live tank engine voice. Node graph:
 *
 *   pulseLoop (playbackRate = rpm/base) ─┐
 *   intake noise ────────────────────────┼─> drive(WaveShaper) -> tone LP
 *   sub osc (firing frequency) ──────────┘        │
 *   track loop -> trackGain ──────────────────────┤
 *                                                 └─> exhaust peak EQ -> out
 *
 * Pitch tracking comes from playbackRate (which shifts the whole pulse train,
 * as it should), while the exhaust/body resonances are *fixed* filters after
 * the source, so the formants stay put the way a real exhaust system does.
 */
export class TankEngineVoice {
  constructor(ctx, dest, buffers, opts = {}) {
    this.ctx = ctx;
    this.rpm = opts.rpm ?? 700;
    this.load = 0;
    this._targetRpm = this.rpm;
    this._targetLoad = 0;
    this._trackSpeed = 0;
    this._targetTrack = 0;
    this.out = ctx.createGain();
    this.out.gain.value = 0;

    const now = ctx.currentTime;

    this.pulse = ctx.createBufferSource();
    this.pulse.buffer = buffers.engine;
    this.pulse.loop = true;
    this.pulseGain = ctx.createGain();
    this.pulseGain.gain.value = 0.9;

    this.intake = ctx.createBufferSource();
    this.intake.buffer = buffers.engine;   // reuse; heavily filtered into hiss
    this.intake.loop = true;
    this.intake.playbackRate.value = 0.37;
    this.intakeFilter = ctx.createBiquadFilter();
    this.intakeFilter.type = 'bandpass';
    this.intakeFilter.frequency.value = 900;
    this.intakeFilter.Q.value = 0.8;
    this.intakeGain = ctx.createGain();
    this.intakeGain.gain.value = 0.06;

    this.sub = ctx.createOscillator();
    this.sub.type = 'sine';
    this.subGain = ctx.createGain();
    this.subGain.gain.value = 0.0;

    this.drive = ctx.createWaveShaper();
    this.drive.curve = TankEngineVoice._curve(2.5);
    this.drive.oversample = '2x';

    this.tone = ctx.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.frequency.value = 1200;
    this.tone.Q.value = 0.6;

    // Exhaust pipe resonance + hull body resonance: fixed formants.
    this.exhaust = ctx.createBiquadFilter();
    this.exhaust.type = 'peaking';
    this.exhaust.frequency.value = 112;
    this.exhaust.Q.value = 2.6;
    this.exhaust.gain.value = 9;
    this.body = ctx.createBiquadFilter();
    this.body.type = 'peaking';
    this.body.frequency.value = 248;
    this.body.Q.value = 1.6;
    this.body.gain.value = 5;
    this.hpf = ctx.createBiquadFilter();
    this.hpf.type = 'highpass';
    this.hpf.frequency.value = 34;

    this.track = ctx.createBufferSource();
    this.track.buffer = buffers.track;
    this.track.loop = true;
    this.trackGain = ctx.createGain();
    this.trackGain.gain.value = 0;

    this.pulse.connect(this.pulseGain).connect(this.drive);
    this.intake.connect(this.intakeFilter).connect(this.intakeGain).connect(this.drive);
    this.sub.connect(this.subGain).connect(this.drive);
    this.drive.connect(this.tone).connect(this.exhaust).connect(this.body)
      .connect(this.hpf).connect(this.out);
    this.track.connect(this.trackGain).connect(this.hpf);

    this.pulse.start(now);
    this.intake.start(now);
    this.sub.start(now);
    this.track.start(now);
    this._apply(now, 0);
    this.out.connect(dest);
  }

  static _curve(k) {
    const n = 1024, c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] = Math.tanh(x * k) / Math.tanh(k);
    }
    return c;
  }

  setRpm(rpm) { this._targetRpm = Math.max(320, Math.min(2600, rpm)); }
  setLoad(l) { this._targetLoad = Math.max(0, Math.min(1, l)); }
  setTrackSpeed(v) { this._targetTrack = Math.max(0, Math.min(1, v)); }
  setVolume(v, t = 0.08) {
    this.out.gain.setTargetAtTime(Math.max(0, v), this.ctx.currentTime, t);
  }

  _apply(now, dt) {
    const k = dt > 0 ? 1 - Math.exp(-5.5 * dt) : 1;
    this.rpm += (this._targetRpm - this.rpm) * k;
    this.load += (this._targetLoad - this.load) * (dt > 0 ? 1 - Math.exp(-3.2 * dt) : 1);
    this._trackSpeed += (this._targetTrack - this._trackSpeed) * (dt > 0 ? 1 - Math.exp(-4 * dt) : 1);

    const rate = this.rpm / ENGINE_BASE_RPM;
    const tc = 0.05;
    this.pulse.playbackRate.setTargetAtTime(rate, now, tc);
    this.intake.playbackRate.setTargetAtTime(0.3 + rate * 0.16, now, tc);
    // Firing frequency: rpm/60 * cylinders/2.
    this.sub.frequency.setTargetAtTime((this.rpm / 60) * (ENGINE_CYLINDERS / 2), now, tc);
    this.subGain.gain.setTargetAtTime(0.06 + this.load * 0.16, now, tc);
    // Under load the engine opens up: brighter, more intake, more saturation.
    this.tone.frequency.setTargetAtTime(700 + this.load * 2600 + rate * 420, now, tc);
    this.intakeGain.gain.setTargetAtTime(0.035 + this.load * 0.13, now, tc);
    this.intakeFilter.frequency.setTargetAtTime(700 + this.load * 1500, now, tc);
    this.exhaust.gain.setTargetAtTime(7 + this.load * 5, now, tc);
    this.track.playbackRate.setTargetAtTime(0.6 + this._trackSpeed * 0.9, now, tc);
    this.trackGain.gain.setTargetAtTime(this._trackSpeed * 0.55, now, tc);
  }

  update(dt) { this._apply(this.ctx.currentTime, dt); }

  stop(fade = 0.35) {
    const now = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(now);
    this.out.gain.setTargetAtTime(0, now, fade * 0.35);
    const t = now + fade + 0.1;
    try {
      this.pulse.stop(t); this.intake.stop(t); this.sub.stop(t); this.track.stop(t);
    } catch (e) { /* already stopped */ }
    setTimeout(() => { try { this.out.disconnect(); } catch (e) { /* gone */ } },
      (fade + 0.3) * 1000);
  }
}
