// src/core/save.js
// Persistence. Two localStorage keys, no schema migrations, no cleverness:
//
//   vc.settings.v1 — the player's options (PauseMenu rows). Flat {key: label}.
//   vc.ledger.v1   — what carries BETWEEN missions: ducats, EXP, what was won.
//
// Every entry point is guarded. Private browsing, a full quota, a disabled
// storage partition and a hand-corrupted value all degrade to defaults instead
// of throwing — a save system that can crash the boot is worse than none.

const SETTINGS_KEY = 'vc.settings.v1';
const LEDGER_KEY = 'vc.ledger.v1';

/** Shape of a fresh campaign ledger. Anything absent from disk comes from here. */
export const DEFAULT_LEDGER = {
  v: 1,
  ducats: 0,          // spendable currency, summed across missions
  exp: 0,             // squad-wide experience pool
  unitExp: {},        // unit id/name -> exp, for per-soldier promotion
  missions: {},       // mission id -> { rank, turns, won, at }
  playedMs: 0,        // total time in battle, for a "continue" line
  updated: 0,         // Date.now of the last write
};

// --------------------------------------------------------------------------
// storage plumbing
// --------------------------------------------------------------------------

let store = undefined; // undefined = not probed yet, null = unavailable

/**
 * The one place that touches `localStorage`. Safari in private mode throws on
 * *access* in some versions and on *write* in others, so both are probed once
 * and the result cached; after a failure every call here is a no-op.
 */
function backing() {
  if (store !== undefined) return store;
  store = null;
  try {
    const ls = globalThis.localStorage;
    if (!ls) return store;
    const probe = '__vc_probe__';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    store = ls;
  } catch (e) {
    store = null;
  }
  return store;
}

/** True when writes will actually stick. Callers can show "saving is off". */
export function saveAvailable() { return !!backing(); }

function readJson(key) {
  const ls = backing();
  if (!ls) return null;
  try {
    const raw = ls.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw);
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : null;
  } catch (e) {
    // Corrupt or foreign value: drop it rather than fight it every boot.
    try { ls.removeItem(key); } catch (e2) { /* nothing left to try */ }
    return null;
  }
}

function writeJson(key, value) {
  const ls = backing();
  if (!ls) return false;
  try {
    ls.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    return false;   // quota / partitioned storage: the session just stays unsaved
  }
}

// --------------------------------------------------------------------------
// settings
// --------------------------------------------------------------------------

/**
 * The player's options, as a flat map of option key -> chosen label
 * (e.g. `{ quality:'High', music:'Quiet' }`). Unknown keys are preserved so an
 * older build cannot eat a newer build's rows. Always returns an object.
 */
export function loadSettings() {
  const v = readJson(SETTINGS_KEY);
  if (!v) return {};
  const out = {};
  for (const k of Object.keys(v)) {
    const val = v[k];
    const t = typeof val;
    if (t === 'string' || t === 'number' || t === 'boolean') out[k] = val;
  }
  return out;
}

/** Replace the whole settings blob. Returns true when it stuck. */
export function saveSettings(settings) {
  if (!settings || typeof settings !== 'object') return false;
  return writeJson(SETTINGS_KEY, settings);
}

/**
 * Merge one or more keys into the stored settings and write back. This is what
 * a UI row wants on change: `patchSettings({ music:'Quiet' })`.
 * Returns the merged object (whether or not the write stuck).
 */
export function patchSettings(partial) {
  const next = loadSettings();
  if (partial && typeof partial === 'object') Object.assign(next, partial);
  saveSettings(next);
  return next;
}

// --------------------------------------------------------------------------
// campaign ledger
// --------------------------------------------------------------------------

/** The campaign ledger, with every missing field defaulted. Never throws. */
export function loadLedger() {
  const raw = readJson(LEDGER_KEY);
  const l = { ...DEFAULT_LEDGER, unitExp: {}, missions: {} };
  if (!raw) return l;
  if (Number.isFinite(raw.ducats)) l.ducats = Math.max(0, Math.round(raw.ducats));
  if (Number.isFinite(raw.exp)) l.exp = Math.max(0, Math.round(raw.exp));
  if (Number.isFinite(raw.playedMs)) l.playedMs = Math.max(0, raw.playedMs);
  if (Number.isFinite(raw.updated)) l.updated = raw.updated;
  if (raw.unitExp && typeof raw.unitExp === 'object') {
    for (const k of Object.keys(raw.unitExp)) {
      const n = Number(raw.unitExp[k]);
      if (Number.isFinite(n)) l.unitExp[k] = Math.max(0, Math.round(n));
    }
  }
  if (raw.missions && typeof raw.missions === 'object') {
    for (const k of Object.keys(raw.missions)) {
      const m = raw.missions[k];
      if (m && typeof m === 'object') {
        l.missions[k] = {
          rank: typeof m.rank === 'string' ? m.rank : null,
          turns: Number.isFinite(m.turns) ? m.turns : 0,
          won: !!m.won,
          at: Number.isFinite(m.at) ? m.at : 0,
        };
      }
    }
  }
  return l;
}

/** Write the ledger. Stamps `updated`. Returns true when it stuck. */
export function saveLedger(ledger) {
  if (!ledger || typeof ledger !== 'object') return false;
  return writeJson(LEDGER_KEY, { ...ledger, v: 1, updated: Date.now() });
}

/**
 * Fold one mission result into the ledger and save it. This is the call the
 * results flow wants — see the handoff note at the bottom of this file.
 * @param {{id?:string, rank?:string, turns?:number, won?:boolean,
 *          dp?:number, exp?:number, unitExp?:object, playedMs?:number}} r
 */
export function recordMission(r = {}) {
  const l = loadLedger();
  l.ducats += Math.max(0, Math.round(r.dp || 0));
  l.exp += Math.max(0, Math.round(r.exp || 0));
  l.playedMs += Math.max(0, r.playedMs || 0);
  if (r.unitExp && typeof r.unitExp === 'object') {
    for (const k of Object.keys(r.unitExp)) {
      const n = Number(r.unitExp[k]);
      if (Number.isFinite(n)) l.unitExp[k] = (l.unitExp[k] || 0) + Math.max(0, Math.round(n));
    }
  }
  const id = String(r.id || 'mission');
  const prev = l.missions[id];
  const won = !!r.won;
  // Keep the best rank a mission was ever cleared at, not the latest.
  const better = !prev || (won && !prev.won) || (won && prev.won && rankBetter(r.rank, prev.rank));
  if (better) {
    l.missions[id] = { rank: r.rank || null, turns: r.turns || 0, won, at: Date.now() };
  }
  saveLedger(l);
  return l;
}

const RANK_ORDER = { A: 4, B: 3, C: 2, D: 1 };
function rankBetter(a, b) { return (RANK_ORDER[a] || 0) > (RANK_ORDER[b] || 0); }

/** True when there is anything worth continuing from. */
export function hasProgress() {
  const l = loadLedger();
  return l.ducats > 0 || l.exp > 0 || Object.keys(l.missions).length > 0;
}

/** Wipe both keys. For an options "Erase Journal" row. */
export function clearSave() {
  const ls = backing();
  if (!ls) return false;
  try { ls.removeItem(SETTINGS_KEY); ls.removeItem(LEDGER_KEY); return true; }
  catch (e) { return false; }
}

// --------------------------------------------------------------------------
// HANDOFF — what still has to be called, and from where
// --------------------------------------------------------------------------
//
// The settings half is already wired: src/ui/screens.js PauseMenu seeds its rows
// from loadSettings() and calls patchSettings() on every change, so options
// survive a reload today.
//
// The ledger half needs two owners this round did not have:
//
//  1. src/game/battle.js — when a mission ends, call
//         recordMission({ id: mission.id || 'ch4', rank, turns, won: victory,
//                         dp, exp, unitExp })
//     with the same numbers already handed to ResultsScreen.show(). One call,
//     at the point the results data object is built.
//
//  2. src/main.js — at boot, `const ledger = loadLedger()` and seed the squad's
//     starting ducats/EXP from it instead of from zero, then DROP the
//     `location.reload()` in the mission-complete path (main.js ~line 700): with
//     the ledger persisted, "Close the Book" should re-run the mission setup
//     in place, which is both faster and keeps the carried progress in memory.
//
// Nothing else in the codebase needs to know this module exists.
