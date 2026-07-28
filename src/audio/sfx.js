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

/** Limit *and re-fade* a decorrelated pair. The allpass chains inside
 *  stereoize() smear tail energy forward into the last samples, so a fade
 *  applied to the mono render no longer guarantees the buffer ends at zero —
 *  and a buffer that ends at -50 dBFS clicks every time it is triggered. */
export function stereoFinish(pair, sr, thresh = 0.72, inMs = 0.6, outMs = 20) {
  stereoLimit(pair, thresh);
  fadeEdges(pair[0], sr, inMs, outMs);
  fadeEdges(pair[1], sr, inMs, outMs);
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
// dd   = duplicate-suppression window in seconds (AudioEngine.play); the same
//        sound at the same spot inside this window is one event described
//        twice, not two events. 0 disables. Default DEDUPE_WINDOW.

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
  explosionBig:     { v: 2, gain: 1.25, ref: 20, roll: 0.68, max: 1000, pri: 10, cat: 'boom', pv: 0.04, wet: 0.8, stereo: true },
  grenadePin:       { v: 2, gain: 0.45, ref: 4, roll: 1.6, max: 60, pri: 2, cat: 'foley', pv: 0.08, wet: 0.25 },
  grenadeBounce:    { v: 3, gain: 0.85,  ref: 5, roll: 1.5, max: 90, pri: 3, cat: 'foley', pv: 0.1, wet: 0.35 },
  grenadeThrow:     { v: 3, gain: 0.6,  ref: 4, roll: 1.6, max: 70, pri: 3, cat: 'foley', pv: 0.08, wet: 0.2 },
  // Incoming off-map shell. Spatialised at the impact point but with a huge
  // reference distance — the whole valley hears a barrage coming down.
  artilleryWhistle: { v: 2, gain: 0.95, ref: 34, roll: 0.36, max: 1200, pri: 9, cat: 'incoming', pv: 0.025, wet: 0.55 },

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
  // `unit:downed` (derived) and an explicit `downed` sfx both land on this, a
  // frame apart — a slightly wider window than the default collapses them.
  bodyFall:     { v: 3, gain: 0.75, ref: 6, roll: 1.4, max: 140, pri: 5, cat: 'body', pv: 0.07, wet: 0.3, dd: 0.08 },
  trackSqueak:  { v: 4, gain: 0.6,  ref: 7, roll: 1.3, max: 180, pri: 2, cat: 'foley', pv: 0.12, wet: 0.35 },

  // --- infantry action foley ---
  vault:        { v: 3, gain: 0.8,  ref: 4, roll: 1.7, max: 60, pri: 3, cat: 'foley', pv: 0.07, wet: 0.25 },
  ladder:       { v: 2, gain: 0.7,  ref: 4, roll: 1.7, max: 60, pri: 2, cat: 'foley', pv: 0.06, wet: 0.3 },
  dryFire:      { v: 2, gain: 0.6,  ref: 3, roll: 1.8, max: 45, pri: 4, cat: 'foley', pv: 0.05, wet: 0.15 },
  resupply:     { v: 2, gain: 0.75, ref: 5, roll: 1.5, max: 80, pri: 4, cat: 'foley', pv: 0.05, wet: 0.25 },
  repair:       { v: 2, gain: 0.7,  ref: 6, roll: 1.4, max: 110, pri: 4, cat: 'foley', pv: 0.05, wet: 0.35 },
  // Own category: a round cracking past must not gate the shot that fired it.
  nearMiss:     { v: 3, gain: 0.7,  ref: 4, roll: 1.6, max: 90, pri: 5, cat: 'crack', pv: 0.1, wet: 0.25 },

  // --- vehicles ---
  tankHit:       { v: 3, gain: 0.7,  ref: 9,  roll: 1.1,  max: 320, pri: 6, cat: 'impact', pv: 0.06, wet: 0.5 },
  tankHitHeavy:  { v: 2, gain: 0.85, ref: 11, roll: 1.0,  max: 420, pri: 7, cat: 'impact', pv: 0.05, wet: 0.55 },
  // Layered *on top of* the blast the `explosion` event already fires, so it
  // is mostly tearing metal and cook-off rather than another low-end thump.
  tankDestroyed: { v: 2, gain: 1.0,  ref: 16, roll: 0.75, max: 750, pri: 10, cat: 'brew', pv: 0.04, wet: 0.7, stereo: true },
  metalJam:      { v: 2, gain: 0.7,  ref: 7,  roll: 1.2,  max: 220, pri: 5, cat: 'motor', pv: 0.05, wet: 0.4 },
  trackSnap:     { v: 2, gain: 0.85, ref: 9,  roll: 1.1,  max: 300, pri: 7, cat: 'motor', pv: 0.04, wet: 0.45 },
  engineBlow:    { v: 2, gain: 0.9,  ref: 10, roll: 1.0,  max: 380, pri: 8, cat: 'motor', pv: 0.04, wet: 0.5 },
  // tank.js re-emits this on ~10 consecutive frames per slew tick; the wide
  // window turns that back into the ~2 Hz motor pulse it is meant to be.
  turretSlew:    { v: 3, gain: 0.55, ref: 6,  roll: 1.3,  max: 150, pri: 2, cat: 'motor', pv: 0.05, wet: 0.3, dd: 0.16 },

  // --- UI (2D, non-spatial) ---
  uiPage:      { v: 3, gain: 1.35,  spatial: false, pri: 4, cat: 'ui', pv: 0.05 },
  // `order:used` (derived), the HUD's order click and battle.js' `orderUse`
  // are three descriptions of one stamp landing; collapse them.
  uiStamp:     { v: 2, gain: 0.65, spatial: false, pri: 5, cat: 'ui', pv: 0.04, dd: 0.14 },
  uiRibbon:    { v: 2, gain: 1.5, spatial: false, pri: 3, cat: 'ui', pv: 0.05 },
  uiTick:      { v: 3, gain: 0.34, spatial: false, pri: 2, cat: 'ui', pv: 0.07 },
  uiConfirm:   { v: 1, gain: 0.46, spatial: false, pri: 5, cat: 'ui', pv: 0.02 },
  uiCancel:    { v: 1, gain: 0.42, spatial: false, pri: 4, cat: 'ui', pv: 0.02 },
  uiSelect:    { v: 2, gain: 0.48, spatial: false, pri: 3, cat: 'ui', pv: 0.05 },
  uiDeny:      { v: 1, gain: 0.62, spatial: false, pri: 5, cat: 'ui', pv: 0.03 },
  uiPlace:     { v: 2, gain: 0.58, spatial: false, pri: 4, cat: 'ui', pv: 0.05 },
  uiDialogue:  { v: 3, gain: 0.55, spatial: false, pri: 3, cat: 'ui', pv: 0.04 },
  uiCp:        { v: 2, gain: 0.44, spatial: false, pri: 4, cat: 'ui', pv: 0.03 },
  uiAlert:     { v: 1, gain: 0.7,  spatial: false, pri: 9, cat: 'ui', pv: 0.01, stereo: true },
  // The results screen stamps once and `mission:end` stamps once, a beat
  // apart by design — but if they collide they must not double-slam.
  uiRankStamp: { v: 1, gain: 0.85, spatial: false, pri: 9, cat: 'ui', pv: 0.01, stereo: true, dd: 0.5 },

  // --- aiming / action-mode gestures (2D: they happen at the camera) ---
  actionEnter: { v: 1, gain: 0.8,  spatial: false, pri: 9, cat: 'sting', pv: 0.01, stereo: true },
  aimIn:       { v: 2, gain: 0.5,  spatial: false, pri: 3, cat: 'gesture', pv: 0.05 },
  aimOut:      { v: 2, gain: 0.6, spatial: false, pri: 3, cat: 'gesture', pv: 0.05 },
  targetLock:  { v: 3, gain: 0.4,  spatial: false, pri: 4, cat: 'gesture', pv: 0.03, dd: 0.11 },

  // --- narrative stings (2D announcements) ---
  turnPlayer:  { v: 1, gain: 0.8,  spatial: false, pri: 9, cat: 'sting', pv: 0.01, stereo: true },
  turnEnemy:   { v: 1, gain: 0.8,  spatial: false, pri: 9, cat: 'sting', pv: 0.01, stereo: true },
  victory:     { v: 1, gain: 0.95, spatial: false, pri: 10, cat: 'sting', pv: 0.01, stereo: true },
  defeat:      { v: 1, gain: 1.15,  spatial: false, pri: 10, cat: 'sting', pv: 0.01, stereo: true },
  capture:     { v: 1, gain: 1.05,  spatial: false, pri: 8, cat: 'sting', pv: 0.02 },
  reinforceFriendly: { v: 1, gain: 0.75, spatial: false, pri: 8, cat: 'sting', pv: 0.02 },
  reinforceEnemy:    { v: 1, gain: 0.75, spatial: false, pri: 8, cat: 'sting', pv: 0.02 },
  unitLost:    { v: 1, gain: 0.8,  spatial: false, pri: 9, cat: 'sting', pv: 0.01 },
  rescue:      { v: 1, gain: 0.95, spatial: false, pri: 8, cat: 'sting', pv: 0.02 },
  potentialGood: { v: 2, gain: 0.6, spatial: false, pri: 7, cat: 'sting', pv: 0.03 },
  potentialBad:  { v: 2, gain: 0.6, spatial: false, pri: 7, cat: 'sting', pv: 0.03 },
};

/**
 * Aliases so other systems can emit whatever reads naturally.
 *
 * An entry belongs here only when the name is a genuine *synonym* of a sound
 * that already exists (`tankFire` really is the tank gun). When a name names a
 * different physical event it gets its own generator instead — half the point
 * of the bank is that a track snapping does not sound like a rifle.
 */
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

  // --- names the game actually emits -------------------------------------
  // Weapons. WEAPONS[*].sfx is passed through verbatim by combat.fireRound.
  mgFire: 'mg', coax: 'mg', coaxial: 'mg',
  tankFire: 'tankGun', mainGun: 'tankGun',
  // A tank taking a hit is armour, not "a metal thing" — but an explicit
  // hitArmour on an infantry-scale impact is just the metal impact.
  hitArmour: 'impactMetal', hitArmor: 'impactMetal', armourHit: 'tankHit',
  tankDeath: 'tankDestroyed', tankBrewUp: 'tankDestroyed', vehicleDestroyed: 'tankDestroyed',
  jam: 'metalJam', turretJam: 'metalJam',
  trackThrow: 'trackSnap', trackBreak: 'trackSnap',
  engineDeath: 'engineBlow', radiatorBlow: 'engineBlow',
  slew: 'turretSlew', turretTurn: 'turretSlew',

  // Ordnance.
  explosionLarge: 'explosionBig', bigBoom: 'explosionBig',
  grenadeToss: 'grenadeThrow', throwGrenade: 'grenadeThrow',
  incoming: 'artilleryWhistle', shellWhistle: 'artilleryWhistle', whistle: 'artilleryWhistle',

  // Infantry action.
  climb: 'ladder', vaultOver: 'vault',
  emptyClick: 'dryFire', click: 'dryFire',
  lock: 'targetLock', aimStart: 'aimIn', aimEnd: 'aimOut',
  ammo: 'resupply', supply: 'resupply', fix: 'repair', wrench: 'repair',
  whipCrack: 'nearMiss',

  // Stings.
  actionStart: 'actionEnter', blitz: 'actionEnter',
  turnStart: 'turnPlayer', enemyTurn: 'turnEnemy',
  win: 'victory', lose: 'defeat',
  campCaptured: 'capture', flag: 'capture',
  reinforcements: 'reinforceFriendly',
  killed: 'unitLost', dead: 'unitLost',
  evac: 'rescue', medic: 'rescue',
  potential: 'potentialGood',
  // An interception warning IS the danger sting; the `interception` Bus event
  // plays the same buffer, and play()'s dedupe folds the pair into one.
  interceptWarn: 'uiAlert',
  orderUse: 'uiStamp',

  // UI. The DOM layer names things with underscores; the bank is camelCase.
  uiBack: 'uiCancel', uiCursor: 'uiTick',
  ui_select: 'uiSelect', ui_order: 'uiStamp', ui_endturn: 'uiPage',
  ui_place: 'uiPlace', ui_stamp: 'uiRankStamp', ui_dialogue: 'uiDialogue',
  ui_confirm: 'uiConfirm', ui_cancel: 'uiCancel', ui_deny: 'uiDeny',
  dialogue: 'uiDialogue', line: 'uiDialogue',
  endTurn: 'uiPage', turnEnd: 'uiPage',
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
    return stereoFinish(stereoize(b, sr, rng, 1), sr, 0.66, 0.6, 40);
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
    return stereoFinish(stereoize(b, sr, rng, 1.4), sr, 0.7, 5, 60);
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
    return stereoFinish(stereoize(b, sr, rng, 0.8), sr, 0.78, 1, 40);
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
    return stereoFinish(stereoize(b, sr, rng, 0.6), sr, 0.72, 0.6, 35);
  },

  // Selection: a steel pen nib tapping the page. Brighter and more definite
  // than uiTick (which is only a cursor moving) but far short of uiConfirm.
  uiSelect(sr, rng, v) {
    const b = monoBuf(sr, 0.24);
    const f = v === 0 ? 1174.66 : 1318.51;            // D6 / E6
    modalHit(b, sr, rng, {
      freqs: [f, f * 2.01, f * 3.04], t60s: [0.085, 0.052, 0.03],
      amps: [1, 0.48, 0.22], amp: 0.5, exciteDur: 0.0009, exciteLp: 8000, dur: 0.17,
    });
    noiseBurst(b, sr, rng, { dur: 0.026, amp: 0.2, type: 'bp',
      f0: 3400, f1: 2100, q: 1.6, curve: 26, hp: 1200 });   // nib on paper fibre
    softLimit(b, 0.85); fadeEdges(b, sr, 0.4, 8);
    return b;
  },

  // Refusal: a dead, damped double knock on the desk. Deliberately unmusical —
  // a minor second with the ring choked out of it, so it reads as "no".
  uiDeny(sr, rng) {
    const b = monoBuf(sr, 0.44);
    for (let i = 0; i < 2; i++) {
      const t0 = i * 0.088, g = i ? 0.78 : 1;
      modalHit(b, sr, rng, {
        t0, freqs: [196, 233.08, 293.66], t60s: [0.07, 0.048, 0.032],
        amps: [1, 0.6, 0.3], amp: 0.5 * g, exciteDur: 0.004, exciteLp: 1800, dur: 0.17,
      });
      noiseBurst(b, sr, rng, { t0, dur: 0.03, amp: 0.16 * g, type: 'lp',
        f0: 900, f1: 300, curve: 26 });
    }
    tone(b, sr, { dur: 0.1, f0: 110, f1: 92, amp: 0.22, curve: 14, drive: 0.25 });
    softLimit(b, 0.85); fadeEdges(b, sr);
    return b;
  },

  // Deployment: a wooden unit counter set down on the paper map.
  uiPlace(sr, rng, v) {
    const b = monoBuf(sr, 0.32);
    const dt = 1 + (v - 0.5) * 0.06;
    modalHit(b, sr, rng, {
      freqs: [412 * dt, 903 * dt, 1560 * dt], t60s: [0.05, 0.032, 0.02],
      amps: [1, 0.55, 0.28], amp: 0.55, exciteDur: 0.0022, exciteLp: 5200, dur: 0.17,
    });
    noiseBurst(b, sr, rng, { dur: 0.05, amp: 0.3, type: 'bp',
      f0: 2400, f1: 1200, q: 1.0, curve: 22, hp: 800 });     // sheet under it
    tone(b, sr, { dur: 0.04, f0: 150, f1: 84, amp: 0.18, curve: 22 });
    softLimit(b, 0.85); fadeEdges(b, sr);
    return b;
  },

  // A line of dialogue arriving. Fires once per line, so it stays soft and
  // wooden — a marimba-ish blip with the paper of the journal behind it.
  uiDialogue(sr, rng, v) {
    const b = monoBuf(sr, 0.36);
    const f = [523.25, 587.33, 659.25][v % 3];
    tone(b, sr, { dur: 0.17, f0: f, amp: 0.3, curve: 9, attack: 0.008, wave: 'tri' });
    tone(b, sr, { t0: 0.004, dur: 0.11, f0: f * 2, amp: 0.09, curve: 13, attack: 0.006 });
    noiseBurst(b, sr, rng, { dur: 0.045, amp: 0.12, type: 'bp',
      f0: 2600, f1: 1500, q: 1.2, curve: 18, hp: 900 });
    softLimit(b, 0.85); fadeEdges(b, sr, 1, 12);
    return b;
  },

  // --- action-mode gestures ------------------------------------------------

  // Dropping into BLiTZ action mode: air rushing in, then the downbeat as the
  // camera arrives on the shoulder.
  actionEnter(sr, rng) {
    const b = monoBuf(sr, 1.8);
    const hit = 0.42;
    // Reverse-swell: negative curve makes dEnv rise into the hit.
    noiseBurst(b, sr, rng, { dur: hit, amp: 0.2, type: 'bp',
      f0: 300, f1: 3600, q: 1.0, curve: -1.6, attack: 0.09 });
    tone(b, sr, { dur: hit, f0: 90, f1: 220, amp: 0.16, curve: -1.2, attack: 0.1 });
    // Timpani + sub drop on the beat.
    modalHit(b, sr, rng, {
      t0: hit, freqs: [61.7, 92.5, 123.5, 185], t60s: [0.9, 0.55, 0.34, 0.2],
      amps: [1, 0.5, 0.28, 0.14], amp: 0.55, exciteDur: 0.006, exciteLp: 1300, dur: 1.15,
    });
    tone(b, sr, { t0: hit, dur: 0.48, f0: 150, f1: 42, amp: 0.4, curve: 6, drive: 0.5 });
    noiseBurst(b, sr, rng, { t0: hit, dur: 0.38, amp: 0.2, type: 'lp',
      f0: 4200, f1: 400, curve: 10 });
    // A bright strike so it still cuts through a firefight.
    modalHit(b, sr, rng, {
      t0: hit, freqs: [880, 1320, 1980], t60s: [0.4, 0.26, 0.16],
      amps: [1, 0.5, 0.25], amp: 0.18, exciteDur: 0.0012, exciteLp: 7000, dur: 0.55,
    });
    allpassChain(b, sr, [9.7, 17.3], 0.4);
    softLimit(b, 0.78); fadeEdges(b, sr, 2, 40);
    return stereoFinish(stereoize(b, sr, rng, 0.8), sr, 0.78, 2, 40);
  },

  // The reticle snapping onto a body: two quick glints a fourth apart.
  targetLock(sr, rng, v) {
    const b = monoBuf(sr, 0.24);
    const f = 1568 + v * 62;
    modalHit(b, sr, rng, {
      freqs: [f, f * 1.5, f * 2.02], t60s: [0.045, 0.03, 0.02],
      amps: [1, 0.5, 0.26], amp: 0.42, exciteDur: 0.0007, exciteLp: 9000, dur: 0.1,
    });
    modalHit(b, sr, rng, {
      t0: 0.038, freqs: [f * 1.335, f * 2, f * 2.7], t60s: [0.06, 0.038, 0.024],
      amps: [1, 0.5, 0.26], amp: 0.34, exciteDur: 0.0007, exciteLp: 9000, dur: 0.14,
    });
    noiseBurst(b, sr, rng, { dur: 0.01, amp: 0.12, type: 'hp', f0: 6000, curve: 55 });
    softLimit(b, 0.85); fadeEdges(b, sr, 0.4, 8);
    return b;
  },

  // --- infantry action foley ----------------------------------------------

  // Going over a wall: hand slap on the parapet, boot scuff over the lip,
  // webbing knocking about, then the landing on the far side.
  vault(sr, rng, v) {
    const b = monoBuf(sr, 0.95);
    noiseBurst(b, sr, rng, { dur: 0.05, amp: 0.5, type: 'lp',
      f0: 1800, f1: 500, q: 0.8, curve: 22 });
    tone(b, sr, { dur: 0.05, f0: 190, f1: 92, amp: 0.2, curve: 20 });
    noiseBurst(b, sr, rng, { t0: 0.06, dur: 0.26, amp: 0.32, type: 'bp',
      f0: 1500, f1: 3200, q: 0.85, curve: 4.5, attack: 0.05, hp: 700 });
    for (let i = 0; i < 3; i++) {
      modalHit(b, sr, rng, {
        t0: 0.1 + rng() * 0.28,
        freqs: [1500 + rng() * 1800, 2900 + rng() * 2000],
        t60s: [0.04, 0.026], amps: [1, 0.5], amp: 0.07 + rng() * 0.06, dur: 0.1,
      });
    }
    const lt = 0.42 + v * 0.02;
    noiseBurst(b, sr, rng, { t0: lt, dur: 0.13, amp: 0.58, type: 'lp',
      f0: 900, f1: 220, q: 0.85, curve: 14 });
    tone(b, sr, { t0: lt, dur: 0.14, f0: 108, f1: 50, amp: 0.42, curve: 12, drive: 0.35 });
    noiseBurst(b, sr, rng, { t0: lt + 0.09, dur: 0.09, amp: 0.2, type: 'lp',
      f0: 700, f1: 200, curve: 18 });
    softLimit(b, 0.82); fadeEdges(b, sr, 1, 14);
    return b;
  },

  // Four rungs of a timber ladder: boot on the rung, hand sliding to the next,
  // and the whole thing flexing underneath.
  ladder(sr, rng, v) {
    const b = monoBuf(sr, 1.5);
    for (let i = 0; i < 4; i++) {
      const t = i * (0.3 + v * 0.012) + rng() * 0.02;
      modalHit(b, sr, rng, {
        t0: t, freqs: [196 + i * 9, 447 + i * 14, 830 + i * 21],
        t60s: [0.11, 0.07, 0.045], amps: [1, 0.6, 0.32],
        amp: 0.42, exciteDur: 0.0035, exciteLp: 3600, dur: 0.3,
      });
      noiseBurst(b, sr, rng, { t0: t, dur: 0.04, amp: 0.18, type: 'bp',
        f0: 2000, f1: 900, q: 1.0, curve: 26 });
      noiseBurst(b, sr, rng, { t0: t + 0.09, dur: 0.1, amp: 0.1, type: 'bp',
        f0: 2600, f1: 1500, q: 0.9, curve: 8, attack: 0.02, hp: 900 });
    }
    tone(b, sr, { t0: 0.15, dur: 0.7, f0: 88, f1: 76, amp: 0.07, curve: 2.4, attack: 0.12 });
    softLimit(b, 0.82); fadeEdges(b, sr, 1, 16);
    return b;
  },

  // Hammer falling on an empty chamber. All click, no ring, no powder — the
  // absence of a gunshot is the whole point.
  dryFire(sr, rng, v) {
    const b = monoBuf(sr, 0.2);
    const dt = 1 + (v - 0.5) * 0.05;
    modalHit(b, sr, rng, {
      freqs: [1320 * dt, 2410 * dt, 4180 * dt], t60s: [0.018, 0.012, 0.008],
      amps: [1, 0.6, 0.3], amp: 0.6, exciteDur: 0.0008, exciteLp: 9000, dur: 0.07,
    });
    noiseBurst(b, sr, rng, { dur: 0.008, amp: 0.4, type: 'hp', f0: 3600, curve: 70 });
    tone(b, sr, { dur: 0.02, f0: 420, f1: 190, amp: 0.16, curve: 34 });
    noiseBurst(b, sr, rng, { t0: 0.004, dur: 0.05, amp: 0.08, type: 'bp',
      f0: 2600, f1: 1900, q: 8, curve: 18 });                 // hammer spring
    softLimit(b, 0.85); fadeEdges(b, sr, 0.4, 8);
    return b;
  },

  // A round going past your head — much tighter and nastier than `whizz`,
  // which is a bullet crossing the field at a distance.
  nearMiss(sr, rng, v) {
    const b = monoBuf(sr, 0.34);
    const dt = 1 + (v - 1) * 0.09;
    // The crack. A very steep envelope on a high-passed burst starves itself
    // (the attack ramp barely finishes before the decay kills it), so the
    // transient is carried by a broader burst and a hard pitched snap instead.
    noiseBurst(b, sr, rng, { dur: 0.022, amp: 1.5, type: 'hp',
      f0: 3600 * dt, q: 0.9, curve: 26, attack: 0.0003 });
    tone(b, sr, { dur: 0.03, f0: 3400 * dt, f1: 620, amp: 0.62,
      curve: 30, drive: 0.6, attack: 0.0004 });
    noiseBurst(b, sr, rng, { t0: 0.001, dur: 0.05, amp: 0.9, type: 'bp',
      f0: 5400 * dt, f1: 2600, q: 1.4, curve: 16, attack: 0.0004 });
    // The zip of displaced air behind it, then the body of the pass.
    noiseBurst(b, sr, rng, { t0: 0.004, dur: 0.15, amp: 0.6, type: 'bp',
      f0: 2600 * dt, f1: 700, q: 3.4, curve: 11 });
    noiseBurst(b, sr, rng, { t0: 0.002, dur: 0.07, amp: 0.34, type: 'lp',
      f0: 1400, f1: 420, curve: 18 });
    softLimit(b, 0.82); fadeEdges(b, sr, 0.5, 10);
    return b;
  },

  // Ammo crate: the box down, brass tumbling into the pouch, canvas closing.
  resupply(sr, rng, v) {
    const b = monoBuf(sr, 1.15);
    const dt = 1 + (v - 0.5) * 0.05;
    modalHit(b, sr, rng, {
      freqs: [186 * dt, 428 * dt, 795 * dt, 1310 * dt], t60s: [0.12, 0.08, 0.05, 0.032],
      amps: [1, 0.6, 0.34, 0.18], amp: 0.55, exciteDur: 0.004, exciteLp: 4200, dur: 0.32,
    });
    tone(b, sr, { dur: 0.07, f0: 120, f1: 62, amp: 0.24, curve: 18, drive: 0.3 });
    scatter(rng, 14, 0.11, 0.62, (t) => {
      modalHit(b, sr, rng, {
        t0: t, freqs: [1800 + rng() * 2400, 3400 + rng() * 2600, 5200 + rng() * 2000],
        t60s: [0.05, 0.032, 0.02], amps: [1, 0.5, 0.25],
        amp: 0.06 + rng() * 0.06, exciteDur: 0.0009, exciteLp: 11000, dur: 0.14,
      });
    });
    noiseBurst(b, sr, rng, { t0: 0.6, dur: 0.2, amp: 0.2, type: 'bp',
      f0: 2400, f1: 1200, q: 0.75, curve: 8, attack: 0.02, hp: 800 });
    modalHit(b, sr, rng, {
      t0: 0.7, freqs: [1046.5, 1568, 2093], t60s: [0.3, 0.2, 0.12],
      amps: [1, 0.5, 0.25], amp: 0.14, exciteDur: 0.0012, exciteLp: 8000, dur: 0.4,
    });
    softLimit(b, 0.85); fadeEdges(b, sr, 1, 16);
    return b;
  },

  // Engineer on the hull: three spanner strikes on armour plate, then a
  // ratchet run. Bright and metallic so it reads over an idling engine.
  repair(sr, rng, v) {
    const b = monoBuf(sr, 1.5);
    const hits = [0, 0.29 + v * 0.02, 0.6 + v * 0.03];
    for (let i = 0; i < hits.length; i++) {
      const g = i === 1 ? 1 : 0.82;
      noiseBurst(b, sr, rng, { t0: hits[i], dur: 0.008, amp: 0.42 * g,
        type: 'hp', f0: 4200, curve: 80 });
      modalHit(b, sr, rng, {
        t0: hits[i], freqs: [1210, 2180, 3460, 5010], t60s: [0.3, 0.2, 0.13, 0.08],
        amps: [1, 0.65, 0.4, 0.22], amp: 0.42 * g,
        exciteDur: 0.0015, exciteLp: 12000, dur: 0.5,
      });
      tone(b, sr, { t0: hits[i], dur: 0.06, f0: 280, f1: 130, amp: 0.18 * g,
        curve: 22, drive: 0.3 });
    }
    for (let i = 0; i < 9; i++) {
      modalHit(b, sr, rng, {
        t0: 0.86 + i * 0.032, freqs: [2600, 4300], t60s: [0.012, 0.008],
        amps: [1, 0.5], amp: 0.14, exciteDur: 0.0006, exciteLp: 10000, dur: 0.04,
      });
    }
    softLimit(b, 0.82); fadeEdges(b, sr, 1, 16);
    return b;
  },

  // --- ordnance ------------------------------------------------------------

  // Throwing a grenade: the safety lever pinging away, the sleeve and the arm
  // sweeping through the air. No detonation — the fuse handles that.
  grenadeThrow(sr, rng, v) {
    const b = monoBuf(sr, 0.6);
    const dt = 1 + (v - 1) * 0.06;
    modalHit(b, sr, rng, {
      freqs: [3120 * dt, 4980 * dt, 6740 * dt], t60s: [0.07, 0.045, 0.028],
      amps: [1, 0.55, 0.3], amp: 0.3, exciteDur: 0.0008, exciteLp: 12000, dur: 0.17,
    });
    noiseBurst(b, sr, rng, { dur: 0.24, amp: 0.38, type: 'bp',
      f0: 900, f1: 2600, q: 0.85, curve: 2.6, attack: 0.05, hp: 500 });
    noiseBurst(b, sr, rng, { t0: 0.05, dur: 0.2, amp: 0.15, type: 'lp',
      f0: 1600, f1: 600, curve: 6, attack: 0.05 });
    modalHit(b, sr, rng, {
      t0: 0.02, freqs: [420, 910, 1580], t60s: [0.05, 0.032, 0.02],
      amps: [1, 0.5, 0.26], amp: 0.16, exciteDur: 0.0025, exciteLp: 4200, dur: 0.14,
    });
    softLimit(b, 0.85); fadeEdges(b, sr, 1, 14);
    return b;
  },

  // A heavy shell rather than a grenade: deeper, longer, more debris, and a
  // valley return that keeps rolling well after the flash.
  explosionBig(sr, rng, v) {
    const b = monoBuf(sr, 4.2);
    const dt = 1 + (v - 0.5) * 0.06;
    noiseBurst(b, sr, rng, { dur: 0.04, amp: 0.95, type: 'hp', f0: 1700, curve: 44 });
    noiseBurst(b, sr, rng, { dur: 1.7, amp: 0.95, type: 'lp',
      f0: 5400, f1: 95, q: 0.8, curve: 3.4 });
    tone(b, sr, { dur: 1.5, f0: 104 * dt, f1: 22, amp: 0.95, curve: 2.4, drive: 0.95 });
    tone(b, sr, { dur: 2.8, f0: 44 * dt, f1: 17, amp: 0.55, curve: 1.3, drive: 0.4 });
    tone(b, sr, { t0: 0.006, dur: 0.22, f0: 520, f1: 140, amp: 0.3, curve: 14, drive: 0.6 });
    scatter(rng, 32, 0.26, 2.6, (t) => {
      if (rng() < 0.4) {
        modalHit(b, sr, rng, {
          t0: t, freqs: [800 + rng() * 2600, 1700 + rng() * 3000],
          t60s: [0.035, 0.022], amps: [1, 0.5], amp: 0.075, dur: 0.1,
        });
      } else {
        noiseBurst(b, sr, rng, { t0: t, dur: 0.07, amp: 0.035 + rng() * 0.055,
          type: 'lp', f0: 800 + rng() * 1400, f1: 220, curve: 15 });
      }
    });
    addTaps(b, sr, [{ t: 0.214, g: 0.38, lp: 1050, hp: 65 },
                    { t: 0.487, g: 0.26, lp: 700, hp: 60 },
                    { t: 0.951, g: 0.16, lp: 440, hp: 55 },
                    { t: 1.71, g: 0.09, lp: 290, hp: 50 },
                    { t: 2.52, g: 0.045, lp: 210, hp: 48 }]);
    allpassChain(b, sr, [16.3, 25.7, 36.1], 0.52);
    softLimit(b, 0.62); fadeEdges(b, sr, 0.6, 50);
    return stereoFinish(stereoize(b, sr, rng, 1.15), sr, 0.62, 0.6, 50);
  },

  // Off-map artillery on the way down. Three shells walking in, each a tone
  // gliding downward while it *swells* (negative dEnv curve) and is then cut
  // dead at impact — the explosion that follows is a separate voice.
  artilleryWhistle(sr, rng, v) {
    const b = monoBuf(sr, 2.2);
    const shells = [[0.0, 1.0, 1.0], [0.42, 0.72, 1.14], [0.86, 0.5, 0.87]];
    const jitter = 1 + (v - 0.5) * 0.05;
    for (let i = 0; i < shells.length; i++) {
      const t0 = shells[i][0], a = shells[i][1], k = shells[i][2] * jitter;
      const dur = 1.05;
      const f0 = 1750 * k, f1 = 360 * k;
      tone(b, sr, { t0, dur, f0, f1, amp: 0.2 * a, curve: -1.15, attack: 0.09,
        fm: 0.012, fmRate: 3.1 });
      tone(b, sr, { t0, dur: dur * 0.96, f0: f0 * 2.01, f1: f1 * 2.01,
        amp: 0.055 * a, curve: -0.9, attack: 0.1 });
      // Air tearing round the shell body.
      noiseBurst(b, sr, rng, { t0, dur, amp: 0.1 * a, type: 'bp',
        f0: f0 * 1.1, f1: f1 * 1.2, q: 3.2, curve: -1.0, attack: 0.1 });
    }
    softLimit(b, 0.8); fadeEdges(b, sr, 4, 30);
    return b;
  },

  // --- vehicles ------------------------------------------------------------

  // The turret ring binding: gear teeth grinding against a jammed race, then
  // the hard stop as the drive gives up.
  metalJam(sr, rng, v) {
    const b = monoBuf(sr, 0.9);
    const n = Math.floor(0.32 * sr);
    const bq = new Biquad(), bq2 = new Biquad();
    for (let i = 0; i < n; i++) {
      const t = i / n;
      if ((i & 31) === 0) {
        const f = 220 + v * 30 + Math.sin(t * 40) * 60 + (rng() - 0.5) * 40;
        bq.bandpass(sr, f, 6);
        bq2.bandpass(sr, f * 3.1, 4);
      }
      const x = rng() * 2 - 1;
      const env = Math.min(1, t / 0.04) * (1 - t) * (1 - t);
      b[i] += (bq.process(x) * 1.2 + bq2.process(x) * 0.55) * env;
    }
    modalHit(b, sr, rng, {
      t0: 0.3, freqs: [148, 337, 611, 1120], t60s: [0.2, 0.13, 0.085, 0.05],
      amps: [1, 0.62, 0.36, 0.2], amp: 0.6, exciteDur: 0.003, exciteLp: 4200, dur: 0.42,
    });
    tone(b, sr, { t0: 0.3, dur: 0.12, f0: 130, f1: 58, amp: 0.4, curve: 13, drive: 0.4 });
    noiseBurst(b, sr, rng, { t0: 0.3, dur: 0.05, amp: 0.24, type: 'bp',
      f0: 1800, f1: 700, q: 1.0, curve: 24 });
    softLimit(b, 0.8); fadeEdges(b, sr, 2, 18);
    return b;
  },

  // Throwing a track: the pin shears, then the run slaps off each roadwheel
  // in turn as it unspools and drops into the dirt.
  trackSnap(sr, rng, v) {
    const b = monoBuf(sr, 1.8);
    const dt = 1 + (v - 0.5) * 0.05;
    noiseBurst(b, sr, rng, { dur: 0.014, amp: 0.9, type: 'hp', f0: 2600, curve: 65 });
    modalHit(b, sr, rng, {
      freqs: [980 * dt, 1760 * dt, 2940 * dt, 4520 * dt], t60s: [0.34, 0.22, 0.14, 0.08],
      amps: [1, 0.68, 0.42, 0.24], amp: 0.7, exciteDur: 0.0016, exciteLp: 13000, dur: 0.55,
    });
    tone(b, sr, { dur: 0.16, f0: 320, f1: 78, amp: 0.5, curve: 12, drive: 0.55 });
    const slaps = [0.1, 0.19, 0.31, 0.44, 0.6, 0.79, 1.02];
    for (let i = 0; i < slaps.length; i++) {
      const g = Math.pow(0.82, i);
      modalHit(b, sr, rng, {
        t0: slaps[i],
        freqs: [620 + rng() * 500, 1340 + rng() * 900, 2500 + rng() * 1400],
        t60s: [0.09, 0.06, 0.038], amps: [1, 0.55, 0.3],
        amp: 0.55 * g, exciteDur: 0.0018, exciteLp: 9000, dur: 0.22,
      });
      noiseBurst(b, sr, rng, { t0: slaps[i], dur: 0.06, amp: 0.18 * g,
        type: 'lp', f0: 1200, f1: 300, curve: 18 });
      tone(b, sr, { t0: slaps[i], dur: 0.05, f0: 150, f1: 70, amp: 0.14 * g, curve: 20 });
    }
    noiseBurst(b, sr, rng, { t0: 0.5, dur: 0.6, amp: 0.13, type: 'lp',
      f0: 900, f1: 220, curve: 5, attack: 0.04 });            // dirt kicked up
    softLimit(b, 0.78); fadeEdges(b, sr, 0.6, 20);
    return b;
  },

  // Radiator gone: the bang, the con-rod knocking itself to a stop, coolant
  // flashing to steam, and the block groaning down the scale.
  engineBlow(sr, rng, v) {
    const b = monoBuf(sr, 2.6);
    const dt = 1 + (v - 0.5) * 0.05;
    noiseBurst(b, sr, rng, { dur: 0.025, amp: 0.68, type: 'hp', f0: 1600, curve: 46 });
    noiseBurst(b, sr, rng, { dur: 0.4, amp: 0.55, type: 'lp',
      f0: 3200, f1: 220, q: 0.8, curve: 7 });
    tone(b, sr, { dur: 0.34, f0: 190 * dt, f1: 44, amp: 0.68, curve: 6, drive: 0.7 });
    let t = 0.14, gap = 0.075;
    for (let i = 0; i < 9; i++) {
      modalHit(b, sr, rng, {
        t0: t, freqs: [286 * dt, 640 * dt, 1180 * dt, 2050 * dt],
        t60s: [0.08, 0.05, 0.033, 0.02], amps: [1, 0.6, 0.34, 0.18],
        amp: 0.32 * Math.pow(0.86, i), exciteDur: 0.0022, exciteLp: 5200, dur: 0.2,
      });
      t += gap; gap *= 1.17;
    }
    noiseBurst(b, sr, rng, { t0: 0.18, dur: 1.9, amp: 0.26, type: 'hp',
      f0: 3400, curve: 1.5, attack: 0.06 });
    noiseBurst(b, sr, rng, { t0: 0.18, dur: 1.7, amp: 0.13, type: 'bp',
      f0: 5200, f1: 2600, q: 0.8, curve: 1.7, attack: 0.08 });
    tone(b, sr, { t0: 0.06, dur: 1.4, f0: 96, f1: 38, amp: 0.14, curve: 2.4,
      attack: 0.05, wave: 'saw', drive: 0.3, fm: 0.05, fmRate: 9 });
    softLimit(b, 0.78); fadeEdges(b, sr, 1, 40);
    return b;
  },

  // The traverse motor. Retriggered continuously while the turret moves, so
  // it is short, quiet and enveloped to butt cleanly against itself.
  turretSlew(sr, rng, v) {
    const b = monoBuf(sr, 0.3);
    const f = 320 + v * 26;
    const parts = [[1, 0.3], [2.01, 0.14], [3.02, 0.07], [5.03, 0.03]];
    for (let i = 0; i < parts.length; i++) {
      tone(b, sr, { dur: 0.24, f0: f * parts[i][0], f1: f * parts[i][0] * 1.01,
        amp: parts[i][1], curve: 1.2, attack: 0.02, fm: 0.01, fmRate: 41 });
    }
    noiseBurst(b, sr, rng, { dur: 0.24, amp: 0.12, type: 'bp',
      f0: 1900, q: 2.4, curve: 1.4, attack: 0.02 });          // ring-gear teeth
    softLimit(b, 0.85); fadeEdges(b, sr, 6, 25);
    return b;
  },

  // A tank brewing up. The `explosion` event already supplies the blast, so
  // this is the metal: hatches going, plate tearing, ammunition cooking off
  // for two seconds, and the wreck settling.
  tankDestroyed(sr, rng, v) {
    const b = monoBuf(sr, 3.4);
    const dt = 1 + (v - 0.5) * 0.05;
    noiseBurst(b, sr, rng, { dur: 0.06, amp: 0.75, type: 'bp',
      f0: 1400, f1: 420, q: 0.7, curve: 22 });
    modalHit(b, sr, rng, {
      freqs: [154 * dt, 341 * dt, 622 * dt, 1080 * dt, 1870 * dt],
      t60s: [0.9, 0.62, 0.42, 0.26, 0.15], amps: [1, 0.7, 0.45, 0.26, 0.14],
      amp: 0.7, exciteDur: 0.004, exciteLp: 9000, dur: 1.3,
    });
    tone(b, sr, { dur: 0.7, f0: 118 * dt, f1: 33, amp: 0.6, curve: 4.2, drive: 0.8 });
    scatter(rng, 13, 0.28, 2.5, (t) => {
      noiseBurst(b, sr, rng, { t0: t, dur: 0.03, amp: 0.1 + rng() * 0.14,
        type: 'hp', f0: 1800 + rng() * 2200, curve: 34 });
      tone(b, sr, { t0: t, dur: 0.07, f0: 260 + rng() * 200, f1: 70,
        amp: 0.09 + rng() * 0.1, curve: 16, drive: 0.4 });
    });
    noiseBurst(b, sr, rng, { t0: 0.2, dur: 2.9, amp: 0.18, type: 'lp',
      f0: 1200, f1: 420, q: 0.7, curve: 1.1, attack: 0.35 });
    noiseBurst(b, sr, rng, { t0: 0.25, dur: 2.6, amp: 0.085, type: 'bp',
      f0: 2600, q: 0.8, curve: 1.2, attack: 0.4 });
    modalHit(b, sr, rng, {
      t0: 1.35, freqs: [96, 214, 398, 690], t60s: [0.5, 0.34, 0.22, 0.13],
      amps: [1, 0.6, 0.34, 0.18], amp: 0.32, exciteDur: 0.005, exciteLp: 3600, dur: 0.8,
    });
    addTaps(b, sr, [{ t: 0.164, g: 0.26, lp: 1400, hp: 70 },
                    { t: 0.381, g: 0.15, lp: 900, hp: 65 },
                    { t: 0.742, g: 0.08, lp: 560, hp: 60 }]);
    softLimit(b, 0.72); fadeEdges(b, sr, 0.6, 45);
    return stereoFinish(stereoize(b, sr, rng, 0.9), sr, 0.72, 0.6, 45);
  },

  // --- narrative stings ----------------------------------------------------

  // Your turn: a rising horn call over a harp figure and a soft timpani lift.
  turnPlayer(sr, rng) {
    const b = monoBuf(sr, 1.9);
    horn(b, sr, 0.0, 0.34, 220, 0.3);            // A3
    horn(b, sr, 0.26, 0.78, 329.63, 0.34);       // E4
    const arp = [440, 659.25, 880, 1318.51];
    for (let i = 0; i < arp.length; i++) {
      modalHit(b, sr, rng, {
        t0: 0.3 + i * 0.055, freqs: [arp[i], arp[i] * 2, arp[i] * 3.01],
        t60s: [0.5, 0.32, 0.2], amps: [1, 0.45, 0.22],
        amp: 0.15, exciteDur: 0.0012, exciteLp: 7000, dur: 0.7,
      });
    }
    modalHit(b, sr, rng, {
      freqs: [110, 165, 220], t60s: [0.5, 0.3, 0.2], amps: [1, 0.5, 0.25],
      amp: 0.3, exciteDur: 0.006, exciteLp: 1200, dur: 0.7,
    });
    softLimit(b, 0.8); fadeEdges(b, sr, 2, 40);
    return stereoFinish(stereoize(b, sr, rng, 0.7), sr, 0.8, 2, 40);
  },

  // Their turn: the same gesture inverted — low brass falling a minor third
  // over a dark timpani and a bed of low strings.
  turnEnemy(sr, rng) {
    const b = monoBuf(sr, 2.0);
    horn(b, sr, 0.0, 0.42, 138.59, 0.32);        // C#3
    horn(b, sr, 0.3, 0.9, 116.54, 0.34);         // A#2
    modalHit(b, sr, rng, {
      freqs: [58.27, 87.4, 116.54], t60s: [0.9, 0.5, 0.3], amps: [1, 0.45, 0.22],
      amp: 0.4, exciteDur: 0.007, exciteLp: 900, dur: 1.2,
    });
    noiseBurst(b, sr, rng, { t0: 0.02, dur: 1.1, amp: 0.06, type: 'bp',
      f0: 300, f1: 180, q: 1.2, curve: 2.4, attack: 0.12 });
    softLimit(b, 0.8); fadeEdges(b, sr, 2, 45);
    return stereoFinish(stereoize(b, sr, rng, 0.6), sr, 0.8, 2, 45);
  },

  // Mission won: two-note pickup into a C major brass chord, timpani, cymbal.
  victory(sr, rng) {
    const b = monoBuf(sr, 2.8);
    horn(b, sr, 0.0, 0.16, 349.23, 0.2);         // F4
    horn(b, sr, 0.14, 0.2, 392.0, 0.22);         // G4
    const chord = [[261.63, 0.22], [329.63, 0.19], [392.0, 0.17], [523.25, 0.15]];
    for (let i = 0; i < chord.length; i++) horn(b, sr, 0.3, 1.35, chord[i][0], chord[i][1]);
    modalHit(b, sr, rng, {
      t0: 0.3, freqs: [65.41, 98, 130.81, 196], t60s: [1.0, 0.6, 0.36, 0.2],
      amps: [1, 0.5, 0.3, 0.15], amp: 0.48, exciteDur: 0.006, exciteLp: 1200, dur: 1.4,
    });
    noiseBurst(b, sr, rng, { t0: 0.3, dur: 1.5, amp: 0.12, type: 'hp',
      f0: 4200, curve: 3.0, attack: 0.012 });
    noiseBurst(b, sr, rng, { t0: 0.3, dur: 0.6, amp: 0.09, type: 'bp',
      f0: 7200, q: 0.7, curve: 5, attack: 0.006 });
    allpassChain(b, sr, [11.3, 19.1, 27.7], 0.42);
    softLimit(b, 0.75); fadeEdges(b, sr, 2, 60);
    return stereoFinish(stereoize(b, sr, rng, 0.9), sr, 0.75, 2, 60);
  },

  // Mission lost: three low brass notes falling away under a funeral bell.
  defeat(sr, rng) {
    const b = monoBuf(sr, 3.2);
    horn(b, sr, 0.0, 1.5, 146.83, 0.24);         // D3
    horn(b, sr, 0.55, 1.9, 116.54, 0.22);        // A#2
    horn(b, sr, 1.1, 1.9, 87.31, 0.2);           // F2
    modalHit(b, sr, rng, {
      t0: 0.02, freqs: [174.61, 349.2, 523.9, 698.9], t60s: [2.2, 1.4, 0.9, 0.5],
      amps: [1, 0.4, 0.2, 0.1], amp: 0.24, exciteDur: 0.004, exciteLp: 2600, dur: 2.6,
    });
    noiseBurst(b, sr, rng, { dur: 2.2, amp: 0.05, type: 'lp',
      f0: 420, f1: 160, curve: 1.6, attack: 0.25 });
    softLimit(b, 0.8); fadeEdges(b, sr, 3, 80);
    return stereoFinish(stereoize(b, sr, rng, 0.8), sr, 0.8, 3, 80);
  },

  // A camp changes hands: a short bugle call, the colours snapping in the
  // wind, and a field drum underneath.
  capture(sr, rng) {
    const b = monoBuf(sr, 2.0);
    horn(b, sr, 0.0, 0.2, 392.0, 0.26);          // G4
    horn(b, sr, 0.17, 0.24, 523.25, 0.28);       // C5
    horn(b, sr, 0.38, 0.8, 659.25, 0.3);         // E5
    for (let i = 0; i < 3; i++) {
      noiseBurst(b, sr, rng, { t0: 0.5 + i * 0.17, dur: 0.13, amp: 0.15, type: 'bp',
        f0: 1600 + i * 300, f1: 800, q: 0.9, curve: 12, attack: 0.006, hp: 600 });
    }
    modalHit(b, sr, rng, {
      freqs: [98, 147, 196], t60s: [0.4, 0.25, 0.16], amps: [1, 0.5, 0.25],
      amp: 0.28, exciteDur: 0.005, exciteLp: 1100, dur: 0.6,
    });
    softLimit(b, 0.82); fadeEdges(b, sr, 2, 40);
    return b;
  },

  // A soldier is gone for good. One bell, one held cello note, nothing else.
  unitLost(sr, rng) {
    const b = monoBuf(sr, 2.6);
    modalHit(b, sr, rng, {
      freqs: [110, 219.6, 329, 440.7, 587], t60s: [1.9, 1.25, 0.8, 0.5, 0.3],
      amps: [1, 0.42, 0.24, 0.13, 0.07], amp: 0.42,
      exciteDur: 0.005, exciteLp: 2400, dur: 2.4,
    });
    horn(b, sr, 0.06, 1.5, 110, 0.14);
    noiseBurst(b, sr, rng, { dur: 0.02, amp: 0.1, type: 'lp', f0: 1600, f1: 500, curve: 30 });
    softLimit(b, 0.82); fadeEdges(b, sr, 2, 70);
    return b;
  },

  // Medic evac: a rising G-C-E-G bell arpeggio — the one unambiguously
  // hopeful sound in the bank.
  rescue(sr, rng) {
    const b = monoBuf(sr, 1.6);
    const notes = [392.0, 523.25, 659.25, 783.99];
    for (let i = 0; i < notes.length; i++) {
      modalHit(b, sr, rng, {
        t0: i * 0.085,
        freqs: [notes[i], notes[i] * 2, notes[i] * 3, notes[i] * 4.01],
        t60s: [0.75 - i * 0.08, 0.45, 0.28, 0.16], amps: [1, 0.5, 0.26, 0.13],
        amp: 0.32 - i * 0.03, exciteDur: 0.0015, exciteLp: 6500, dur: 0.95,
      });
    }
    horn(b, sr, 0.34, 0.7, 261.63, 0.1);
    softLimit(b, 0.85); fadeEdges(b, sr, 1, 40);
    return b;
  },
};

// Composite bursts — rendered by mixing the single-shot generator at a
// realistic cyclic rate, so a burst is one voice instead of five.
GEN.smgBurst = (sr, rng, v) => _burst(sr, rng, v, 'smg', 5 + v, 0.082, 0.55);
GEN.mgBurst = (sr, rng, v) => _burst(sr, rng, v, 'mg', 6 + v, 0.098, 0.85);

// Mirrored pairs: one design, two readings of it.
GEN.aimIn = (sr, rng, v) => _aimGesture(sr, rng, v, true);
GEN.aimOut = (sr, rng, v) => _aimGesture(sr, rng, v, false);
GEN.tankHit = (sr, rng, v) => _armourHit(sr, rng, v, false);
GEN.tankHitHeavy = (sr, rng, v) => _armourHit(sr, rng, v, true);
GEN.reinforceFriendly = (sr, rng) => _reinforce(sr, rng, true);
GEN.reinforceEnemy = (sr, rng) => _reinforce(sr, rng, false);
GEN.potentialGood = (sr, rng, v) => _potential(sr, rng, v, true);
GEN.potentialBad = (sr, rng, v) => _potential(sr, rng, v, false);

/**
 * A brass note. Additive rather than a filtered saw: a horn's spectrum is a
 * handful of strong low partials that die back to the fundamental as the note
 * decays, and stacking `tone()` calls with staggered decay curves reproduces
 * that far more cheaply — and more controllably — than a filter sweep.
 * The shared slow vibrato is what keeps a chord of these from sounding like
 * an organ.
 */
export function horn(b, sr, t0, dur, f, amp) {
  const parts = [1, 0.42, 0.24, 0.12, 0.055];
  for (let i = 0; i < parts.length; i++) {
    tone(b, sr, {
      t0, dur: dur * (1 - i * 0.08), f0: f * (i + 1), amp: amp * parts[i],
      curve: 2.4 + i * 0.55, attack: 0.03 + i * 0.006, fm: 0.0035, fmRate: 5.4,
    });
  }
}

// Weapon coming up to the shoulder / going back down. Direction is carried by
// the sweep of the cloth band and by *when* the hardware settles: on the way
// up the rifle arrives after the movement, on the way down it leaves first.
function _aimGesture(sr, rng, v, up) {
  const b = monoBuf(sr, 0.5);
  const dt = 1 + (v - 0.5) * 0.06;
  noiseBurst(b, sr, rng, { dur: 0.2, amp: 0.3, type: 'bp',
    f0: (up ? 1300 : 2600) * dt, f1: (up ? 2900 : 1200) * dt,
    q: 0.8, curve: 6, attack: 0.03, hp: 700 });
  const t = up ? 0.15 : 0.02;
  modalHit(b, sr, rng, {
    t0: t, freqs: [520 * dt, 1180 * dt, 2060 * dt], t60s: [0.05, 0.032, 0.02],
    amps: [1, 0.55, 0.28], amp: up ? 0.34 : 0.22,
    exciteDur: 0.0025, exciteLp: 5000, dur: 0.16,
  });
  tone(b, sr, { dur: 0.26, f0: up ? 210 : 300, f1: up ? 300 : 190,
    amp: 0.06, curve: 5, attack: 0.05 });
  noiseBurst(b, sr, rng, { t0: 0.02, dur: 0.16, amp: 0.09, type: 'lp',
    f0: up ? 700 : 1400, f1: up ? 1500 : 600, curve: 8, attack: 0.03 });
  softLimit(b, 0.85); fadeEdges(b, sr, 1, 12);
  return b;
}

// A round on armour plate. The heavy reading is not just louder: the plate is
// modelled bigger (lower, longer modes), the hull cavity behind it booms, and
// spall comes off. That difference is what sells 120+ damage.
function _armourHit(sr, rng, v, heavy) {
  const b = monoBuf(sr, heavy ? 1.6 : 1.0);
  const dt = 1 + (v - 0.5) * 0.07;
  noiseBurst(b, sr, rng, { dur: heavy ? 0.016 : 0.009, amp: heavy ? 0.85 : 0.7,
    type: 'hp', f0: heavy ? 2600 : 3800, curve: 62 });
  modalHit(b, sr, rng, {
    freqs: heavy
      ? [188 * dt, 402 * dt, 731 * dt, 1284 * dt, 2137 * dt, 3410 * dt]
      : [268 * dt, 585 * dt, 1042 * dt, 1810 * dt, 2960 * dt],
    t60s: heavy ? [0.85, 0.6, 0.42, 0.28, 0.17, 0.1] : [0.42, 0.3, 0.2, 0.13, 0.08],
    amps: [1, 0.7, 0.48, 0.3, 0.18, 0.1],
    amp: heavy ? 0.78 : 0.6, exciteDur: 0.0022, exciteLp: 11000,
    dur: heavy ? 1.2 : 0.7,
  });
  tone(b, sr, { dur: heavy ? 0.34 : 0.18, f0: (heavy ? 132 : 176) * dt,
    f1: heavy ? 41 : 62, amp: heavy ? 0.6 : 0.4,
    curve: heavy ? 7 : 12, drive: 0.5 });
  scatter(rng, heavy ? 9 : 5, 0.02, heavy ? 0.5 : 0.28, (t) => {
    noiseBurst(b, sr, rng, { t0: t, dur: 0.014, amp: 0.04 + rng() * 0.055,
      type: 'hp', f0: 3800 + rng() * 3600, curve: 42 });
  });
  if (heavy) addTaps(b, sr, [{ t: 0.061, g: 0.2, lp: 2600 }, { t: 0.129, g: 0.11, lp: 1600 }]);
  softLimit(b, 0.8); fadeEdges(b, sr, 0.6, 18);
  return b;
}

// A wave arriving: an officer's pea whistle (two close tones beating against
// each other plus a warble), a field-drum roll swelling in, and a downbeat.
// The enemy reading drops the whistle a fourth and darkens the drum.
function _reinforce(sr, rng, friendly) {
  const b = monoBuf(sr, 2.3);
  const wf = friendly ? 2350 : 1720;
  const pea = [[1, 0.26], [1.006, 0.22], [2.02, 0.08]];
  for (let i = 0; i < pea.length; i++) {
    tone(b, sr, { dur: 0.42, f0: wf * pea[i][0], f1: wf * pea[i][0] * 1.02,
      amp: pea[i][1], curve: 2.6, attack: 0.02, fm: 0.02, fmRate: 34 });
  }
  noiseBurst(b, sr, rng, { dur: 0.42, amp: 0.07, type: 'bp',
    f0: wf, q: 2.2, curve: 2.6, attack: 0.02 });
  for (let i = 0; i < 26; i++) {
    const t = 0.4 + 1.1 * (i / 25);
    noiseBurst(b, sr, rng, { t0: t, dur: 0.05, amp: 0.045 + 0.085 * (i / 25),
      type: 'hp', f0: friendly ? 2200 : 1500, curve: 30 });
  }
  modalHit(b, sr, rng, {
    t0: 1.5, freqs: friendly ? [110, 165, 220] : [73.4, 110, 146.8],
    t60s: [0.5, 0.3, 0.2], amps: [1, 0.5, 0.25], amp: 0.42,
    exciteDur: 0.006, exciteLp: 1100, dur: 0.7,
  });
  noiseBurst(b, sr, rng, { t0: 1.5, dur: 0.16, amp: 0.2, type: 'hp', f0: 1800, curve: 16 });
  softLimit(b, 0.8); fadeEdges(b, sr, 2, 40);
  return b;
}

// A Potential firing. Good: a bright open arpeggio with air above it. Bad: a
// damped fall of a minor third with the top rolled off.
function _potential(sr, rng, v, good) {
  const b = monoBuf(sr, good ? 1.3 : 1.0);
  const k = 1 + (v - 0.5) * 0.04;
  if (good) {
    const arp = [659.25, 987.77, 1318.51];                   // E5 B5 E6
    for (let i = 0; i < arp.length; i++) {
      modalHit(b, sr, rng, {
        t0: i * 0.055, freqs: [arp[i] * k, arp[i] * k * 2, arp[i] * k * 3.01],
        t60s: [0.6 - i * 0.09, 0.36, 0.22], amps: [1, 0.45, 0.22],
        amp: 0.32, exciteDur: 0.0012, exciteLp: 8000, dur: 0.8,
      });
    }
    noiseBurst(b, sr, rng, { t0: 0.02, dur: 0.5, amp: 0.045, type: 'hp',
      f0: 6500, curve: 4.5, attack: 0.03 });
  } else {
    const arp = [415.3, 311.13];                             // G#4 -> D#4
    for (let i = 0; i < arp.length; i++) {
      modalHit(b, sr, rng, {
        t0: i * 0.1, freqs: [arp[i] * k, arp[i] * k * 1.99, arp[i] * k * 2.98],
        t60s: [0.4, 0.26, 0.16], amps: [1, 0.45, 0.2], amp: 0.32,
        exciteDur: 0.0035, exciteLp: 3200, dur: 0.6,
      });
    }
    tone(b, sr, { t0: 0.1, dur: 0.3, f0: 155.6, f1: 138, amp: 0.16, curve: 7, drive: 0.3 });
  }
  softLimit(b, 0.85); fadeEdges(b, sr, 1, 25);
  return b;
}

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
