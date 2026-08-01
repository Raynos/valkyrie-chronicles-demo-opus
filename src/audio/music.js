// src/audio/music.js — adaptive generative orchestral score.
//
// The target is Hitoshi Sakimoto's Valkyria Chronicles writing: neo-classical,
// string-led, waltz-adjacent in the reflective cues, minor-mode with dorian and
// lydian colour, woodwind counterpoint, restrained brass, and phrase structure
// you could actually notate.
//
// This is not a random-note generator. The pipeline per phrase is:
//
//   key/mode  ->  progression template (with modal mixture + real cadences)
//             ->  4-part voice-leading realisation (nearest-motion voicing)
//             ->  motif generation + motivic development (sequence, inversion,
//                 augmentation, cadential closure) for the melody
//             ->  derived contrary-motion counterpoint for the winds
//             ->  idiomatic bass / accompaniment / percussion patterns
//
// Scheduling is bar-at-a-time with a lookahead window, so state changes always
// land on a bar line and can be preceded by a fill.

import { makeRng, rngPick, rngInt } from '../core/rng.js';
import {
  monoBuf, noiseBurst, modalHit, softLimit, fadeEdges, allpassChain,
  renderIR, IR_PRESETS,
} from './sfx.js';

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const mod = (a, n) => ((a % n) + n) % n;

// --- theory tables ---------------------------------------------------------

const MODE = {
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  harmMin: [0, 2, 3, 5, 7, 8, 11],
  ionian: [0, 2, 4, 5, 7, 9, 11],
  lydian: [0, 2, 4, 6, 7, 9, 11],
};

const QUAL = {
  min: [0, 3, 7], maj: [0, 4, 7], dim: [0, 3, 6],
  min7: [0, 3, 7, 10], maj7: [0, 4, 7, 11], dom7: [0, 4, 7, 10],
  halfdim: [0, 3, 6, 10], minAdd9: [0, 3, 7, 14], maj9: [0, 4, 7, 11, 14],
  sus4: [0, 5, 7, 10], dom9: [0, 4, 7, 10, 14],
};

// Chord dictionary for a MINOR tonic. `r` = root offset in semitones.
// Includes the borrowed colour VC leans on: dorian IV, Neapolitan bII,
// bVI/bVII from natural minor against a harmonic-minor V.
const CH_MIN = {
  i: { r: 0, q: 'min' }, i9: { r: 0, q: 'minAdd9' }, i7: { r: 0, q: 'min7' },
  ii0: { r: 2, q: 'halfdim' }, ii7: { r: 2, q: 'min7' },
  III: { r: 3, q: 'maj' }, IIIM7: { r: 3, q: 'maj7' },
  iv: { r: 5, q: 'min' }, iv7: { r: 5, q: 'min7' }, IV: { r: 5, q: 'maj' },
  v7: { r: 7, q: 'min7' }, V: { r: 7, q: 'maj' }, V7: { r: 7, q: 'dom7' },
  Vsus: { r: 7, q: 'sus4' },
  bVI: { r: 8, q: 'maj' }, bVIM7: { r: 8, q: 'maj7' },
  bVII: { r: 10, q: 'maj' }, bVII7: { r: 10, q: 'dom7' },
  bII: { r: 1, q: 'maj' },
  viio: { r: 11, q: 'dim' }, sharpivo: { r: 6, q: 'dim' },
  I: { r: 0, q: 'maj' },                       // picardy third
};

const CH_MAJ = {
  I: { r: 0, q: 'maj' }, IM7: { r: 0, q: 'maj7' }, I9: { r: 0, q: 'maj9' },
  ii: { r: 2, q: 'min' }, ii7: { r: 2, q: 'min7' },
  iii: { r: 4, q: 'min' }, IV: { r: 5, q: 'maj' }, IVM7: { r: 5, q: 'maj7' },
  V: { r: 7, q: 'maj' }, V7: { r: 7, q: 'dom7' }, Vsus: { r: 7, q: 'sus4' },
  vi: { r: 9, q: 'min' }, bVII: { r: 10, q: 'maj' }, viio: { r: 11, q: 'dim' },
};

// 8-bar progression templates. Each state picks one per phrase; the last two
// bars always form a real cadence so phrases close instead of just stopping.
const PROGS = {
  contemplative: [
    ['i', 'bVII', 'bVI', 'V7', 'i', 'iv7', 'bII', 'V7'],
    ['i9', 'v7', 'bVIM7', 'IIIM7', 'iv7', 'bVII', 'i', 'V7'],
    ['i', 'IV', 'i', 'bVII', 'bVIM7', 'iv', 'Vsus', 'V7'],   // dorian IV colour
    ['i', 'III', 'iv7', 'bVII', 'bVIM7', 'ii0', 'V7', 'i'],
  ],
  driving: [
    ['i', 'i', 'bVI', 'bVII', 'i', 'i', 'iv', 'V7'],
    ['i', 'bVII', 'bVI', 'bVII', 'i', 'iv', 'V7', 'i'],
    ['i', 'v7', 'bVI', 'V7', 'i', 'bII', 'V7', 'i'],
    ['iv', 'bVII', 'III', 'bVI', 'ii0', 'V7', 'i', 'i'],
  ],
  tense: [
    ['i', 'i', 'bII', 'bII', 'i', 'i', 'sharpivo', 'V7'],
    ['i', 'viio', 'i', 'bII', 'iv', 'sharpivo', 'V7', 'V7'],
    ['i', 'i', 'i', 'i', 'bVI', 'bVI', 'V7', 'V7'],          // pedal tension
  ],
  triumphant: [
    ['I', 'V', 'vi', 'IV', 'I', 'V', 'IV', 'I'],
    ['I', 'IV', 'V', 'vi', 'IV', 'I', 'V', 'I'],
    ['I', 'bVII', 'IV', 'I', 'vi', 'ii7', 'V7', 'I'],
  ],
  elegiac: [
    ['i', 'iv', 'i', 'bVI', 'iv', 'bII', 'V7', 'i'],
    ['i', 'bVI', 'iv7', 'bII', 'i', 'iv', 'Vsus', 'i'],
  ],
};

/**
 * Per-state musical configuration. `layers` are the stem levels — intensity
 * cross-fades between `layers` and `layersHot`.
 */
const STATES = {
  menu: {
    bpm: 72, meter: 3, mode: 'aeolian', shift: 0, dict: CH_MIN, prog: 'contemplative',
    layers: { low: 0.55, strings: 0.8, winds: 0.42, brass: 0.0, harp: 0.6, perc: 0.0 },
    layersHot: { low: 0.6, strings: 0.85, winds: 0.5, brass: 0.06, harp: 0.6, perc: 0.0 },
    accomp: 'waltz', melody: 0.75, counter: 0.4, swellLen: 2.4,
  },
  command: {
    bpm: 78, meter: 3, mode: 'aeolian', shift: 0, dict: CH_MIN, prog: 'contemplative',
    layers: { low: 0.6, strings: 0.72, winds: 0.5, brass: 0.0, harp: 0.7, perc: 0.0 },
    layersHot: { low: 0.7, strings: 0.85, winds: 0.6, brass: 0.14, harp: 0.5, perc: 0.1 },
    accomp: 'waltz', melody: 0.66, counter: 0.5, swellLen: 2.2,
  },
  action: {
    bpm: 134, meter: 4, mode: 'aeolian', shift: 0, dict: CH_MIN, prog: 'driving',
    layers: { low: 0.85, strings: 0.78, winds: 0.34, brass: 0.34, harp: 0.12, perc: 0.5 },
    layersHot: { low: 0.95, strings: 0.9, winds: 0.42, brass: 0.7, harp: 0.0, perc: 0.9 },
    accomp: 'ostinato', melody: 0.9, counter: 0.45, swellLen: 1.0,
  },
  tension: {
    bpm: 116, meter: 4, mode: 'harmMin', shift: 0, dict: CH_MIN, prog: 'tense',
    layers: { low: 0.9, strings: 0.6, winds: 0.2, brass: 0.22, harp: 0.0, perc: 0.55 },
    layersHot: { low: 1.0, strings: 0.72, winds: 0.26, brass: 0.5, harp: 0.0, perc: 0.85 },
    accomp: 'tremolo', melody: 0.4, counter: 0.2, swellLen: 1.2,
  },
  victory: {
    bpm: 112, meter: 4, mode: 'ionian', shift: 3, dict: CH_MAJ, prog: 'triumphant',
    layers: { low: 0.8, strings: 0.9, winds: 0.55, brass: 0.8, harp: 0.4, perc: 0.6 },
    layersHot: { low: 0.85, strings: 0.95, winds: 0.6, brass: 0.9, harp: 0.4, perc: 0.75 },
    accomp: 'march', melody: 1.0, counter: 0.6, swellLen: 1.0,
  },
  defeat: {
    bpm: 52, meter: 3, mode: 'aeolian', shift: 0, dict: CH_MIN, prog: 'elegiac',
    layers: { low: 0.7, strings: 0.85, winds: 0.45, brass: 0.1, harp: 0.25, perc: 0.0 },
    layersHot: { low: 0.7, strings: 0.85, winds: 0.45, brass: 0.1, harp: 0.25, perc: 0.0 },
    accomp: 'sustain', melody: 0.7, counter: 0.45, swellLen: 3.4,
  },
};

// Scale-step offsets applied to the motif's home degree, bar by bar: the
// classic rise-through-the-antecedent / peak / fall-to-the-cadence arch.
const PHRASE_ARCH = [0, 1, 1, 2, 3, 2, 1, 0];

// Minimum bars in a cue before another state change is honoured.
const MIN_DWELL_BARS = 2;

// Rhythmic cells, in beats. Waltz cells emphasise the 1; duple cells push.
const CELLS_3 = [
  [1, 1, 1], [2, 1], [1.5, 0.5, 1], [1, 0.5, 0.5, 1], [1, 2], [0.5, 0.5, 1, 1], [2, 0.5, 0.5],
];
const CELLS_4 = [
  [1, 1, 1, 1], [2, 1, 1], [1, 1, 2], [0.5, 0.5, 1, 1, 1], [1.5, 0.5, 1, 1],
  [2, 2], [1, 0.5, 0.5, 2], [0.5, 0.5, 0.5, 0.5, 2],
];

// ---------------------------------------------------------------------------

export class MusicEngine {
  constructor(ctx, dest, opts = {}) {
    this.ctx = ctx;
    this.rng = makeRng((opts.seed ?? 12345) >>> 0);
    this.state = 'menu';
    this._pending = null;
    this._pendingOpts = null;
    this.intensity = 0;
    this._intensitySm = 0;
    this.running = false;
    this.lookahead = 0.55;

    this.tonicMidi = opts.tonicMidi ?? 57;   // A3 — key centre of the score

    this._bar = 0;
    this._barTime = 0;
    this._phrase = 0;
    this._prog = STATES.menu.prog;
    this._progRow = PROGS[this._prog][0];
    this._prevVoicing = [45, 57, 61, 64];
    this._motif = null;
    this._phraseNotes = null;
    this._fillNext = false;

    // --- output graph ------------------------------------------------------
    // Gentle top-end roll-off on everything: the saw/reed stacks read as
    // bowed strings and reeds rather than synths once the fizz above 7 kHz is
    // gone. Sits after the buses AND after the hall verb so both are shaped.
    this.airCut = ctx.createBiquadFilter();
    this.airCut.type = 'lowpass';
    this.airCut.frequency.value = 7400;
    this.airCut.Q.value = 0.5;
    this.airCut.connect(dest);

    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(this.airCut);

    this.buses = {};
    for (const k of ['low', 'strings', 'winds', 'brass', 'harp', 'perc']) {
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(this.out);
      this.buses[k] = g;
    }

    // Concert-hall send. The orchestra needs its own space, independent of the
    // battlefield reverb the SFX bus uses.
    this.verb = ctx.createConvolver();
    this.verb.normalize = true;
    const ir = renderIR(ctx.sampleRate, IR_PRESETS.hall);
    const irBuf = ctx.createBuffer(2, ir[0].length, ctx.sampleRate);
    irBuf.copyToChannel(ir[0], 0); irBuf.copyToChannel(ir[1], 1);
    this.verb.buffer = irBuf;
    this.verbGain = ctx.createGain();
    this.verbGain.gain.value = 0.34;
    this.verbOut = ctx.createGain();
    this.verbOut.gain.value = 0.9;
    this.verbGain.connect(this.verb);
    this.verb.connect(this.verbOut);
    this.verbOut.connect(this.airCut);
    for (const k of ['low', 'strings', 'winds', 'brass', 'harp']) {
      this.buses[k].connect(this.verbGain);
    }
    const percSend = ctx.createGain();
    percSend.gain.value = 0.45;
    this.buses.perc.connect(percSend);
    percSend.connect(this.verbGain);

    this._buildWaves();
    this._buildLfo();
    this._bakePerc();
    this._targetLayers = {};
  }

  // -------------------------------------------------------------------------
  // Timbre construction
  // -------------------------------------------------------------------------

  _buildWaves() {
    const ctx = this.ctx;
    const N = 40;
    const mk = (fn) => {
      const re = new Float32Array(N), im = new Float32Array(N);
      for (let n = 1; n < N; n++) im[n] = fn(n);
      return ctx.createPeriodicWave(re, im, { disableNormalization: false });
    };
    this.waves = {
      // Bowed string: strong odd/even mix, gentle 1/n^1.25 rolloff, small
      // formant bump near the body resonance region.
      string: mk((n) => (1 / Math.pow(n, 1.25)) * (1 + 0.35 * Math.exp(-Math.pow((n - 4) / 2.2, 2)))
        * Math.exp(-n / 26)),
      // Reed/woodwind: odd-dominant with a weak second partial.
      reed: mk((n) => (n % 2 ? 1 / Math.pow(n, 1.1) : 0.22 / Math.pow(n, 1.3)) * Math.exp(-n / 15)),
      // Brass: near-sawtooth, the timbre comes from the filter envelope.
      brass: mk((n) => (1 / n) * Math.exp(-n / 30)),
    };
  }

  _buildLfo() {
    const ctx = this.ctx;
    // Shared vibrato — one oscillator drives every sustaining voice's detune.
    this.vib = ctx.createOscillator();
    this.vib.type = 'sine';
    this.vib.frequency.value = 5.2;
    this.vibGain = ctx.createGain();
    this.vibGain.gain.value = 0;     // ramps in per note via the depth env
    this.vib.connect(this.vibGain);
    this.vib.start();

    // Shared breath/bow noise for winds — one source, per-note filters.
    const sr = ctx.sampleRate;
    const nb = ctx.createBuffer(1, Math.floor(sr * 2), sr);
    const d = nb.getChannelData(0);
    const r = makeRng(9091);
    let y = 0;
    for (let i = 0; i < d.length; i++) {
      const w = r() * 2 - 1;
      y = y * 0.72 + w * 0.28;      // slight pink tilt
      d[i] = y * 1.6;
    }
    this.noiseSrc = ctx.createBufferSource();
    this.noiseSrc.buffer = nb;
    this.noiseSrc.loop = true;
    this.noiseSrc.start();
  }

  /** Percussion, harp and pizzicato are baked once and pitch-shifted — far
   *  cheaper than a node graph per stroke, and physically modelled anyway. */
  _bakePerc() {
    const sr = this.ctx.sampleRate;
    const mk = (chan) => {
      const b = this.ctx.createBuffer(1, chan.length, sr);
      b.copyToChannel(chan, 0);
      return b;
    };
    const r1 = makeRng(4801);
    // Timpani at A2 (110 Hz): membrane modes are inharmonic (1, 1.5, 1.98…).
    const timp = monoBuf(sr, 2.2);
    modalHit(timp, sr, r1, {
      freqs: [110, 164, 218, 271, 330], t60s: [1.6, 1.0, 0.62, 0.4, 0.26],
      amps: [1, 0.45, 0.26, 0.15, 0.08], amp: 0.9, exciteDur: 0.008,
      exciteLp: 1300, dur: 2.1,
    });
    noiseBurst(timp, sr, r1, { dur: 0.035, amp: 0.24, type: 'lp', f0: 900, f1: 300, curve: 26 });
    softLimit(timp, 0.8); fadeEdges(timp, sr, 0.5, 30);

    // Snare: shell modes + wire buzz that outlasts the head.
    const sn = monoBuf(sr, 0.55);
    modalHit(sn, sr, r1, {
      freqs: [188, 246, 372], t60s: [0.09, 0.06, 0.04], amps: [1, 0.6, 0.3],
      amp: 0.5, exciteDur: 0.0025, exciteLp: 5000, dur: 0.22,
    });
    noiseBurst(sn, sr, r1, { dur: 0.16, amp: 0.7, type: 'hp', f0: 1400, curve: 17 });
    noiseBurst(sn, sr, r1, { dur: 0.3, amp: 0.22, type: 'bp', f0: 4200, q: 0.8, curve: 9 });
    softLimit(sn, 0.82); fadeEdges(sn, sr, 0.4, 14);

    // Suspended-cymbal swell for phrase arrivals.
    const cym = monoBuf(sr, 2.4);
    noiseBurst(cym, sr, r1, { dur: 2.2, amp: 0.5, type: 'hp', f0: 3200, curve: 1.6, attack: 0.55 });
    noiseBurst(cym, sr, r1, { dur: 2.0, amp: 0.26, type: 'bp', f0: 7200, q: 0.6, curve: 1.9, attack: 0.6 });
    modalHit(cym, sr, r1, {
      freqs: [1237, 1861, 2549, 3413, 4783, 6211], t60s: [1.6, 1.3, 1.0, 0.8, 0.6, 0.45],
      amps: [1, 0.8, 0.6, 0.45, 0.3, 0.2], amp: 0.25, exciteDur: 0.4,
      exciteLp: 9000, dur: 2.2,
    });
    allpassChain(cym, sr, [7.3, 12.1], 0.35);
    softLimit(cym, 0.8); fadeEdges(cym, sr, 3, 40);

    // Harp at A4 — long, bright, slightly inharmonic like real gut over wood.
    const harp = monoBuf(sr, 2.6);
    const hf = 440;
    modalHit(harp, sr, r1, {
      freqs: [hf, hf * 2.001, hf * 3.005, hf * 4.012, hf * 5.02, hf * 6.03, hf * 7.05],
      t60s: [2.2, 1.5, 1.0, 0.7, 0.5, 0.34, 0.22],
      amps: [1, 0.5, 0.32, 0.2, 0.13, 0.08, 0.05],
      amp: 0.85, exciteDur: 0.0016, exciteLp: 8000, dur: 2.5,
    });
    noiseBurst(harp, sr, r1, { dur: 0.012, amp: 0.16, type: 'hp', f0: 2600, curve: 44 });
    softLimit(harp, 0.85); fadeEdges(harp, sr, 0.4, 40);

    // Pizzicato at A3 — short, woody, with the finger-release click.
    const pizz = monoBuf(sr, 1.0);
    const pf = 220;
    modalHit(pizz, sr, r1, {
      freqs: [pf, pf * 2.002, pf * 3.008, pf * 4.02, pf * 5.04],
      t60s: [0.62, 0.4, 0.25, 0.16, 0.1], amps: [1, 0.6, 0.35, 0.2, 0.11],
      amp: 0.85, exciteDur: 0.0022, exciteLp: 4200, dur: 0.95,
    });
    noiseBurst(pizz, sr, r1, { dur: 0.014, amp: 0.2, type: 'bp', f0: 1800, q: 1.2, curve: 40 });
    softLimit(pizz, 0.85); fadeEdges(pizz, sr, 0.4, 25);

    this.pbuf = {
      timp: mk(timp), timpF: 110,
      snare: mk(sn),
      cym: mk(cym),
      harp: mk(harp), harpF: 440,
      pizz: mk(pizz), pizzF: 220,
    };
  }

  // -------------------------------------------------------------------------
  // Voices
  // -------------------------------------------------------------------------

  /** Bowed string: two detuned periodic-wave oscillators, slow bow attack, a
   *  filter that opens with the bow pressure, and delayed vibrato (players
   *  don't vibrate the very start of a note). */
  _string(midi, t, dur, vel, bus, opts = {}) {
    const ctx = this.ctx;
    const f = mtof(midi);
    if (f > 4000 || f < 30) return;
    const o1 = ctx.createOscillator(), o2 = ctx.createOscillator();
    o1.setPeriodicWave(this.waves.string); o2.setPeriodicWave(this.waves.string);
    o1.frequency.value = f; o2.frequency.value = f;
    o1.detune.value = -7 + this.rng() * 3;
    o2.detune.value = 6 + this.rng() * 3;
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.Q.value = 0.9;
    const g = ctx.createGain();
    g.gain.value = 0;
    o1.connect(filt); o2.connect(filt); filt.connect(g); g.connect(bus);

    const atk = opts.atk ?? (0.075 + 0.1 * (1 - vel));
    const rel = opts.rel ?? Math.min(0.55, 0.16 + dur * 0.25);
    const peak = vel * (opts.gain ?? 0.14);
    const sus = peak * 0.78;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + atk);
    g.gain.linearRampToValueAtTime(sus, t + Math.min(dur, atk + 0.28));
    g.gain.setTargetAtTime(0.0001, t + dur, rel * 0.34);

    const fc = Math.min(9000, f * (opts.bright ?? 6) + 380);
    filt.frequency.setValueAtTime(Math.min(9000, f * 2.2 + 240), t);
    filt.frequency.linearRampToValueAtTime(fc, t + atk * 1.6);
    filt.frequency.setTargetAtTime(Math.max(400, fc * 0.55), t + dur, 0.3);

    // Vibrato fades in after the attack, as a real player's does.
    const vg = ctx.createGain();
    vg.gain.setValueAtTime(0, t);
    vg.gain.linearRampToValueAtTime((opts.vib ?? 5.5) * vel, t + Math.min(dur * 0.6, atk + 0.3));
    vg.gain.setTargetAtTime(0, t + dur, 0.2);
    this.vib.connect(vg);
    vg.connect(o1.detune); vg.connect(o2.detune);

    const end = t + dur + rel + 0.3;
    o1.start(t); o2.start(t); o1.stop(end); o2.stop(end);
    o2.onended = () => {
      try {
        this.vib.disconnect(vg); vg.disconnect();
        o1.disconnect(); o2.disconnect(); filt.disconnect(); g.disconnect();
      } catch (e) { /* torn down */ }
    };
  }

  /** Woodwind: reed wave + breath noise through a formant-ish bandpass. */
  _wind(midi, t, dur, vel, opts = {}) {
    const ctx = this.ctx;
    const f = mtof(midi);
    if (f > 3000 || f < 90) return;
    const o = ctx.createOscillator();
    o.setPeriodicWave(this.waves.reed);
    o.frequency.value = f;
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.Q.value = 1.1;
    const g = ctx.createGain();
    g.gain.value = 0;
    o.connect(filt); filt.connect(g); g.connect(this.buses.winds);

    // Breath: bandpassed noise tracking the note, loudest during the attack.
    const bf = ctx.createBiquadFilter();
    bf.type = 'bandpass';
    bf.frequency.value = Math.min(9000, f * 4.5);
    bf.Q.value = 0.8;
    const bg = ctx.createGain();
    bg.gain.value = 0;
    this.noiseSrc.connect(bf); bf.connect(bg); bg.connect(this.buses.winds);

    const atk = opts.atk ?? 0.055;
    const rel = 0.13;
    const peak = vel * (opts.gain ?? 0.1);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + atk);
    g.gain.linearRampToValueAtTime(peak * 0.85, t + Math.min(dur, atk + 0.35));
    g.gain.setTargetAtTime(0.0001, t + dur, rel);
    bg.gain.setValueAtTime(0, t);
    bg.gain.linearRampToValueAtTime(vel * 0.02, t + atk * 0.6);
    bg.gain.linearRampToValueAtTime(vel * 0.006, t + atk + 0.14);
    bg.gain.setTargetAtTime(0, t + dur, rel);

    filt.frequency.setValueAtTime(f * 2.4 + 200, t);
    filt.frequency.linearRampToValueAtTime(Math.min(8000, f * 5 + 400), t + atk);
    filt.frequency.setTargetAtTime(f * 2 + 200, t + dur, 0.2);

    const vg = ctx.createGain();
    vg.gain.setValueAtTime(0, t);
    vg.gain.linearRampToValueAtTime(4 * vel, t + Math.min(dur * 0.7, 0.35));
    vg.gain.setTargetAtTime(0, t + dur, 0.2);
    this.vib.connect(vg); vg.connect(o.detune);

    const end = t + dur + rel * 4 + 0.2;
    o.start(t); o.stop(end);
    o.onended = () => {
      try {
        this.vib.disconnect(vg); vg.disconnect();
        this.noiseSrc.disconnect(bf);
        o.disconnect(); filt.disconnect(); g.disconnect(); bf.disconnect(); bg.disconnect();
      } catch (e) { /* torn down */ }
    };
  }

  /** Brass: saw through a bandpass whose centre tracks the attack — the
   *  rising "brassiness" of an increasing air column. */
  _brass(midi, t, dur, vel, opts = {}) {
    const ctx = this.ctx;
    const f = mtof(midi);
    if (f > 1400 || f < 55) return;
    const o = ctx.createOscillator();
    o.setPeriodicWave(this.waves.brass);
    o.frequency.value = f;
    // Slight pitch scoop into the note — how a horn actually starts.
    o.detune.setValueAtTime(-28, t);
    o.detune.linearRampToValueAtTime(0, t + 0.05);
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.Q.value = 3.2;
    const g = ctx.createGain();
    g.gain.value = 0;
    o.connect(filt); filt.connect(g); g.connect(this.buses.brass);

    const atk = opts.atk ?? 0.045;
    const peak = vel * (opts.gain ?? 0.1);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + atk);
    g.gain.linearRampToValueAtTime(peak * 0.8, t + Math.min(dur, atk + 0.25));
    g.gain.setTargetAtTime(0.0001, t + dur, 0.1);

    filt.frequency.setValueAtTime(f * 1.5 + 120, t);
    filt.frequency.linearRampToValueAtTime(Math.min(6000, f * (3 + 5 * vel) + 300), t + atk);
    filt.frequency.setTargetAtTime(f * 1.8 + 150, t + atk + 0.1, 0.25);
    filt.frequency.setTargetAtTime(f * 1.2 + 100, t + dur, 0.15);

    const end = t + dur + 0.5;
    o.start(t); o.stop(end);
    o.onended = () => {
      try { o.disconnect(); filt.disconnect(); g.disconnect(); } catch (e) { /* torn down */ }
    };
  }

  _sample(buf, refF, targetF, t, vel, bus, dur) {
    const ctx = this.ctx;
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.playbackRate.value = refF ? targetF / refF : 1;
    const g = ctx.createGain();
    g.gain.value = vel;
    s.connect(g); g.connect(bus);
    s.start(t);
    if (dur) {
      g.gain.setValueAtTime(vel, t + dur);
      g.gain.setTargetAtTime(0.0001, t + dur, 0.06);
      s.stop(t + dur + 0.4);
    }
    s.onended = () => { try { s.disconnect(); g.disconnect(); } catch (e) { /* torn down */ } };
    return s;
  }

  _harp(midi, t, vel) {
    this._sample(this.pbuf.harp, this.pbuf.harpF, mtof(midi), t, vel * 0.34, this.buses.harp);
  }
  _pizz(midi, t, vel, bus) {
    this._sample(this.pbuf.pizz, this.pbuf.pizzF, mtof(midi), t, vel * 0.3, bus || this.buses.low);
  }
  _timp(midi, t, vel) {
    this._sample(this.pbuf.timp, this.pbuf.timpF, mtof(midi), t, vel * 0.5, this.buses.perc);
  }
  _snare(t, vel, rate = 1) {
    this._sample(this.pbuf.snare, 1, rate, t, vel * 0.4, this.buses.perc);
  }
  _cym(t, vel) {
    this._sample(this.pbuf.cym, 1, 1, t, vel * 0.28, this.buses.perc);
  }

  // -------------------------------------------------------------------------
  // Theory helpers
  // -------------------------------------------------------------------------

  get cfg() { return STATES[this.state] || STATES.command; }
  get scale() { return MODE[this.cfg.mode]; }
  get tonic() { return this.tonicMidi + this.cfg.shift; }

  /** Absolute midi for a scale degree (degree may be < 0 or > 6). */
  degMidi(deg, octave = 0) {
    const s = this.scale;
    return this.tonic + 12 * (Math.floor(deg / 7) + octave) + s[mod(deg, 7)];
  }

  degPc(deg) { return mod(this.tonic + this.scale[mod(deg, 7)], 12); }

  chordPcs(name) {
    const dict = this.cfg.dict;
    const c = dict[name] || dict.i || dict.I;
    const root = mod(this.tonic + c.r, 12);
    const iv = QUAL[c.q] || QUAL.min;
    const pcs = [];
    for (let i = 0; i < iv.length; i++) pcs.push(mod(root + iv[i], 12));
    return { root, pcs, quality: c.q, rootAbs: this.tonic + c.r };
  }

  /** Nearest pitch with pitch-class `pc` to `target`, clamped to [lo,hi]. */
  static near(pc, target, lo, hi) {
    let p = target + mod(pc - target, 12);
    if (p - target > 6) p -= 12;
    while (p < lo) p += 12;
    while (p > hi) p -= 12;
    return p;
  }

  /** 4-part realisation with nearest-motion voice leading. Bass takes the
   *  chord root; upper voices each move to the closest available chord tone,
   *  penalising repeats and unisons so the texture stays open. */
  voiceChord(ch, prev) {
    const near = MusicEngine.near;
    const out = [near(ch.root, prev[0], 33, 52)];
    const used = new Set();
    for (let i = 1; i < 4; i++) {
      let best = null, bestCost = Infinity, bestPc = -1;
      for (const pc of ch.pcs) {
        const cand = near(pc, prev[i], 50, 76);
        let cost = Math.abs(cand - prev[i]);
        if (used.has(pc)) cost += 7;
        if (i > 1 && cand === out[i - 1]) cost += 9;
        if (cand < out[i - 1]) cost += 4;             // discourage crossing
        if (cost < bestCost) { bestCost = cost; best = cand; bestPc = pc; }
      }
      used.add(bestPc);
      out.push(best);
    }
    out.sort((a, b) => a - b);
    return out;
  }

  /** Snap a scale degree to the nearest chord tone (searching outward). */
  snapChord(deg, ch) {
    const set = new Set(ch.pcs);
    for (const off of [0, 1, -1, 2, -2, 3, -3, 4, -4]) {
      if (set.has(this.degPc(deg + off))) return deg + off;
    }
    return deg;
  }

  // -------------------------------------------------------------------------
  // Motif + phrase generation
  // -------------------------------------------------------------------------

  _newMotif() {
    const rng = this.rng;
    const meter = this.cfg.meter;
    const cells = meter === 3 ? CELLS_3 : CELLS_4;
    let rhythm = rngPick(rng, cells).slice();
    // A one-note bar has no contour to develop; re-draw until the cell can
    // actually carry a motif.
    let tries = 0;
    while (rhythm.length < 2 && tries++ < 6) rhythm = rngPick(rng, cells).slice();
    // Contour: mostly steps, one characteristic leap. That single interval is
    // what stays recognisable through every later transformation. There is one
    // step per note (the last one carries the line into the next bar).
    const steps = [];
    const leapAt = rngInt(rng, 0, Math.max(0, rhythm.length - 2));
    for (let i = 0; i < rhythm.length; i++) {
      if (i === leapAt) steps.push(rngPick(rng, [3, 4, -3, 2, 5, -4]));
      else steps.push(rngPick(rng, [1, -1, 1, -1, 2, -2, 0]));
    }
    // Force a non-zero net motion. A cell whose steps cancel out turns into a
    // trill when it repeats inside a bar; with net motion the repeat becomes a
    // sequence instead, which is what the ear wants to hear.
    let net = 0;
    for (const st of steps) net += st;
    if (net === 0) steps[steps.length - 1] += rngPick(rng, [1, 2, -1, -2]);
    return { rhythm, steps, start: rngPick(rng, [0, 2, 4, 4, 2]) };
  }

  /** Apply a development operation and return a new motif. */
  _develop(m, op) {
    const r = { rhythm: m.rhythm.slice(), steps: m.steps.slice(), start: m.start };
    if (op === 'sequence') r.start = m.start + rngPick(this.rng, [1, 2, -1, -2]);
    else if (op === 'invert') r.steps = m.steps.map((s) => -s);
    else if (op === 'augment') {
      r.rhythm = m.rhythm.map((d) => d * 1.5);
      r.steps = m.steps.slice(0, Math.max(1, m.steps.length - 1));
    } else if (op === 'diminish') {
      // Halved values — the cell then states itself twice inside the bar,
      // which is what diminution sounds like in practice.
      r.rhythm = m.rhythm.map((d) => Math.max(0.5, d * 0.5));
      r.steps = m.steps.slice();
    } else if (op === 'ornament') {
      // Split the longest note into a neighbour-tone figure.
      let li = 0;
      for (let i = 1; i < r.rhythm.length; i++) if (r.rhythm[i] > r.rhythm[li]) li = i;
      if (r.rhythm[li] >= 1) {
        const d = r.rhythm[li];
        r.rhythm.splice(li, 1, d - 0.5, 0.5);
        r.steps.splice(li, 0, rngPick(this.rng, [1, -1]));
        if (r.steps.length > li + 1) r.steps[li + 1] = -r.steps[li];
      }
    }
    return r;
  }

  /**
   * Build one 8-bar phrase of melody as [{bar, beat, dur, deg, vel}].
   * Structure is antecedent (bars 0-3) / consequent (bars 4-7): the
   * consequent restates the motif material and closes with a cadence figure.
   */
  _buildPhrase(progRow) {
    const rng = this.rng;
    const meter = this.cfg.meter;
    if (!this._motif || rng() < 0.28) this._motif = this._newMotif();
    const base = this._motif;
    const plan = [
      base,
      this._develop(base, 'ornament'),
      this._develop(base, 'sequence'),
      this._develop(base, rngPick(rng, ['invert', 'diminish', 'sequence'])),
      base,
      this._develop(base, 'sequence'),
      this._develop(base, rngPick(rng, ['augment', 'ornament'])),
      null,                                    // bar 7 is the cadence
    ];

    const notes = [];
    let deg = base.start;
    for (let bar = 0; bar < 8; bar++) {
      const ch = this.chordPcs(progRow[bar]);
      if (bar === 7) {
        // Cadential closure: step down onto the tonic (or the third above it
        // for a softer, non-final ending) and hold it.
        // Land on a tone of the final chord (so a V7 cadence doesn't hold a
        // dissonance for two beats) and approach it as a descending 2-1.
        const target = this.snapChord(rng() < 0.65 ? 0 : 2, ch);
        const approach = target + 1;
        notes.push({ bar, beat: 0, dur: 1, deg: approach, vel: 0.6 });
        notes.push({ bar, beat: 1, dur: meter - 1, deg: target, vel: 0.72 });
        deg = target;
        continue;
      }
      const m = plan[bar];
      // Phrase arch: the line climbs through the antecedent, peaks at the
      // start of the consequent and falls to the cadence. Blending the running
      // degree halfway toward the arch target keeps motivic continuity while
      // still giving the phrase an overall shape.
      let target = base.start + PHRASE_ARCH[bar];
      // Never jump more than a 5th across a bar line — the arch shapes the
      // phrase, it doesn't get to break the line.
      target = Math.max(deg - 4, Math.min(deg + 4, target));
      deg = this.snapChord(Math.round((deg + target) * 0.5), ch);

      let beat = 0, i = 0, guard = 0, recover = 0;
      while (beat < meter - 1e-6 && guard++ < 10) {
        const ri = i % m.rhythm.length;
        const d = Math.min(m.rhythm[ri], meter - beat);
        const strong = beat === 0 || (meter === 4 && beat === 2);
        let dd = deg;
        if (strong) dd = this.snapChord(dd, ch);
        // Keep the tessitura singable — roughly a violin-section octave and
        // a half around the tonic.
        if (dd > 9) dd -= 7; else if (dd < -2) dd += 7;
        notes.push({
          bar, beat, dur: d * (rng() < 0.15 ? 0.92 : 1), deg: dd,
          vel: (strong ? 0.85 : 0.62) + rng() * 0.1,
        });
        // Leap recovery: a big interval is answered by a step the other way.
        let step = m.steps[ri] ?? 0;
        if (recover) { step = recover; recover = 0; }
        else if (Math.abs(step) >= 3) recover = -Math.sign(step);
        deg = dd + step;
        beat += d;
        i++;
      }
    }
    return notes;
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  start() {
    if (this.running) return;
    this.running = true;
    const now = this.ctx.currentTime;
    this._barTime = now + 0.12;
    this._bar = 0;
    this._phrase = 0;
    this._newPhrase();
    this._applyLayers(1.2);
    this.out.gain.cancelScheduledValues(now);
    this.out.gain.setValueAtTime(0.0001, now);
    this.out.gain.linearRampToValueAtTime(1, now + 1.6);
  }

  stop(fade = 1.5) {
    if (!this.running) return;
    this.running = false;
    const now = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(now);
    this.out.gain.setValueAtTime(this.out.gain.value, now);
    this.out.gain.linearRampToValueAtTime(0.0001, now + fade);
  }

  /** Musical state change: always lands on a bar line, always preceded by a
   *  fill if there is a bar left to put one in. */
  setState(s, opts = {}) {
    if (!STATES[s]) return;
    if (!this.running || opts.immediate) {
      this.state = s;
      this._pending = null;
      this._newPhrase();
      this._applyLayers(opts.fade ?? 1.0);
      return;
    }
    if (s === this.state && !this._pending) return;
    if (s === this.state) { this._pending = null; return; }   // cancels a pending switch
    this._pending = s;
    this._pendingOpts = opts;
  }

  setIntensity(x) { this.intensity = Math.max(0, Math.min(1, x)); }

  _applyLayers(fade = 1.2) {
    const c = this.cfg;
    const k = this._intensitySm;
    const now = this.ctx.currentTime;
    const tc = Math.max(0.05, fade * 0.35);
    for (const key of Object.keys(this.buses)) {
      const a = c.layers[key] ?? 0, b = c.layersHot[key] ?? a;
      const v = a + (b - a) * k;
      this._targetLayers[key] = v;
      this.buses[key].gain.setTargetAtTime(v, now, tc);
    }
  }

  _newPhrase() {
    const rows = PROGS[this.cfg.prog];
    let row = rngPick(this.rng, rows);
    if (rows.length > 1 && row === this._progRow) row = rngPick(this.rng, rows);
    this._progRow = row;
    this._phraseNotes = this._buildPhrase(this._progRow);
    this._prevVoicing = this._prevVoicing || [45, 57, 61, 64];
  }

  update(dt = 1 / 60) {
    if (!this.running) return;
    const now = this.ctx.currentTime;
    // WALL-CLOCK GAP RECOVERY. update() is driven by the render loop, which the
    // pause menu stops while the AudioContext keeps running — so the transport
    // comes back sitting in the PAST. A normal frame leaves `_barTime` at least
    // `lookahead` ahead of now, so anything behind now is lost time, and
    // scheduling those bars would start every one of them at `t <= now`, i.e.
    // dump a whole minute of orchestra into a single instant.
    if (this._barTime < now) this._barTime = now + 0.05;
    // Smooth the intensity so layer cross-fades never step.
    if (Math.abs(this.intensity - this._intensitySm) > 0.004) {
      this._intensitySm += (this.intensity - this._intensitySm) * (1 - Math.exp(-2.2 * dt));
      this._applyLayers(1.6);
    }
    let guard = 8;
    while (this._barTime < now + this.lookahead && guard-- > 0) {
      const barDur = this.cfg.meter * 60 / this.cfg.bpm;
      // A state change is honoured only after a minimum dwell of two bars, so
      // a rapidly flickering game state can't shred the music. The bar before
      // the switch carries a fill.
      this._fillNext = !!(this._pending && this._bar >= MIN_DWELL_BARS);
      this._scheduleBar(this._barTime, barDur);
      this._barTime += barDur;
      this._bar++;
      if (this._fillNext) {
        this.state = this._pending;
        this._pending = null;
        this._fillNext = false;
        this._bar = 0;
        this._phrase++;
        this._newPhrase();
        this._applyLayers(this._pendingOpts?.fade ?? 1.4);
      } else if (this._bar % 8 === 0) {
        this._phrase++;
        this._newPhrase();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Bar rendering
  // -------------------------------------------------------------------------

  _scheduleBar(t0, barDur) {
    const c = this.cfg;
    const beat = 60 / c.bpm;
    const bar = mod(this._bar, 8);
    const ch = this.chordPcs(this._progRow[bar]);
    const nextCh = this.chordPcs(this._progRow[(bar + 1) % 8]);
    const voicing = this.voiceChord(ch, this._prevVoicing);
    this._prevVoicing = voicing;
    const k = this._intensitySm;
    const phraseStart = bar === 0;
    const phraseEnd = bar === 7;

    this._bass(t0, beat, barDur, ch, nextCh, c, k);
    this._accomp(t0, beat, barDur, ch, voicing, c, k);
    this._melody(t0, beat, bar, c, k);
    this._counter(t0, beat, bar, ch, c, k);
    this._percussion(t0, beat, barDur, c, k, bar);

    if ((c.layers.brass > 0.05 || k > 0.35) && (c.accomp === 'march' || c.accomp === 'ostinato')) {
      this._brassPart(t0, beat, barDur, ch, voicing, c, k, bar);
    }
    if (c.layers.harp > 0.05 && (phraseStart || (bar === 4 && this.rng() < 0.6))) {
      this._harpFlourish(t0, beat, ch);
    }
    if (phraseEnd && (k > 0.3 || c.layers.perc > 0.3)) {
      this._cym(t0 + barDur - beat * 2.2, 0.5 + k * 0.4);
    }
    if (this._fillNext) this._fill(t0, beat, barDur, c);
  }

  _bass(t0, beat, barDur, ch, nextCh, c, k) {
    const bus = this.buses.low;
    const rootLo = MusicEngine.near(ch.root, 40, 33, 50);
    if (c.accomp === 'waltz' || c.accomp === 'sustain') {
      // Cello/bass sustains the root under the whole bar.
      this._string(rootLo, t0, barDur * 0.94, 0.72, bus, { gain: 0.15, bright: 3.4, atk: 0.12 });
      if (c.accomp === 'waltz' && this.rng() < 0.4) {
        this._pizz(rootLo + 7, t0 + beat * 2, 0.5, bus);
      }
    } else if (c.accomp === 'ostinato') {
      // Driving eighths on root/fifth with a chromatic approach into the next
      // chord — the engine of the battle cues.
      const fifth = MusicEngine.near(mod(ch.root + 7, 12), rootLo + 5, 34, 54);
      const pat = [rootLo, rootLo, fifth, rootLo, rootLo, fifth, rootLo, rootLo];
      const n = c.meter * 2;
      for (let i = 0; i < n; i++) {
        const t = t0 + i * beat * 0.5;
        const last = i === n - 1;
        let p = pat[i % pat.length];
        if (last) {
          const nr = MusicEngine.near(nextCh.root, rootLo, 33, 50);
          p = nr + (nr > rootLo ? -1 : 1);       // leading-tone approach
        }
        this._string(p, t, beat * 0.46, 0.65 + (i % 2 ? 0 : 0.2) + k * 0.12, bus,
          { gain: 0.13, bright: 3.0, atk: 0.012, rel: 0.08 });
      }
      this._string(rootLo - 12, t0, barDur * 0.96, 0.5, bus, { gain: 0.1, bright: 2.2, atk: 0.09 });
    } else if (c.accomp === 'tremolo') {
      // Low tremolo pedal — unstable, waiting.
      const n = c.meter * 4;
      for (let i = 0; i < n; i++) {
        this._string(rootLo, t0 + i * beat * 0.25, beat * 0.22,
          0.4 + (i % 4 === 0 ? 0.28 : 0) + k * 0.16, bus,
          { gain: 0.1, bright: 2.6, atk: 0.008, rel: 0.05 });
      }
    } else if (c.accomp === 'march') {
      for (let i = 0; i < c.meter; i++) {
        const p = i % 2 === 0 ? rootLo : MusicEngine.near(mod(ch.root + 7, 12), rootLo + 5, 34, 54);
        this._string(p, t0 + i * beat, beat * 0.8, 0.8, bus,
          { gain: 0.15, bright: 3.2, atk: 0.02 });
      }
    }
  }

  _accomp(t0, beat, barDur, ch, voicing, c, k) {
    const bus = this.buses.strings;
    const upper = voicing.slice(1);
    if (c.accomp === 'waltz') {
      // Classic oom-pah-pah: bass already took the "oom"; inner strings answer
      // on beats 2 and 3, short and light.
      for (let b = 1; b < c.meter; b++) {
        for (let vi = 0; vi < upper.length; vi++) {
          this._string(upper[vi], t0 + b * beat + vi * 0.004, beat * 0.62,
            0.42 + (b === 1 ? 0.08 : 0), bus,
            { gain: 0.075, bright: 4.2, atk: 0.035, rel: 0.12 });
        }
      }
    } else if (c.accomp === 'sustain') {
      // swellLen sets how slowly the section bows in — the elegiac cue takes
      // nearly a second to arrive, the battle cues barely a tenth.
      const atk = Math.min(0.75, c.swellLen * 0.13);
      for (let vi = 0; vi < upper.length; vi++) {
        this._string(upper[vi], t0 + vi * 0.012, barDur * 0.96, 0.5, bus,
          { gain: 0.075, bright: 3.6, atk, rel: 0.5, vib: 6 });
      }
    } else if (c.accomp === 'ostinato' || c.accomp === 'march') {
      // Off-beat stabs, plus a quiet pad holding the harmony together.
      const n = c.meter;
      for (let b = 0; b < n; b++) {
        const off = c.accomp === 'ostinato' ? 0.5 : 0;
        if (c.accomp === 'ostinato' && b % 2 === 1) continue;
        for (let vi = 0; vi < upper.length; vi++) {
          this._string(upper[vi], t0 + (b + off) * beat + vi * 0.003, beat * 0.42,
            0.5 + k * 0.2, bus, { gain: 0.07, bright: 4.6, atk: 0.018, rel: 0.1 });
        }
      }
      const padAtk = Math.min(0.6, c.swellLen * 0.3);
      for (let vi = 0; vi < upper.length; vi++) {
        this._string(upper[vi] + 12, t0, barDur * 0.98, 0.3 + k * 0.12, bus,
          { gain: 0.032, bright: 3.0, atk: padAtk, rel: 0.5 });
      }
    } else if (c.accomp === 'tremolo') {
      const n = c.meter * 4;
      for (let i = 0; i < n; i++) {
        const vi = i % upper.length;
        this._string(upper[vi], t0 + i * beat * 0.25, beat * 0.2, 0.34 + k * 0.2, bus,
          { gain: 0.05, bright: 4.0, atk: 0.006, rel: 0.05 });
      }
    }
  }

  _melody(t0, beat, bar, c, k) {
    const notes = this._phraseNotes;
    if (!notes) return;
    const dens = c.melody + k * 0.1;
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      if (n.bar !== bar) continue;
      if (dens < 1 && n.vel < 0.7 && this.rng() > dens) continue;
      const midi = this.degMidi(n.deg, 1);
      const t = t0 + n.beat * beat;
      const d = n.dur * beat;
      this._string(midi, t, d, n.vel, this.buses.strings,
        { gain: 0.2, bright: 7, atk: c.accomp === 'ostinato' ? 0.03 : 0.07, vib: 7 });
      // Octave doubling by winds on the strong notes gives the VC "sunlit"
      // colour without a second full line.
      if (n.vel > 0.78 && c.layers.winds > 0.25 && this.rng() < 0.5) {
        this._wind(midi, t + 0.008, d, n.vel * 0.8, { gain: 0.08 });
      }
      if (c.accomp === 'march' && n.vel > 0.8) {
        this._brass(midi - 12, t, d * 0.9, n.vel * 0.85, { gain: 0.085 });
      }
    }
  }

  /** Woodwind counterpoint: contrary motion against the melody, entering on
   *  weak beats and moving at roughly half the melodic density. */
  _counter(t0, beat, bar, ch, c, k) {
    if (c.counter <= 0.05) return;
    const notes = this._phraseNotes;
    if (!notes) return;
    const axis = 4;
    let taken = 0;
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      if (n.bar !== bar) continue;
      taken++;
      // Two-thirds density and never on the same attack as the melody, so the
      // wind line reads as an answering voice rather than a doubling.
      if (taken % 3 === 0) continue;
      if (this.rng() > c.counter + k * 0.15) continue;
      const mirrored = this.snapChord(2 * axis - n.deg, ch);
      const midi = this.degMidi(mirrored, 0);
      const t = t0 + (n.beat + 0.5) * beat;
      if (n.beat + 0.5 >= c.meter) continue;
      const d = Math.min(n.dur, c.meter - n.beat - 0.5) * beat * 0.9;
      if (d < beat * 0.2) continue;
      this._wind(midi, t, d, 0.55 + n.vel * 0.2, { gain: 0.075 });
    }
  }

  _brassPart(t0, beat, barDur, ch, voicing, c, k, bar) {
    const level = 0.55 + k * 0.4;
    if (c.accomp === 'march') {
      for (const p of [voicing[0] + 12, voicing[2]]) {
        this._brass(p, t0, beat * 1.8, level, { gain: 0.1 });
      }
      if (bar % 2 === 1) this._brass(voicing[3], t0 + beat * 2, beat * 1.6, level * 0.8, { gain: 0.09 });
    } else {
      // Battle cue: weight on 1, answer on the "and" of 3.
      this._brass(voicing[0] + 12, t0, beat * 0.9, level, { gain: 0.095 });
      if (k > 0.4) this._brass(voicing[2], t0 + beat * 2.5, beat * 0.7, level * 0.8, { gain: 0.08 });
    }
  }

  _harpFlourish(t0, beat, ch) {
    // Rolled chord upward through the chord tones, harp-style.
    const n = 5 + rngInt(this.rng, 0, 2);
    let p = MusicEngine.near(ch.root, 55, 50, 62);
    for (let i = 0; i < n; i++) {
      this._harp(p, t0 + i * 0.045, 0.55 - i * 0.04);
      const pc = ch.pcs[(i + 1) % ch.pcs.length];
      p = MusicEngine.near(pc, p + 3, p + 1, p + 9);
    }
  }

  _percussion(t0, beat, barDur, c, k, bar) {
    if (c.layers.perc < 0.05 && k < 0.2) return;
    const lvl = 0.5 + k * 0.5;
    if (c.accomp === 'ostinato') {
      this._timp(this.tonic - 12, t0, 0.85 * lvl);
      if (c.meter === 4) this._timp(this.tonic - 12, t0 + beat * 2, 0.5 * lvl);
      this._snare(t0 + beat, 0.5 * lvl, 1.0);
      this._snare(t0 + beat * 3, 0.55 * lvl, 0.98);
      if (k > 0.5 && this.rng() < 0.4) {
        for (let i = 0; i < 4; i++) {
          this._snare(t0 + beat * 3.5 + i * beat * 0.125, 0.24 * lvl, 1.05 + i * 0.02);
        }
      }
    } else if (c.accomp === 'march') {
      this._timp(this.tonic - 12, t0, 0.9 * lvl);
      for (let i = 0; i < c.meter; i++) {
        this._snare(t0 + i * beat, i === 0 ? 0.6 * lvl : 0.4 * lvl, 1);
        this._snare(t0 + (i + 0.5) * beat, 0.22 * lvl, 1.04);
      }
    } else if (c.accomp === 'tremolo') {
      // Timpani roll: accelerating strokes, the "something is coming" bed.
      const n = 12 + Math.floor(k * 12);
      for (let i = 0; i < n; i++) {
        const f = i / n;
        this._timp(this.tonic - 12, t0 + f * barDur, (0.1 + f * 0.3) * lvl);
      }
      if (bar % 4 === 3) this._snare(t0 + barDur - beat * 0.5, 0.45 * lvl, 1.1);
    }
  }

  /** Transition fill — a short percussion/harp gesture that covers the seam
   *  between two states so the change reads as composed, not switched. */
  _fill(t0, beat, barDur, c) {
    const t = t0 + barDur - beat * (c.meter === 3 ? 1 : 2);
    const n = c.meter === 3 ? 3 : 4;
    for (let i = 0; i < n; i++) {
      const f = i / n;
      this._snare(t + f * beat * (n === 3 ? 1 : 2), 0.3 + f * 0.4, 1 + f * 0.06);
    }
    this._timp(this.tonic - 12, t0 + barDur - beat * 0.25, 0.7);
    this._cym(t0 + barDur - beat * 0.1, 0.6);
  }

  dispose() {
    this.stop(0.2);
    setTimeout(() => {
      try {
        this.vib.stop(); this.noiseSrc.stop();
        this.out.disconnect(); this.verbOut.disconnect();
      } catch (e) { /* already gone */ }
    }, 400);
  }
}

export default MusicEngine;
