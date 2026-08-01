// src/audio/engine.js — the audio front end.
//
// Master chain (per docs/ARCHITECTURE.md):
//
//   sfx voices ─┬─> dryIn ─────────────────────────┐
//   ui voices ──┤                                  │
//   music ──────┤                            master(gain) -> compressor
//   ambience ───┘                                        │
//                                                        ├─> dry -> limiter
//   per-voice sends -> verbIn -> [convolver A|B] -> wet ──┘        │
//                                                                  v
//                                                            destination
//
// Two procedurally-rendered impulse responses ("outdoor valley" / "inside
// ruin") sit on the wet leg and cross-fade via setSpace(). Every spatial voice
// carries its own send level and its own air-absorption lowpass, so distance
// makes a sound quieter, darker *and* wetter — the three cues the ear actually
// uses to judge range outdoors.

import { Bus } from '../core/bus.js';
import { CFG, byQ } from '../core/config.js';
import {
  SFX_DEFS, SFX_ALIASES, MATERIAL_IMPACT, WEAPON_SFX, resolveSfxName, renderSfx,
  renderIR, IR_PRESETS, renderEngineLoop, renderTrackLoop, TankEngineVoice,
  isFootSfx,
} from './sfx.js';
import { MusicEngine } from './music.js';
import { Ambience } from './ambience.js';

// Module-scope scratch — update() runs every frame and must not allocate.
const _lp = { x: 0, y: 0, z: 0 };     // listener position
const _lf = { x: 0, y: 0, z: -1 };    // listener forward
const _lu = { x: 0, y: 1, z: 0 };     // listener up
const _prevLp = { x: 0, y: 0, z: 0 };

const EMPTY = {};

// battle.js PHASES = ['briefing','deploy','command','action','enemy','result'].
// Every one of them needs a cue: 'menu' is the contemplative waltz the briefing
// wants, and laying out a deployment is the same head-space as command mode.
// ('result' is listed for completeness but mission:end picks victory/defeat.)
const MUSIC_FOR_PHASE = {
  briefing: 'menu', deploy: 'command',
  command: 'command', action: 'action', enemy: 'action', result: 'victory',
};

// Duplicate suppression. Several subsystems legitimately describe one physical
// event twice — the canonical Bus event *and* an explicit `sfx` — so the same
// buffer arrives twice in a frame. Two copies of a one-shot a few ms apart at
// the same spot is not two events; it is one event 6 dB hot and comb-filtered.
const DEDUPE_WINDOW = 0.05;   // seconds
const DEDUPE_DIST2 = 4;       // metres², i.e. 2 m apart still counts as "here"

// The blast reports the `explosion` Bus handler is authoritative for. An
// explicit `sfx` naming one of these in the same frame is the same detonation
// described a second time, so it yields to the derived (radius-aware) play.
const BLAST_KEYS = ['explosion', 'explosionBig', 'explosionDistant'];

// Bus levels under the pause-menu duck, as a fraction of their normal setting.
// Music stays audible on purpose: the menu's Music row has to be auditionable.
const DUCK = { music: 0.18, ambience: 0, dry: 0 };

/**
 * One playback slot. Node chain is built once and reused; only the
 * AudioBufferSourceNode (which is single-use by spec) is created per trigger.
 */
class Voice {
  constructor(ae, spatial, hrtf) {
    const ctx = ae.ctx;
    this.ae = ae;
    this.spatial = spatial;
    this.active = false;
    this.looping = false;
    this.pri = 0;
    this.startedAt = 0;
    this.vol = 1;
    this.src = null;
    this.def = null;

    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.Q.value = 0.35;
    this.filter.frequency.value = 20000;

    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.filter.connect(this.gain);

    this.send = ctx.createGain();
    this.send.gain.value = 0;
    this.send.connect(ae.verbIn);

    if (spatial) {
      this.panner = ctx.createPanner();
      this.panner.panningModel = hrtf ? 'HRTF' : 'equalpower';
      this.panner.distanceModel = 'inverse';
      this.panner.refDistance = 8;
      this.panner.rolloffFactor = 1;
      this.panner.maxDistance = 500;
      this.panner.coneInnerAngle = 360;
      this.gain.connect(this.panner);
      this.panner.connect(ae.dryIn);
      this.panner.connect(this.send);
    } else {
      this.panner = null;
      this.gain.connect(ae.uiIn);
      this.gain.connect(this.send);
    }

    // Bound once so triggering a sound allocates no closure.
    this._onEnded = () => this._release();
  }

  _release() {
    if (this.src) {
      try { this.src.disconnect(); } catch (e) { /* already torn down */ }
      this.src.onended = null;
      this.src = null;
    }
    this.active = false;
    this.looping = false;
    this.gain.gain.cancelScheduledValues(this.ae.ctx.currentTime);
    this.gain.gain.value = 0;
    this.ae._free(this);
  }

  start(buffer, def, opts, when) {
    const ctx = this.ae.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const pv = def.pv || 0;
    const jitter = pv ? 1 + (Math.random() * 2 - 1) * pv : 1;
    src.playbackRate.value = (opts.pitch || 1) * jitter;
    if (opts.detune && src.detune) src.detune.value = opts.detune;
    src.loop = !!opts.loop;
    src.connect(this.filter);
    if (!opts.loop) src.onended = this._onEnded;
    this.src = src;
    this.def = def;
    this.active = true;
    this.looping = !!opts.loop;
    this.pri = def.pri ?? 1;
    this.startedAt = when;
    this.vol = (opts.vol ?? 1) * (def.gain ?? 1);
    const g = this.gain.gain;
    g.cancelScheduledValues(when);
    if (opts.fadeIn) {
      g.setValueAtTime(0, when);
      g.linearRampToValueAtTime(this.vol, when + opts.fadeIn);
    } else {
      g.setValueAtTime(this.vol, when);
    }
    src.start(when, opts.offset || 0);
    return this;
  }

  setPosition(p) {
    if (!this.panner || !p) return this;
    const pn = this.panner;
    if (pn.positionX) {
      const t = this.ae.ctx.currentTime;
      pn.positionX.setValueAtTime(p.x, t);
      pn.positionY.setValueAtTime(p.y, t);
      pn.positionZ.setValueAtTime(p.z, t);
    } else {
      pn.setPosition(p.x, p.y, p.z);
    }
    return this;
  }

  setVolume(v, ramp = 0.05) {
    this.vol = v;
    this.gain.gain.setTargetAtTime(v, this.ae.ctx.currentTime, Math.max(0.001, ramp * 0.35));
    return this;
  }

  stop(fade = 0.04) {
    if (!this.active) return;
    const now = this.ae.ctx.currentTime;
    const g = this.gain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + fade);
    try { this.src.stop(now + fade + 0.005); } catch (e) { /* not started */ }
    if (this.looping) {
      // Looping sources never fire onended on their own.
      const s = this.src;
      if (s) s.onended = this._onEnded;
    }
  }
}

export class AudioEngine {
  constructor(opts = {}) {
    this.seed = opts.seed ?? CFG.seed ?? 1;
    this.autoWire = opts.autoWire !== false;
    this.ready = false;
    this.ctx = null;
    this.masterVolume = opts.volume ?? 0.9;
    this.sfxVolume = opts.sfxVolume ?? 1;
    this.musicVolume = opts.musicVolume ?? 0.62;
    this.ambienceVolume = opts.ambienceVolume ?? 0.72;

    this.music = null;
    this.ambience = null;

    this._bank = new Map();          // name -> AudioBuffer[]
    this._rr = new Map();            // name -> round-robin cursor
    this._queue = [];                // pending sfx bake jobs (name, variant, ...)
    this._jobs = [];                 // pending one-off render thunks
    this._voices = [];
    this._freeSpatial = [];
    this._freeFlat = [];
    this._tanks = new Map();
    this._tankBuffers = null;
    this._warned = new Set();
    this._lastCat = new Map();       // de-dup: category -> ctx time of last play
    this._lastPlay = new Map();      // de-dup: sound key -> { t, p, x, y, z }
    this._derived = new Map();       // canonical-event sounds pending a flush
    this._derivedJobs = [];          // scratch for _flushDerived (no per-frame alloc)
    this._space = 'outdoor';
    this._heat = 0;                  // combat intensity 0..1, drives ducking
    this._unwire = [];
    this._musicState = 'menu';
    this._tensionUntil = 0;
    this._suspended = false;         // ctx.suspend()ed by us (tab-out)
    this._ducked = false;            // pause-menu duck (ctx still running)
    this._listenerReady = false;
    this._baked = 0;
    this._bakeTotal = 0;

    // The world, once a Battle announces it. Nothing hands the AudioEngine a
    // World (main.js builds both and introduces neither), which is why the
    // footstep surface, the ambience time-of-day and the ambience wind were all
    // constants. `battle:ready` already carries it.
    this.world = null;
    this._envAccum = 0;              // env poll is control-rate, not per-frame
    this._shotFrom = { x: 0, y: 0, z: 0, speed: 0, ok: false };
    this._enclosedFor = 0;           // hysteresis on the reverb space

    if (this.autoWire) this._wire();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Must be called from a user gesture (click/keypress). Idempotent. */
  init() {
    if (this.ready) return Promise.resolve(this);
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) { console.warn('[audio] WebAudio unavailable'); return Promise.resolve(this); }
    this.ctx = new AC({ latencyHint: 'interactive' });
    const ctx = this.ctx;
    const sr = ctx.sampleRate;

    // --- master chain ------------------------------------------------------
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -2.5;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.09;
    this.limiter.connect(ctx.destination);

    this.master = ctx.createGain();
    this.master.gain.value = this.masterVolume;

    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -17;
    this.comp.knee.value = 14;
    this.comp.ratio.value = 3;
    this.comp.attack.value = 0.005;
    this.comp.release.value = 0.19;
    this.comp.connect(this.master);
    this.master.connect(this.limiter);

    this.dryIn = ctx.createGain();       // spatial sfx, post-panner
    this.uiIn = ctx.createGain();        // 2D sfx
    this.dryIn.connect(this.comp);
    this.uiIn.connect(this.comp);

    // Wet leg: two spaces, cross-faded.
    this.verbIn = ctx.createGain();
    this.verbIn.gain.value = 1;
    this.wetOut = ctx.createGain();
    this.wetOut.gain.value = 0.9;
    this.wetOut.connect(this.comp);

    this.convA = ctx.createConvolver();   // outdoor valley
    this.convB = ctx.createConvolver();   // inside ruin
    this.convA.normalize = true;
    this.convB.normalize = true;
    this.convA.buffer = this._toBuffer(renderIR(sr, IR_PRESETS.outdoor));
    // The ruin IR is silent until setSpace('ruin') fades gainB up, so it can
    // wait for the frame-budgeted queue instead of the click handler.
    this._jobs.push(() => { this.convB.buffer = this._toBuffer(renderIR(sr, IR_PRESETS.ruin)); });
    this.gainA = ctx.createGain(); this.gainA.gain.value = 1;
    this.gainB = ctx.createGain(); this.gainB.gain.value = 0;
    this.verbIn.connect(this.convA); this.convA.connect(this.gainA); this.gainA.connect(this.wetOut);
    this.verbIn.connect(this.convB); this.convB.connect(this.gainB); this.gainB.connect(this.wetOut);

    // A small amount of the whole dry bed also hits the space, so the mix
    // sits in one room rather than sounding like dry sources + a wet layer.
    this.globalSend = ctx.createGain();
    this.globalSend.gain.value = 0.055;
    this.dryIn.connect(this.globalSend);
    this.globalSend.connect(this.verbIn);

    // --- sub-mix buses -----------------------------------------------------
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = this.musicVolume;
    this.musicBus.connect(this.comp);

    this.ambienceBus = ctx.createGain();
    this.ambienceBus.gain.value = this.ambienceVolume;
    this.ambienceBus.connect(this.comp);
    this.ambienceSend = ctx.createGain();
    this.ambienceSend.gain.value = 0.12;
    this.ambienceBus.connect(this.ambienceSend);
    this.ambienceSend.connect(this.verbIn);

    // --- voice pool --------------------------------------------------------
    const nHrtf = byQ([10, 16, 22]);
    const nCheap = byQ([8, 12, 14]);
    const nFlat = 8;
    for (let i = 0; i < nHrtf; i++) this._freeSpatial.push(this._mkVoice(true, true));
    for (let i = 0; i < nCheap; i++) this._freeSpatial.push(this._mkVoice(true, false));
    for (let i = 0; i < nFlat; i++) this._freeFlat.push(this._mkVoice(false, false));

    // --- sub-systems -------------------------------------------------------
    this.music = new MusicEngine(ctx, this.musicBus, { seed: this.seed ^ 0x5f3a });
    this.ambience = new Ambience(ctx, this.ambienceBus, { seed: this.seed ^ 0x1c77 });

    // --- bake --------------------------------------------------------------
    // Sounds that could be needed in the first second are rendered now; the
    // rest stream in over the following frames inside a per-frame time budget.
    const urgent = ['uiTick', 'uiConfirm', 'uiCancel', 'uiSelect', 'uiDeny',
      'uiPage', 'uiStamp', 'uiPlace', 'uiDialogue',
      'rifle', 'smg', 'impactDirt', 'impactFlesh', 'footGrass'];
    for (const name of Object.keys(SFX_DEFS)) {
      const def = SFX_DEFS[name];
      for (let v = 0; v < def.v; v++) this._queue.push(name, v);
    }
    this._bakeTotal = this._queue.length / 2;
    for (const name of urgent) this._bake(name);
    // Warm the tank loops in the background so the first vehicle doesn't hitch.
    this._jobs.push(() => this._buildTankBuffers());

    this.music.start();
    this.ambience.start();
    this.setMusicState(this._musicState);
    this.ready = true;
    return Promise.resolve(this);
  }

  _mkVoice(spatial, hrtf) {
    const v = new Voice(this, spatial, hrtf);
    this._voices.push(v);
    return v;
  }

  _toBuffer(channels) {
    const sr = this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(channels.length, channels[0].length, sr);
    for (let c = 0; c < channels.length; c++) buf.copyToChannel(channels[c], c);
    return buf;
  }

  /**
   * Quieten everything. main.js calls this from TWO places that want different
   * things, and treating them the same was a bug:
   *
   *   * the PAUSE MENU — which is where the Music and Effects rows live. A real
   *     ctx.suspend() freezes `currentTime`, so every UI click made in the menu
   *     is scheduled at the SAME frozen timestamp: _isDuplicate() then drops all
   *     but the first (measured: 1 of 6 clicks survived), and the survivor is
   *     held until resume and fires on the way out. The player hears nothing
   *     while adjusting the volume and a stale blip when he closes the menu.
   *   * a TAB-OUT — which genuinely wants the context stopped so a backgrounded
   *     game costs no battery.
   *
   * So: hidden document => really suspend. Paused in the foreground => duck the
   * battle (spatial sfx, ambience) and lean on the music, and leave the 2D UI
   * bus alive so the menu keeps clicking and the volume rows can be auditioned.
   */
  suspend() {
    if (!this.ready) return Promise.resolve();
    const hidden = typeof document !== 'undefined' && document.hidden;
    this._duck(!hidden);
    if (!hidden) return Promise.resolve();
    this._suspended = true;
    return this.ctx.suspend?.() || Promise.resolve();
  }

  resume() {
    if (!this.ready) return Promise.resolve();
    this._duck(false);
    this._suspended = false;
    return this.ctx.resume?.() || Promise.resolve();
  }

  /** Pause-menu mix duck. The context keeps running, so nothing queues up. */
  _duck(on) {
    if (this._ducked === !!on || !this.ctx) return;
    this._ducked = !!on;
    const now = this.ctx.currentTime;
    const tc = 0.06;
    this.musicBus.gain.setTargetAtTime(this.musicVolume * (on ? DUCK.music : 1), now, tc);
    this.ambienceBus.gain.setTargetAtTime(this.ambienceVolume * (on ? DUCK.ambience : 1), now, tc);
    this.dryIn.gain.setTargetAtTime(on ? DUCK.dry : 1, now, tc);
  }

  dispose() {
    for (const u of this._unwire) u();
    this._unwire.length = 0;
    for (const t of this._tanks.values()) { t.stop(0.05); this._retireTankNodes(t, 0.05); }
    this._tanks.clear();
    this.music?.dispose();
    this.ambience?.dispose();
    this._bank.clear();
    this._derived.clear();
    this._lastPlay.clear();
    this._lastCat.clear();
    this.ready = false;
    try { this.ctx?.close(); } catch (e) { /* already closed */ }
  }

  // -------------------------------------------------------------------------
  // Baking
  // -------------------------------------------------------------------------

  _bake(name, variant) {
    const def = SFX_DEFS[name];
    if (!def) return null;
    let arr = this._bank.get(name);
    if (!arr) { arr = new Array(def.v).fill(null); this._bank.set(name, arr); }
    if (variant === undefined) {                       // bake all variants
      for (let v = 0; v < def.v; v++) if (!arr[v]) this._bakeOne(name, v, arr);
      return arr;
    }
    if (!arr[variant]) this._bakeOne(name, variant, arr);
    return arr;
  }

  _bakeOne(name, v, arr) {
    const r = renderSfx(name, v, this.ctx.sampleRate);
    if (!r) return;
    arr[v] = this._toBuffer(r.channels);
    this._baked++;
  }

  /** Render queued sounds inside a frame-time budget so startup never stalls
   *  the render loop. Called from update(). */
  _pumpBake(budgetMs) {
    if (!this._queue.length && !this._jobs.length) return;
    const clock = globalThis.performance || Date;
    const t0 = clock.now();
    while (this._jobs.length) {
      this._jobs.shift()();
      if (clock.now() - t0 > budgetMs) return;
    }
    while (this._queue.length) {
      const name = this._queue[0], v = this._queue[1];
      let arr = this._bank.get(name);
      if (!arr) { arr = new Array(SFX_DEFS[name].v).fill(null); this._bank.set(name, arr); }
      if (!arr[v]) this._bakeOne(name, v, arr);
      this._queue.splice(0, 2);
      if (clock.now() - t0 > budgetMs) break;
    }
  }

  /** 0..1 — how much of the bank is resident. */
  get bakeProgress() {
    return this._bakeTotal ? Math.min(1, this._baked / this._bakeTotal) : 1;
  }

  // -------------------------------------------------------------------------
  // Playback
  // -------------------------------------------------------------------------

  /**
   * @param name  canonical name, alias, or null when opts.material is given
   * @param opts  { pos, vol, pitch, delay, material, loop, offset, fadeIn,
   *                variant, detune, spatial }
   * @returns Voice | null
   */
  play(name, opts) {
    // A suspended context has a frozen `currentTime`: everything started while
    // it is stopped lands on one timestamp, gets eaten by the de-duper, and
    // whatever survives fires in a lump the instant it resumes.
    if (!this.ready || this._suspended) return null;
    const o = opts || EMPTY;
    let material = o.material;
    // A FOOTSTEP IS A PROPERTY OF THE GROUND, NOT OF THE EMITTER.
    // actionMode/ai emit the bare name `footstep`, which aliases to `footGrass`
    // — so four of the five baked foot surfaces had no reachable caller and the
    // stone bridge sounded like a meadow. The emitter knows where the boot
    // landed; only we know what is under it.
    if (material === undefined && o.pos && this.world && name) {
      const pre = SFX_DEFS[name] ? name : SFX_ALIASES[name];
      if (pre && isFootSfx(pre)) material = this.groundMaterialAt(o.pos);
    }
    const key = resolveSfxName(name, material);
    if (!key) {
      if (name && !this._warned.has(name)) {
        this._warned.add(name);
        console.warn(`[audio] unknown sfx "${name}"`);
      }
      return null;
    }
    const def = SFX_DEFS[key];

    // A canonical Bus event already queued this exact sound for the end of the
    // frame (see _defer). That derived play knows the blast radius and the
    // listener range, so it wins and this explicit duplicate is dropped.
    if (this._derived.size && this._derivedSupersedes(key)) return null;
    if (this._isDuplicate(key, def, o.pos)) return null;

    // Bake lazily and *per variant* — never render a whole family inline, that
    // is what the frame-budgeted queue is for.
    const arr = this._bank.get(key) || this._bake(key, 0);
    if (!arr) return null;

    // Round-robin the variants, then jitter — never the same take twice.
    let vi = o.variant;
    if (vi === undefined) {
      const c = (this._rr.get(key) || 0);
      vi = c % def.v;
      this._rr.set(key, c + 1 + (Math.random() < 0.34 ? 1 : 0));
    }
    vi %= def.v;
    let buf = arr[vi];
    if (!buf) { this._bakeOne(key, vi, arr); buf = arr[vi]; }
    if (!buf) return null;

    const spatial = o.spatial !== undefined ? o.spatial
      : (def.spatial !== false && !!o.pos);
    const voice = this._alloc(spatial, def.pri ?? 1);
    if (!voice) return null;

    if (spatial && o.pos) {
      const pn = voice.panner;
      pn.refDistance = def.ref ?? 8;
      pn.rolloffFactor = def.roll ?? 1;
      pn.maxDistance = def.max ?? 500;
      voice.setPosition(o.pos);
      const d = this._dist(o.pos);
      // Air absorption: HF loss grows with path length. 20 kHz at the ear,
      // ~5 kHz at 100 m, floored so distant guns stay audible as a dull thump.
      voice.filter.frequency.value = Math.max(520, 20000 * Math.exp(-d * 0.0142));
      // Farther sources are wetter — the direct/reverberant ratio is the
      // strongest distance cue outdoors.
      const wet = (def.wet ?? 0.35) * (0.2 + 0.8 * Math.min(1, d / 55));
      voice.send.gain.value = wet;
    } else {
      voice.filter.frequency.value = 20000;
      voice.send.gain.value = (def.wet ?? 0.1) * 0.35;
    }

    const when = this.ctx.currentTime + (o.delay || 0);
    voice.start(buf, def, {
      vol: (o.vol ?? 1) * this.sfxVolume, pitch: o.pitch, loop: o.loop,
      offset: o.offset, fadeIn: o.fadeIn, detune: o.detune,
    }, when);

    if (def.cat) this._lastCat.set(def.cat, when);
    // Loud ordnance ducks the ambience bed and pushes the music intensity up.
    const p = def.pri ?? 1;
    if (p >= 5) this._heat = Math.min(1, this._heat + (p >= 9 ? 0.55 : 0.2));
    return voice;
  }

  /**
   * True when this exact sound was already triggered at effectively this spot
   * inside its de-dup window — i.e. two emitters described one event. Records
   * the play as a side effect when it is *not* a duplicate.
   *
   * Positions are compared, not just names, so two riflemen firing on the same
   * frame from different bits of the field still both sound. `def.dd = 0`
   * opts a sound out entirely.
   */
  _isDuplicate(key, def, pos) {
    const w = def.dd ?? DEDUPE_WINDOW;
    const now = this.ctx.currentTime;
    const rec = this._lastPlay.get(key);
    if (rec) {
      if (w > 0 && now - rec.t < w) {
        if (!pos && !rec.p) return true;
        if (pos && rec.p) {
          const dx = pos.x - rec.x, dy = pos.y - rec.y, dz = pos.z - rec.z;
          if (dx * dx + dy * dy + dz * dz < DEDUPE_DIST2) return true;
        }
      }
      rec.t = now; rec.p = !!pos;
      if (pos) { rec.x = pos.x; rec.y = pos.y; rec.z = pos.z; }
    } else {
      // Copy the coordinates out — callers pass live meshes' `.position`.
      this._lastPlay.set(key, {
        t: now, p: !!pos, x: pos ? pos.x : 0, y: pos ? pos.y : 0, z: pos ? pos.z : 0,
      });
    }
    return false;
  }

  /**
   * Queue a sound derived from a canonical Bus event, to be played at the end
   * of the frame. Deferring it is what lets the derived play — which sees the
   * whole payload — take priority over an explicit `sfx` for the same physical
   * event, which is always emitted *after* the canonical one.
   *
   * `supersedes` lists the exact resolved keys this entry stands in for. It is
   * deliberately a key list and not a category: `explosion` and `tankGun` are
   * both `cat: 'boom'`, and a detonation must never swallow a tank firing.
   */
  _defer(id, supersedes, fn) { this._derived.set(id, { supersedes, fn }); }

  /** True when a blast report of any size has sounded within `w` seconds. */
  _recentBlast(w = 0.1) {
    const now = this.ctx.currentTime;
    for (let i = 0; i < BLAST_KEYS.length; i++) {
      const r = this._lastPlay.get(BLAST_KEYS[i]);
      if (r && now - r.t < w) return true;
    }
    return false;
  }

  _derivedSupersedes(key) {
    for (const e of this._derived.values()) {
      if (e.supersedes.indexOf(key) >= 0) return true;
    }
    return false;
  }

  _flushDerived() {
    if (!this._derived.size) return;
    const jobs = this._derivedJobs;
    for (const e of this._derived.values()) jobs.push(e.fn);
    // Clear before running: the thunks call play(), which consults _derived.
    this._derived.clear();
    for (let i = 0; i < jobs.length; i++) jobs[i]();
    jobs.length = 0;
  }

  /**
   * A round passing the listener, with real Doppler. WebAudio dropped its
   * built-in Doppler support, so the shift is applied as a playbackRate ramp
   * through closest approach and the panner position is swept along the path.
   *
   * @param from {x,y,z}  muzzle       @param to {x,y,z} impact point
   * @param opts { speed (m/s), vol }
   */
  whizzBy(from, to, opts = {}) {
    if (!this.ready) return null;
    const speed = opts.speed || 780;
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    const ux = dx / len, uy = dy / len, uz = dz / len;
    // Project the listener onto the trajectory to find closest approach.
    const rx = _lp.x - from.x, ry = _lp.y - from.y, rz = _lp.z - from.z;
    const s = Math.max(0, Math.min(len, rx * ux + ry * uy + rz * uz));
    const cx = from.x + ux * s, cy = from.y + uy * s, cz = from.z + uz * s;
    const miss = Math.hypot(_lp.x - cx, _lp.y - cy, _lp.z - cz);
    if (miss > 14) return null;                        // too far to hear the crack

    const voice = this._alloc(true, SFX_DEFS.whizz.pri);
    if (!voice) return null;
    const arr = this._bake('whizz');
    const vi = Math.floor(Math.random() * SFX_DEFS.whizz.v);
    const buf = arr[vi];
    if (!buf) { voice._release(); return null; }

    const pn = voice.panner;
    pn.refDistance = 3;
    pn.rolloffFactor = 1.8;
    pn.maxDistance = 60;
    const now = this.ctx.currentTime;
    // The baked buffer has closest approach at ~0.14-0.18 s; sweep the source
    // from a little before the listener to a little after over that window.
    const travel = Math.min(0.34, Math.max(0.12, 26 / speed * 4));
    const back = 13, fwd = 13;
    const setP = (ax, ay, az, t) => {
      if (pn.positionX) {
        pn.positionX.linearRampToValueAtTime(ax, t);
        pn.positionY.linearRampToValueAtTime(ay, t);
        pn.positionZ.linearRampToValueAtTime(az, t);
      } else if (t <= now + 0.001) pn.setPosition(ax, ay, az);
    };
    if (pn.positionX) {
      pn.positionX.setValueAtTime(cx - ux * back, now);
      pn.positionY.setValueAtTime(cy - uy * back, now);
      pn.positionZ.setValueAtTime(cz - uz * back, now);
    } else {
      pn.setPosition(cx, cy, cz);
    }
    setP(cx + ux * fwd, cy + uy * fwd, cz + uz * fwd, now + travel);

    voice.filter.frequency.value = 18000;
    voice.send.gain.value = 0.18;
    voice.start(buf, SFX_DEFS.whizz, {
      vol: (opts.vol ?? 1) * this.sfxVolume * (1 - miss / 18),
      pitch: 1,
    }, now);
    // Doppler: +/- v/c around unity, applied as a ramp through the apex.
    const shift = Math.min(0.35, speed / 343 * 0.28);
    const pr = voice.src.playbackRate;
    pr.setValueAtTime(1 + shift, now);
    pr.linearRampToValueAtTime(1 - shift * 0.8, now + travel * 0.85);
    return voice;
  }

  /**
   * Fire a bullet-crack for the round that just landed at `to`, using the
   * muzzle stashed by the matching `shot:fired`.
   *
   * Two guards, both necessary:
   *   * A round fired from ON TOP of the listener is your own weapon. Its
   *     supersonic crack is inside the muzzle report you are already hearing,
   *     and whizzBy's closest-approach solve clamps to the muzzle end, so
   *     without this every shot the player takes cracks in his own ear.
   *   * A burst of MG fire is 8 rounds in 0.6 s down one line. They are one
   *     sound to the ear and eight voices to the pool.
   */
  _maybeWhizz(to) {
    const s = this._shotFrom;
    if (!s.ok || !to) return null;
    s.ok = false;                                   // consume: one hit per shot
    if (this._dist(s) < 9) return null;             // that is your own rifle
    const now = this.ctx.currentTime;
    if (now - (this._lastWhizz || -1) < 0.075) return null;
    const v = this.whizzBy(s, to, { speed: s.speed || 780 });
    if (v) this._lastWhizz = now;
    return v;
  }

  /** Continuous tank engine. `id` keys the voice so repeat calls address the
   *  same vehicle. Returns a TankEngineVoice (setRpm/setLoad/setTrackSpeed). */
  tankEngine(id, opts = {}) {
    if (!this.ready) return null;
    let t = this._tanks.get(id);
    if (t) return t;
    this._buildTankBuffers();
    // Each tank gets its own panner so the engine is properly positional.
    const pn = this.ctx.createPanner();
    pn.panningModel = 'HRTF';
    pn.distanceModel = 'inverse';
    pn.refDistance = 9;
    pn.rolloffFactor = 0.9;
    pn.maxDistance = 400;
    pn.connect(this.dryIn);
    const send = this.ctx.createGain();
    send.gain.value = 0.3;
    pn.connect(send);
    send.connect(this.verbIn);
    t = new TankEngineVoice(this.ctx, pn, this._tankBuffers, opts);
    t._panner = pn;
    t._send = send;
    t.setVolume(opts.vol ?? 0.55, 0.4);
    if (opts.pos) this.setTankPosition(id, opts.pos);
    this._tanks.set(id, t);
    return t;
  }

  _buildTankBuffers() {
    if (this._tankBuffers) return this._tankBuffers;
    const sr = this.ctx.sampleRate;
    this._tankBuffers = {
      engine: this._toBuffer([renderEngineLoop(sr, (this.seed ^ 0x7717) >>> 0)]),
      track: this._toBuffer([renderTrackLoop(sr, (this.seed ^ 0x3313) >>> 0)]),
    };
    return this._tankBuffers;
  }

  setTankPosition(id, p) {
    const t = this._tanks.get(id);
    if (!t || !p) return;
    const pn = t._panner;
    if (pn.positionX) {
      const now = this.ctx.currentTime;
      pn.positionX.setTargetAtTime(p.x, now, 0.03);
      pn.positionY.setTargetAtTime(p.y, now, 0.03);
      pn.positionZ.setTargetAtTime(p.z, now, 0.03);
    } else pn.setPosition(p.x, p.y, p.z);
  }

  stopTank(id, fade = 0.4) {
    const t = this._tanks.get(id);
    if (!t) return;
    t.stop(fade);
    this._tanks.delete(id);
    // TankEngineVoice.stop() only drops its own `out`; the panner and the reverb
    // send belong to US and would stay wired into dryIn/verbIn for the life of
    // the context, one pair per destroyed vehicle.
    this._retireTankNodes(t, fade);
  }

  _retireTankNodes(t, fade) {
    setTimeout(() => {
      try { t._panner?.disconnect(); t._send?.disconnect(); } catch (e) { /* gone */ }
    }, (fade + 0.4) * 1000);
  }

  // -------------------------------------------------------------------------
  // Voice pool
  // -------------------------------------------------------------------------

  _alloc(spatial, pri) {
    const free = spatial ? this._freeSpatial : this._freeFlat;
    if (free.length) return free.pop();
    // Steal the oldest active voice that is no more important than this one.
    // Looping voices are never stolen — someone is holding a reference to them.
    //
    // `>=` here meant a voice could never displace an EQUAL-priority one, so
    // once the eight flat voices were full of pri-3 UI blips the ninth UI sound
    // was simply dropped — measured: six of twenty-six 2D sounds fired half a
    // second apart never started at all. Oldest-first among equals is the
    // standard rule and is what keeps a busy results screen from going mute.
    let best = null, bestT = Infinity;
    for (let i = 0; i < this._voices.length; i++) {
      const v = this._voices[i];
      if (!v.active || v.looping || v.spatial !== spatial) continue;
      if (v.pri > pri) continue;
      if (v.startedAt < bestT) { bestT = v.startedAt; best = v; }
    }
    if (!best) return null;
    best._release();
    return free.length ? free.pop() : null;
  }

  _free(v) {
    const free = v.spatial ? this._freeSpatial : this._freeFlat;
    if (free.indexOf(v) < 0) free.push(v);
  }

  _dist(p) {
    const dx = p.x - _lp.x, dy = p.y - _lp.y, dz = p.z - _lp.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  // -------------------------------------------------------------------------
  // Mix state
  // -------------------------------------------------------------------------

  setMusicState(s, opts) {
    this._musicState = s;
    this.music?.setState(s, opts);
  }

  setMusicIntensity(x) { this.music?.setIntensity(x); }

  // -------------------------------------------------------------------------
  // The world
  // -------------------------------------------------------------------------

  /**
   * Introduce the AudioEngine to the World. Wired off `battle:ready`; safe to
   * call again (a mission restart builds a new World).
   */
  attachWorld(world) {
    this.world = world || null;
    this._enclosedFor = 0;
    if (!this.ready || !world) return this;
    this._applyEnvironment(0, true);
    return this;
  }

  /**
   * What is under this point: a walkable platform's tag (the bridge deck) if
   * there is one, otherwise the terrain splat's dominant material.
   * @returns {string|undefined}
   */
  groundMaterialAt(p) {
    const w = this.world;
    if (!w || !p) return undefined;
    const plat = w.onPlatform ? w.onPlatform(p.x, p.z) : null;
    if (plat) return plat.tag || 'stone';
    const t = w.terrain;
    return (t && t.materialAt) ? t.materialAt(p.x, p.z) : undefined;
  }

  /**
   * Push the world's ACTUAL weather and hour into the ambience bed, and pick
   * the reverb space from what is standing around the listener.
   *
   * Ambience shipped at a hardcoded noon and a hardcoded breeze while `dusk` is
   * a shipped scene and World.update() computes a real two-rate gust every
   * frame; setWind/setTimeOfDay/setRiver/setSpace all existed and none of them
   * had a caller. Control-rate (4 Hz) — every one of these is a
   * multi-second-fade setter, so a per-frame poll would be pure AudioParam
   * traffic.
   */
  _applyEnvironment(dt, force = false) {
    const w = this.world;
    if (!w) return;
    this._envAccum += dt;
    if (!force && this._envAccum < 0.25) return;
    this._envAccum = 0;

    // The world's gust — the SAME number every blade of grass and every flag is
    // bending to (World.update -> setWindGain) — runs about 0.28 .. 1.16 around
    // a mean of 0.72. Ambience carries its own fine-grained OU gust model on
    // top of `wind`, so this is deliberately mapped as a SWELL about the
    // shipped 0.38 base rather than stretched over the full 0..1: the bed keeps
    // the level it was tuned at and gains the world's slow breathing.
    if (this.ambience && w._wind !== undefined) {
      const g = 0.38 + (w._wind - 0.72) * 0.42;
      if (Math.abs(g - this.ambience.wind) > 0.004) {
        this.ambience.setWind(Math.max(0, Math.min(1, g)));
      }
    }

    // (Time of day is not polled: it is an EVENT. `world:timeOfDay` is the same
    //  signal main.js re-lights the whole scene from — see _wire.)

    // The reverb space. A stone village street between shelled houses IS the
    // `ruin` IR — short, dense, bright, hard early slap — and the valley bed is
    // wrong there. Judged by how much solid masonry is standing within earshot
    // of the listener, with hysteresis so a walk past one wall cannot chatter
    // the cross-fade.
    const cols = w.colliders;
    if (cols && cols.length) {
      let near = 0;
      for (let i = 0; i < cols.length; i++) {
        const c = cols[i];
        if (c.destroyed || !c.solid) continue;
        const tag = c.tag;
        if (tag !== 'building' && tag !== 'wall' && tag !== 'rubble') continue;
        const p = c.pos || c.position || c.center;
        if (!p) continue;
        const dx = p.x - _lp.x, dz = p.z - _lp.z;
        if (dx * dx + dz * dz < 90) near++;          // within ~9.5 m
      }
      const want = near >= 3;
      this._enclosedFor = want ? Math.min(3, this._enclosedFor + 1)
        : Math.max(-3, this._enclosedFor - 1);
      if (this._enclosedFor >= 2 && this._space !== 'ruin') this.setSpace('ruin');
      else if (this._enclosedFor <= -2 && this._space !== 'outdoor') this.setSpace('outdoor');
    }
  }

  /** Cross-fade the reverb between the two rendered spaces. */
  setSpace(name, fade = 1.2) {
    if (!this.ready || name === this._space) return;
    this._space = name;
    const ruin = name === 'ruin' || name === 'inside' || name === 'interior';
    const now = this.ctx.currentTime;
    this.gainA.gain.setTargetAtTime(ruin ? 0 : 1, now, fade * 0.35);
    this.gainB.gain.setTargetAtTime(ruin ? 1 : 0, now, fade * 0.35);
    this.ambience?.setEnclosed(ruin);
  }

  setMasterVolume(v) {
    this.masterVolume = v;
    if (this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }
  // Both of these are driven from the PAUSE MENU, i.e. while the mix is ducked,
  // so they must write the ducked value or the first row change undoes the duck.
  setMusicVolume(v) {
    this.musicVolume = v;
    if (!this.musicBus) return;
    const k = this._ducked ? DUCK.music : 1;
    this.musicBus.gain.setTargetAtTime(v * k, this.ctx.currentTime, 0.08);
  }
  setAmbienceVolume(v) {
    this.ambienceVolume = v;
    if (!this.ambienceBus) return;
    const k = this._ducked ? DUCK.ambience : 1;
    this.ambienceBus.gain.setTargetAtTime(v * k, this.ctx.currentTime, 0.08);
  }

  // -------------------------------------------------------------------------
  // Per-frame
  // -------------------------------------------------------------------------

  /**
   * @param dt seconds
   * @param listenerMatrix THREE.Matrix4 (camera.matrixWorld) or an object with
   *        `.matrixWorld` / `.elements`. Optional — the last pose is kept.
   */
  update(dt, listenerMatrix) {
    if (!this.ready) return;
    const ctx = this.ctx;

    if (listenerMatrix) {
      const e = listenerMatrix.elements || listenerMatrix.matrixWorld?.elements;
      if (e) {
        _prevLp.x = _lp.x; _prevLp.y = _lp.y; _prevLp.z = _lp.z;
        _lp.x = e[12]; _lp.y = e[13]; _lp.z = e[14];
        // Three cameras look down -Z; the listener wants the view direction.
        const fx = -e[8], fy = -e[9], fz = -e[10];
        // Nine AudioParam events per frame is a lot to spend on a camera that
        // hasn't meaningfully moved; skip when the pose is effectively static.
        const moved = Math.abs(_lp.x - _prevLp.x) + Math.abs(_lp.y - _prevLp.y)
          + Math.abs(_lp.z - _prevLp.z) > 1e-3;
        const turned = Math.abs(fx - _lf.x) + Math.abs(fy - _lf.y) + Math.abs(fz - _lf.z) > 1e-4;
        _lf.x = fx; _lf.y = fy; _lf.z = fz;
        _lu.x = e[4]; _lu.y = e[5]; _lu.z = e[6];
        if (moved || turned || !this._listenerReady) this._applyListener(ctx.currentTime, dt);
      }
    }

    // The world's real wind and the space the listener is standing in.
    this._applyEnvironment(dt);

    // Combat heat decays; it ducks ambience and lifts music intensity.
    this._heat = Math.max(0, this._heat - dt * 0.42);
    this.ambience?.setCombatHeat(this._heat);
    this.ambience?.update(dt);
    this.music?.setIntensity(this._heat);
    this.music?.update(dt);

    for (const t of this._tanks.values()) t.update(dt);

    if (this._tensionUntil && ctx.currentTime > this._tensionUntil) {
      this._tensionUntil = 0;
      if (this.music && this.music.state !== this._musicState) {
        this.music.setState(this._musicState);
      }
    }

    // Sounds inferred from canonical events fire here, once every explicit
    // `sfx` for this frame has had its chance to supersede them.
    this._flushDerived();

    this._pumpBake(4);
  }

  _applyListener(now, dt) {
    const L = this.ctx.listener;
    if (L.positionX) {
      // Ramp rather than jump — an instantaneous listener move on a fast pan
      // produces audible zipper noise through the HRTF panners.
      const t = now + Math.min(0.05, Math.max(0.008, dt));
      if (!this._listenerReady) {
        L.positionX.value = _lp.x; L.positionY.value = _lp.y; L.positionZ.value = _lp.z;
        L.forwardX.value = _lf.x; L.forwardY.value = _lf.y; L.forwardZ.value = _lf.z;
        L.upX.value = _lu.x; L.upY.value = _lu.y; L.upZ.value = _lu.z;
        this._listenerReady = true;
        return;
      }
      L.positionX.linearRampToValueAtTime(_lp.x, t);
      L.positionY.linearRampToValueAtTime(_lp.y, t);
      L.positionZ.linearRampToValueAtTime(_lp.z, t);
      L.forwardX.linearRampToValueAtTime(_lf.x, t);
      L.forwardY.linearRampToValueAtTime(_lf.y, t);
      L.forwardZ.linearRampToValueAtTime(_lf.z, t);
      L.upX.linearRampToValueAtTime(_lu.x, t);
      L.upY.linearRampToValueAtTime(_lu.y, t);
      L.upZ.linearRampToValueAtTime(_lu.z, t);
    } else {
      L.setPosition(_lp.x, _lp.y, _lp.z);
      L.setOrientation(_lf.x, _lf.y, _lf.z, _lu.x, _lu.y, _lu.z);
      this._listenerReady = true;
    }
  }

  // -------------------------------------------------------------------------
  // Bus wiring
  // -------------------------------------------------------------------------
  //
  // `sfx` is the contract event. The rest are opportunistic: if the game only
  // emits canonical events the world is still fully scored, and if it emits
  // both we suppress the derived one via a short per-category window.

  _recent(cat, w = 0.07) {
    const t = this._lastCat.get(cat);
    return t !== undefined && this.ctx.currentTime - t < w;
  }

  _wire() {
    const on = (evt, fn) => this._unwire.push(Bus.on(evt, fn));

    on('sfx', (p) => {
      if (!p) return;
      this.play(p.name, p);
    });

    // --- the world introduces itself ---------------------------------------
    // main.js builds the World and the AudioEngine and introduces neither to
    // the other. `battle:ready` already carries the Battle, and Battle owns the
    // World — so this is the handshake that makes the footstep surface, the
    // ambience hour and the reverb space knowable at all.
    on('battle:ready', (p) => {
      this.attachWorld(p?.battle?.world);
      const t = p?.mission?.timeOfDay;
      if (typeof t === 'number') this.ambience?.setTimeOfDay(t);
    });

    // The canonical time-of-day signal — the same event main.js re-lights the
    // whole scene from. `dusk` is a shipped scene; the crickets belong in it.
    on('world:timeOfDay', (p) => {
      if (p && typeof p.t === 'number') this.ambience?.setTimeOfDay(p.t);
    });

    // --- the Edelweiss --------------------------------------------------
    // Tank._updateAudio publishes rpm/load/track/position at ~20 Hz. The voice
    // is created on the first message and keyed by the vehicle's id, so a
    // second tank simply gets a second voice.
    on('vehicle:engine', (p) => {
      if (!p || !this.ready) return;
      const t = this._tanks.get(p.id) || this.tankEngine(p.id, { pos: p.pos, vol: 0.5 });
      if (!t) return;
      t.setRpm(p.rpm);
      t.setLoad(p.load);
      t.setTrackSpeed(p.track);
      this.setTankPosition(p.id, p.pos);
    });
    on('vehicle:engineStop', (p) => { if (p && this.ready) this.stopTank(p.id); });

    on('shot:fired', (p) => {
      // Stash the muzzle for whizzBy(): `shot:hit` knows where the round
      // stopped but not where it started, and combat.fireRound emits the pair
      // synchronously, this one first.
      if (p && p.origin) {
        const s = this._shotFrom;
        s.x = p.origin.x; s.y = p.origin.y; s.z = p.origin.z;
        s.speed = p.speed || 0;
        s.ok = true;
      }
      if (!p || !this.ready || this._recent('gun')) return;
      const w = p.weapon;
      // A weapon definition names its own sound; combat.js emits that same
      // name explicitly a line later, so resolving to anything else here
      // would fire two *different* gunshots for one round.
      const name = (typeof w === 'string' ? (WEAPON_SFX[w] || w) : w?.sfx)
        || WEAPON_SFX[w?.kind] || WEAPON_SFX[w?.type] || WEAPON_SFX[w?.name]
        || WEAPON_SFX[p.unit?.cls] || 'rifle';
      this.play(name, { pos: p.origin || p.unit?.pos });
    });

    on('shot:hit', (p) => {
      if (!p || !this.ready) return;
      // THE CRACK OF A ROUND GOING PAST YOU.
      //
      // whizzBy() — a full Doppler sweep with the panner flown along the
      // trajectory — had no caller anywhere. It needs both ends of the flight
      // path: `shot:fired` gave the muzzle a moment ago, this gives the impact.
      this._maybeWhizz(p.point);
      if (this._recent('impact')) return;
      const name = MATERIAL_IMPACT[p.material] || (p.unit ? 'impactFlesh' : 'impactDirt');
      this.play(name, { pos: p.point });
      // Glancing hits on hard cover spark off.
      if ((name === 'impactStone' || name === 'impactMetal') && Math.random() < 0.35) {
        this.play('ricochet', { pos: p.point, delay: 0.015, vol: 0.7 });
      }
    });

    // The blast. This is the *only* place a blast report is chosen, because
    // this is the only place that knows the radius and the range: emitters
    // that also send an explicit `sfx` (explosions.js sends `explosionBig`,
    // render/fx.js used to send `explosion`) are suppressed by play() while
    // this is pending, so a detonation is one report, sized correctly.
    on('explosion', (p) => {
      if (!p || !this.ready) return;
      const r = p.radius || 5;
      const pos = p.pos;
      this._defer('explosion', BLAST_KEYS, () => {
        // Two detonations inside 100 ms mask each other anyway — but gate on
        // *blasts*, not on the whole 'boom' category, or a tank firing in the
        // same frame would silence the shell that just landed next to it.
        if (this._recentBlast(0.1)) return;
        // Past ~130 m the direct blast is gone and all that arrives is the
        // filtered roll off the valley — a different sound, not a quieter one.
        const far = pos ? this._dist(pos) > 130 : false;
        const name = far ? 'explosionDistant' : (r >= 6 ? 'explosionBig' : 'explosion');
        this.play(name, { pos, vol: Math.min(1.35, 0.6 + r * 0.06) });
        if (!far && r > 7) this.play('impactDirt', { pos, delay: 0.9, vol: 0.5 });
      });
    });

    on('unit:downed', (p) => {
      if (!p || !this.ready) return;
      const pos = p.unit?.pos || p.pos;
      this.play('bodyFall', { pos, delay: 0.06 });
      this.play('cloth', { pos, delay: 0.02, vol: 0.7 });
    });

    on('interception', (p) => {
      if (!this.ready) return;
      if (!this._recent('ui', 1.6)) this.play('uiAlert', { vol: 0.8 });
      // Hold the tension cue, extending the timer on repeat interceptions
      // rather than re-triggering the state (which would restart the phrase).
      if (this.music && this.music.state !== 'tension') this.music.setState('tension');
      this._tensionUntil = this.ctx.currentTime + 6;
      this._heat = Math.min(1, this._heat + 0.5);
    });

    on('phase:change', (p) => {
      if (!p || !this.ready) return;
      const s = MUSIC_FOR_PHASE[p.to];
      if (s && p.to !== 'result') this.setMusicState(s);
      this.play('uiPage', { vol: 0.8 });
    });

    on('mission:end', (p) => {
      if (!this.ready) return;
      this.setMusicState(p?.victory ? 'victory' : 'defeat');
      this.play('uiRankStamp', { delay: 0.35 });
    });

    on('order:used', () => { if (this.ready) this.play('uiStamp'); });

    on('cp:changed', (p) => {
      if (!this.ready || !p) return;
      const prev = this._cpPrev?.[p.team];
      if (!this._cpPrev) this._cpPrev = {};
      this._cpPrev[p.team] = p.cp;
      if (prev !== undefined && p.cp < prev && !this._recent('ui', 0.1)) this.play('uiCp');
    });

    on('unit:selected', () => { if (this.ready) this.play('uiTick'); });
  }
}

export default AudioEngine;
