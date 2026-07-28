// src/audio/ambience.js — the living background of the Gallian valley.
//
// Continuous beds (wind, river, crickets) are single looping AudioBuffers with
// control-rate filter/gain modulation — a handful of nodes total. Everything
// episodic (artillery, birdsong, flag snaps) is a baked one-shot scheduled by
// a self-rescheduling timer that reacts to combat heat.
//
// The whole bed ducks under gunfire and swells back over a few seconds, and
// the birds go quiet the moment shooting starts — the single most effective
// cue for "the battle has begun" that costs nothing.

import { makeRng, rngRange, rngInt } from '../core/rng.js';
import {
  Biquad, monoBuf, noiseBurst, tone, softLimit, fadeEdges, allpassChain,
} from './sfx.js';

const TAU = Math.PI * 2;

// --- bed renderers ---------------------------------------------------------

/** Stereo wind bed: two decorrelated channels of pink-tilted noise. Spectral
 *  shaping and gusting happen live in the node graph so one 6 s loop can be
 *  everything from a still evening to a squall. */
function renderWindBed(sr, seed) {
  const n = Math.ceil(sr * 6);
  const out = [new Float32Array(n), new Float32Array(n)];
  for (let c = 0; c < 2; c++) {
    const rng = makeRng((seed ^ (c * 7919 + 13)) >>> 0);
    const b = out[c];
    // Three-stage pink filter — cheap and spectrally convincing.
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < n; i++) {
      const w = rng() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.0990460;
      b1 = 0.96300 * b1 + w * 0.2965164;
      b2 = 0.57000 * b2 + w * 1.0526913;
      b[i] = (b0 + b1 + b2 + w * 0.1848) * 0.22;
    }
    // Wrap-blend the loop seam.
    const x = Math.floor(sr * 0.25);
    for (let i = 0; i < x; i++) {
      const k = i / x;
      b[i] = b[i] * k + b[n - x + i] * (1 - k);
    }
  }
  return out;
}

/** River: broadband water plus a slow bubbling layer. */
function renderRiverBed(sr, seed) {
  const n = Math.ceil(sr * 5);
  const out = [new Float32Array(n), new Float32Array(n)];
  for (let c = 0; c < 2; c++) {
    const rng = makeRng((seed ^ (c * 3313 + 71)) >>> 0);
    const b = out[c];
    const bp = new Biquad(), hp = new Biquad().highpass(sr, 180, 0.6);
    let f = 1400;
    for (let i = 0; i < n; i++) {
      if ((i & 127) === 0) {
        // The rushing band wanders — a river is never spectrally static.
        f = 1100 + 700 * Math.sin(i / sr * TAU * 0.21) + (rng() - 0.5) * 260;
        bp.bandpass(sr, f, 0.55);
      }
      const w = rng() * 2 - 1;
      b[i] = (bp.process(w) * 0.75 + hp.process(w) * 0.28) * 0.5;
    }
    // Bubbles and eddies: short rising pitch blips over the rush.
    const r2 = makeRng((seed ^ (c * 101 + 5)) >>> 0);
    for (let k = 0; k < 34; k++) {
      const t = r2() * 4.6;
      const fq = 380 + r2() * 900;
      tone(b, sr, { t0: t, dur: 0.05 + r2() * 0.05, f0: fq * 0.7, f1: fq * 1.5,
        amp: 0.03 + r2() * 0.05, curve: 12 });
    }
    const x = Math.floor(sr * 0.2);
    for (let i = 0; i < x; i++) {
      const kk = i / x;
      b[i] = b[i] * kk + b[n - x + i] * (1 - kk);
    }
  }
  return out;
}

/** Crickets: a stereo field of independent stridulating pulse trains. Each
 *  insect has its own rate, pitch and phase, which is what makes a real
 *  cricket field shimmer instead of buzz. */
function renderCricketBed(sr, seed) {
  const n = Math.ceil(sr * 4);
  const out = [new Float32Array(n), new Float32Array(n)];
  const rng = makeRng(seed >>> 0);
  const count = 11;
  for (let k = 0; k < count; k++) {
    const f = 3600 + rng() * 2400;
    const rate = 3.4 + rng() * 2.6;         // chirps per second
    const pan = rng();
    const lvl = (0.06 + rng() * 0.07) / (1 + k * 0.06);
    const phase = rng() * 4;
    for (let t = phase % (1 / rate); t < 4; t += 1 / rate) {
      // Each chirp is a 3-5 pulse burst of a narrow band.
      const pulses = 3 + Math.floor(rng() * 3);
      for (let p = 0; p < pulses; p++) {
        const tt = t + p * 0.011;
        if (tt >= 3.95) break;
        for (let c = 0; c < 2; c++) {
          const g = lvl * (c === 0 ? 1 - pan : pan);
          noiseBurst(out[c], sr, rng, { t0: tt, dur: 0.009, amp: g,
            type: 'bp', f0: f, q: 24, curve: 22 });
        }
      }
    }
  }
  for (let c = 0; c < 2; c++) {
    const x = Math.floor(sr * 0.12);
    const b = out[c];
    for (let i = 0; i < x; i++) {
      const kk = i / x;
      b[i] = b[i] * kk + b[n - x + i] * (1 - kk);
    }
  }
  return out;
}

/** Off-map artillery: a filtered roll with no transient, arriving late and
 *  smeared, as a distant battery actually sounds across a valley. */
function renderArtillery(sr, seed) {
  const rng = makeRng(seed >>> 0);
  const dur = 4.2;
  const b = monoBuf(sr, dur);
  const salvo = 1 + Math.floor(rng() * 3);
  for (let i = 0; i < salvo; i++) {
    const t = i * (0.28 + rng() * 0.5);
    const g = 1 - i * 0.18;
    noiseBurst(b, sr, rng, { t0: t, dur: 2.2, amp: 0.6 * g, type: 'lp',
      f0: 420 + rng() * 200, f1: 78, q: 0.7, curve: 1.6, attack: 0.09 });
    tone(b, sr, { t0: t, dur: 2.0, f0: 41 + rng() * 12, f1: 18, amp: 0.42 * g,
      curve: 1.5, attack: 0.11, drive: 0.2 });
    noiseBurst(b, sr, rng, { t0: t + 0.6, dur: 1.7, amp: 0.2 * g, type: 'lp',
      f0: 300, f1: 82, curve: 1.7, attack: 0.18 });
  }
  allpassChain(b, sr, [29.3, 43.1, 61.7], 0.6);
  softLimit(b, 0.75);
  fadeEdges(b, sr, 8, 90);
  return [b];
}

/** One birdsong motif — 2-6 phrases of a single "species". */
function renderBird(sr, seed) {
  const rng = makeRng(seed >>> 0);
  const species = Math.floor(rng() * 3);
  const b = monoBuf(sr, 1.9);
  const base = 2400 + rng() * 2400;
  const phrases = 2 + Math.floor(rng() * 4);
  let t = 0.02;
  for (let p = 0; p < phrases; p++) {
    if (species === 0) {
      // Two-note whistle, falling — a chaffinch-ish call.
      const f = base * (0.92 + rng() * 0.16);
      tone(b, sr, { t0: t, dur: 0.075, f0: f, f1: f * 0.74, amp: 0.5, curve: 9, attack: 0.006 });
      tone(b, sr, { t0: t, dur: 0.06, f0: f * 2, f1: f * 1.48, amp: 0.12, curve: 12, attack: 0.006 });
      t += 0.115 + rng() * 0.09;
    } else if (species === 1) {
      // Trill: fast repeated chirps on a rising centre.
      const reps = 4 + Math.floor(rng() * 5);
      const f = base * (0.8 + rng() * 0.3);
      for (let i = 0; i < reps; i++) {
        const ff = f * (1 + i * 0.02);
        tone(b, sr, { t0: t + i * 0.036, dur: 0.028, f0: ff * 1.1, f1: ff * 0.88,
          amp: 0.4, curve: 14, attack: 0.004 });
      }
      t += reps * 0.036 + 0.16 + rng() * 0.14;
    } else {
      // Rising chirp with a little frequency vibrato — a warbler.
      const f = base * (0.85 + rng() * 0.35);
      tone(b, sr, { t0: t, dur: 0.1, f0: f * 0.72, f1: f * 1.28, amp: 0.45,
        curve: 7, attack: 0.008, fm: 0.05, fmRate: 42 });
      tone(b, sr, { t0: t + 0.005, dur: 0.08, f0: f * 1.44, f1: f * 2.56,
        amp: 0.1, curve: 9, attack: 0.008 });
      t += 0.16 + rng() * 0.13;
    }
    if (t > 1.6) break;
  }
  // A whisper of air so the whistles sit in the scene rather than on top of it.
  noiseBurst(b, sr, rng, { dur: Math.min(1.8, t + 0.1), amp: 0.012, type: 'bp',
    f0: base, q: 1.2, curve: 1.0, attack: 0.05 });
  softLimit(b, 0.8);
  fadeEdges(b, sr, 2, 25);
  return [b];
}

/** Canvas flag snapping in a gust. */
function renderFlag(sr, seed) {
  const rng = makeRng(seed >>> 0);
  const b = monoBuf(sr, 1.4);
  const snaps = 2 + Math.floor(rng() * 4);
  let t = 0.02;
  for (let i = 0; i < snaps; i++) {
    noiseBurst(b, sr, rng, { t0: t, dur: 0.06 + rng() * 0.05, amp: 0.42 + rng() * 0.3,
      type: 'bp', f0: 900 + rng() * 900, f1: 2600 + rng() * 1400, q: 0.7,
      curve: 15, attack: 0.004, hp: 400 });
    // The luff — low flutter between snaps.
    noiseBurst(b, sr, rng, { t0: t, dur: 0.2, amp: 0.1, type: 'lp',
      f0: 700, f1: 260, curve: 6, attack: 0.02 });
    t += 0.13 + rng() * 0.22;
    if (t > 1.1) break;
  }
  softLimit(b, 0.8);
  fadeEdges(b, sr, 3, 30);
  return [b];
}

// ---------------------------------------------------------------------------

export class Ambience {
  constructor(ctx, dest, opts = {}) {
    this.ctx = ctx;
    this.dest = dest;
    this.seed = (opts.seed ?? 5150) >>> 0;
    this.rng = makeRng(this.seed);
    this.running = false;

    this.heat = 0;            // combat intensity 0..1, from AudioEngine
    this.wind = 0.38;         // base wind strength 0..1
    this.timeOfDay = opts.timeOfDay ?? 0.62;   // 0 dawn .. 0.5 noon .. 1 night
    this.enclosed = false;
    this._ctrlAcc = 0;
    this._gust = 0.3;
    this._gustTarget = 0.35;
    this._quietFor = 0;       // seconds since combat — birds need this
    this._nextBird = 4;
    this._nextArty = 9;
    this._nextFlag = 6;

    const sr = ctx.sampleRate;
    const mkBuf = (chans) => {
      const b = ctx.createBuffer(chans.length, chans[0].length, sr);
      for (let c = 0; c < chans.length; c++) b.copyToChannel(chans[c], c);
      return b;
    };
    // init() runs inside a click handler, so only the wind bed — the one layer
    // that must be audible immediately — is rendered inline. Everything else
    // is queued and drained one job per frame from update().
    this._lazy = [];

    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(dest);

    // --- wind bed ----------------------------------------------------------
    this.windBuf = mkBuf(renderWindBed(sr, this.seed ^ 0x11));
    this.windSrc = ctx.createBufferSource();
    this.windSrc.buffer = this.windBuf;
    this.windSrc.loop = true;
    // Low body (air moving) and a high band (grass and leaves) that opens up
    // with the gust — the high band is what actually reads as "wind".
    this.windLow = ctx.createBiquadFilter();
    this.windLow.type = 'lowpass';
    this.windLow.frequency.value = 340;
    this.windLow.Q.value = 0.5;
    this.windLowG = ctx.createGain();
    this.windLowG.gain.value = 0.5;
    this.windHi = ctx.createBiquadFilter();
    this.windHi.type = 'bandpass';
    this.windHi.frequency.value = 1500;
    this.windHi.Q.value = 0.55;
    this.windHiG = ctx.createGain();
    this.windHiG.gain.value = 0.22;
    this.windSrc.connect(this.windLow).connect(this.windLowG).connect(this.out);
    this.windSrc.connect(this.windHi).connect(this.windHiG).connect(this.out);

    // --- river -------------------------------------------------------------
    this.riverBuf = null;
    this.riverSrc = null;
    this._lazy.push(() => {
      this.riverBuf = mkBuf(renderRiverBed(sr, this.seed ^ 0x22));
      this.riverSrc = ctx.createBufferSource();
      this.riverSrc.buffer = this.riverBuf;
      this.riverSrc.loop = true;
      this.riverSrc.connect(this.riverFilt);
      if (this.running) this.riverSrc.start(ctx.currentTime);
    });
    this.riverFilt = ctx.createBiquadFilter();
    this.riverFilt.type = 'lowpass';
    this.riverFilt.frequency.value = 5200;
    this.riverGain = ctx.createGain();
    this.riverGain.gain.value = 0;
    this.riverPan = ctx.createPanner();
    this.riverPan.panningModel = 'equalpower';
    this.riverPan.distanceModel = 'inverse';
    this.riverPan.refDistance = 12;
    this.riverPan.rolloffFactor = 1.1;
    this.riverPan.maxDistance = 220;
    this.riverFilt.connect(this.riverGain);
    this.riverGain.connect(this.riverPan);
    this.riverPan.connect(this.out);
    this._riverPositional = false;

    // --- crickets ----------------------------------------------------------
    this.cricketBuf = null;
    this.cricketSrc = null;
    this._lazy.push(() => {
      this.cricketBuf = mkBuf(renderCricketBed(sr, this.seed ^ 0x33));
      this.cricketSrc = ctx.createBufferSource();
      this.cricketSrc.buffer = this.cricketBuf;
      this.cricketSrc.loop = true;
      this.cricketSrc.connect(this.cricketFilt);
      if (this.running) this.cricketSrc.start(ctx.currentTime);
    });
    this.cricketFilt = ctx.createBiquadFilter();
    this.cricketFilt.type = 'highpass';
    this.cricketFilt.frequency.value = 1800;
    this.cricketGain = ctx.createGain();
    this.cricketGain.gain.value = 0;
    this.cricketFilt.connect(this.cricketGain).connect(this.out);

    // --- episodic one-shot banks ------------------------------------------
    this.oneShot = ctx.createGain();
    this.oneShot.gain.value = 1;
    this.oneShot.connect(this.out);
    this.arty = [];
    this.birds = [];
    this.flags = [];
    for (let i = 0; i < 2; i++) {
      this._lazy.push(() => this.arty.push(mkBuf(renderArtillery(sr, this.seed ^ (0x41 + i)))));
    }
    this._lazy.push(() => {
      for (let i = 0; i < 6; i++) this.birds.push(mkBuf(renderBird(sr, this.seed ^ (0x50 + i))));
    });
    this._lazy.push(() => {
      for (let i = 0; i < 3; i++) this.flags.push(mkBuf(renderFlag(sr, this.seed ^ (0x60 + i))));
    });
  }

  // -------------------------------------------------------------------------

  start() {
    if (this.running) return;
    this.running = true;
    const now = this.ctx.currentTime;
    this.windSrc.start(now);
    this.riverSrc?.start(now + 0.01);
    this.cricketSrc?.start(now + 0.02);
    this.out.gain.cancelScheduledValues(now);
    this.out.gain.setValueAtTime(0.0001, now);
    this.out.gain.linearRampToValueAtTime(1, now + 2.5);
    this._applyTimeOfDay(2.5);
  }

  stop(fade = 1.2) {
    if (!this.running) return;
    this.running = false;
    const now = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(now);
    this.out.gain.setValueAtTime(this.out.gain.value, now);
    this.out.gain.linearRampToValueAtTime(0.0001, now + fade);
  }

  /** 0..1 — set by AudioEngine from weapon/ordnance activity. */
  setCombatHeat(h) { this.heat = Math.max(0, Math.min(1, h)); }

  /** Base wind strength 0..1 (gusting is layered on top of this). */
  setWind(w) { this.wind = Math.max(0, Math.min(1, w)); }

  /** 0 dawn .. 0.5 noon .. 1 night. Drives crickets and bird density. */
  setTimeOfDay(t) { this.timeOfDay = t; this._applyTimeOfDay(3); }

  /** Under a roof: wind and birds muffle, the river drops away. */
  setEnclosed(on) {
    if (this.enclosed === !!on) return;
    this.enclosed = !!on;
    const now = this.ctx.currentTime;
    this.windLow.frequency.setTargetAtTime(on ? 180 : 340, now, 0.5);
    this.windHi.frequency.setTargetAtTime(on ? 700 : 1500, now, 0.5);
    this.riverFilt.frequency.setTargetAtTime(on ? 900 : 5200, now, 0.6);
  }

  /** Place the river. Without a position it plays as a quiet stereo bed. */
  setRiver(pos, level = 1) {
    const now = this.ctx.currentTime;
    if (pos) {
      this._riverPositional = true;
      const p = this.riverPan;
      if (p.positionX) {
        p.positionX.setValueAtTime(pos.x, now);
        p.positionY.setValueAtTime(pos.y, now);
        p.positionZ.setValueAtTime(pos.z, now);
      } else p.setPosition(pos.x, pos.y, pos.z);
      this.riverGain.gain.setTargetAtTime(0.9 * level, now, 1.0);
    } else {
      this.riverGain.gain.setTargetAtTime(0.22 * level, now, 1.0);
    }
  }

  _applyTimeOfDay(fade = 2) {
    const now = this.ctx.currentTime;
    // Crickets from late dusk through the night.
    const t = this.timeOfDay;
    const dusk = Math.max(0, Math.min(1, (t - 0.58) / 0.22));
    this.cricketGain.gain.setTargetAtTime(dusk * 0.5, now, fade * 0.4);
  }

  update(dt) {
    if (!this.running) return;
    if (this._lazy.length) this._lazy.shift()();
    this._quietFor = this.heat > 0.12 ? 0 : this._quietFor + dt;

    // Control-rate: 12 Hz is plenty for gust shaping and keeps the AudioParam
    // event queue short.
    this._ctrlAcc += dt;
    if (this._ctrlAcc >= 1 / 12) {
      this._ctrl(this._ctrlAcc);
      this._ctrlAcc = 0;
    }

    // Episodic events.
    this._nextArty -= dt;
    if (this._nextArty <= 0) { this._fireArty(); this._nextArty = rngRange(this.rng, 11, 34); }

    this._nextBird -= dt;
    if (this._nextBird <= 0) {
      // Birds only return once it has been quiet for a while, and are sparse
      // at night.
      const night = Math.max(0, Math.min(1, (this.timeOfDay - 0.6) / 0.25));
      const allowed = this._quietFor > 5.5 && this.rng() > night * 0.85;
      if (allowed) this._fireBird();
      this._nextBird = rngRange(this.rng, allowed ? 3.5 : 1.5, allowed ? 11 : 4);
    }

    this._nextFlag -= dt;
    if (this._nextFlag <= 0) {
      // Flags snap when the wind does.
      if (this._gust > 0.45) this._fireFlag();
      this._nextFlag = rngRange(this.rng, 2.5, 9) * (1.4 - this._gust);
    }
  }

  _ctrl(dt) {
    const now = this.ctx.currentTime;
    // Gust model: a mean-reverting (Ornstein-Uhlenbeck) random walk sets the
    // target, which the audible gust chases with a time constant of ~0.4 s.
    // That's the standard model for wind speed and it sounds like it — long
    // swells and lulls rather than a jittery random level.
    const mean = 0.22 + this.wind * 0.55;
    this._gustTarget += (mean - this._gustTarget) * 0.14 + (this.rng() - 0.5) * 0.46;
    this._gustTarget = Math.max(0.02, Math.min(1.25, this._gustTarget));
    this._gust += (this._gustTarget - this._gust) * (1 - Math.exp(-2.4 * dt));
    const g = this._gust;
    const w = this.wind;

    const dampK = this.enclosed ? 0.45 : 1;
    const tc = 0.28;
    this.windLowG.gain.setTargetAtTime((0.22 + w * 0.5 + g * 0.34) * dampK, now, tc);
    this.windHiG.gain.setTargetAtTime((0.05 + w * 0.16 + g * g * 0.34) * dampK, now, tc);
    // The grass band brightens as the gust rises — that spectral lift is the
    // difference between "noise" and "wind through grass".
    this.windHi.frequency.setTargetAtTime(
      (this.enclosed ? 700 : 1200) + g * 2400 + w * 700, now, tc);
    this.windHi.Q.setTargetAtTime(0.5 + g * 0.5, now, tc);

    // Ducking: the bed drops under combat and swells back over ~3 s.
    const duck = 1 - this.heat * 0.58;
    this.out.gain.setTargetAtTime(duck, now, this.heat > 0.2 ? 0.25 : 1.1);
  }

  _play(buf, gain, pan, when = 0, rate = 1) {
    const ctx = this.ctx;
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    let tail = g;
    if (pan !== undefined && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      g.connect(p);
      tail = p;
    }
    s.connect(g);
    tail.connect(this.oneShot);
    s.start(ctx.currentTime + when);
    s.onended = () => {
      try { s.disconnect(); g.disconnect(); if (tail !== g) tail.disconnect(); }
      catch (e) { /* torn down */ }
    };
    return s;
  }

  _fireArty() {
    if (!this.arty.length) return;
    const buf = this.arty[rngInt(this.rng, 0, this.arty.length - 1)];
    // Artillery is louder and more frequent-sounding when the battle is hot;
    // it is the war going on elsewhere.
    const g = (0.16 + this.rng() * 0.16) * (1 + this.heat * 0.7);
    this._play(buf, g, rngRange(this.rng, -0.75, 0.75), 0,
      rngRange(this.rng, 0.88, 1.12));
  }

  _fireBird() {
    if (!this.birds.length) return;
    const buf = this.birds[rngInt(this.rng, 0, this.birds.length - 1)];
    const g = (0.1 + this.rng() * 0.13) * Math.min(1, this._quietFor / 9);
    this._play(buf, g, rngRange(this.rng, -0.9, 0.9), this.rng() * 0.4,
      rngRange(this.rng, 0.92, 1.14));
  }

  _fireFlag() {
    if (!this.flags.length) return;
    const buf = this.flags[rngInt(this.rng, 0, this.flags.length - 1)];
    const g = (0.05 + this._gust * 0.16);
    this._play(buf, g, rngRange(this.rng, -0.8, 0.8), 0,
      rngRange(this.rng, 0.9, 1.15));
  }

  dispose() {
    this.stop(0.25);
    setTimeout(() => {
      try {
        this.windSrc.stop(); this.riverSrc?.stop(); this.cricketSrc?.stop();
        this.out.disconnect();
      } catch (e) { /* already gone */ }
    }, 400);
  }
}

export default Ambience;
