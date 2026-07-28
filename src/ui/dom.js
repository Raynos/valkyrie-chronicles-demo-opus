// src/ui/dom.js
// Tiny DOM helpers shared by every UI module. No framework, no allocation churn
// in the per-frame path (builders are only called on state change).

import { deckleClip, deckleTilt } from './style.js';

/**
 * Hyperscript. `props` may contain: class/className, style (string|object),
 * text, html, dataset, attrs (object of raw attributes), on* handlers.
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const k in props) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class' || k === 'className') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'style') {
        if (typeof v === 'string') el.style.cssText = v;
        else for (const s in v) el.style.setProperty(s, v[s]);
      } else if (k === 'dataset') { for (const d in v) el.dataset[d] = v[d]; }
      else if (k === 'attrs') { for (const a in v) el.setAttribute(a, v[a]); }
      else if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v);
      } else el.setAttribute(k, v);
    }
  }
  append(el, children);
  return el;
}

export function append(parent, kids) {
  for (const c of kids) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(parent, c);
    else if (typeof c === 'string' || typeof c === 'number') {
      parent.appendChild(document.createTextNode(String(c)));
    } else parent.appendChild(c);
  }
  return parent;
}

/** Parse an SVG markup string into a live element (first child of the wrapper). */
export function svgEl(markup) {
  const doc = new DOMParser().parseFromString(
    markup.trim().startsWith('<svg') ? markup
      : '<svg xmlns="http://www.w3.org/2000/svg">' + markup + '</svg>',
    'image/svg+xml');
  return document.importNode(doc.documentElement, true);
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

/** Mark an element interactive (index.html gates pointer-events on `.clickable`). */
export function clickable(el, fn) {
  el.classList.add('clickable');
  if (fn) el.addEventListener('click', (e) => { e.stopPropagation(); fn(e); });
  return el;
}

/**
 * Build a paper panel: a deckle-clipped, grain-textured backing sheet plus an
 * unfiltered content layer (so text never goes through an SVG filter).
 * @param {object} o { seed, cls, tilt, under, amp, soft }
 * @returns {{root:HTMLElement, content:HTMLElement, paper:HTMLElement}}
 */
export function panel({ seed = 1, cls = '', tilt = 0.55, under = false, amp = 0.9, soft = false } = {}) {
  const root = h('div', { class: 'vc-panel ' + cls });
  const paper = h('div', { class: 'vc-paper' + (soft ? ' vc-soft' : '') });
  paper.style.clipPath = deckleClip(seed, { amp });
  if (under) {
    const u = h('div', { class: 'vc-under' });
    u.style.clipPath = deckleClip(seed ^ 0x5bf03635, { amp: amp * 1.2 });
    root.appendChild(u);
  }
  root.appendChild(paper);
  const content = h('div', { class: 'vc-content' });
  root.appendChild(content);
  // Expose the tilt as a custom property too: keyframes that end on `transform`
  // would otherwise wipe the inline rotation for their whole fill duration.
  const deg = tilt ? deckleTilt(seed, tilt) : 0;
  root.style.setProperty('--tilt', deg.toFixed(2) + 'deg');
  if (tilt) root.style.transform = 'rotate(' + deg.toFixed(2) + 'deg)';
  return { root, content, paper };
}

/** Convenience: panel whose content is `inner` and which returns just the root. */
export function panelWith(opts, inner) {
  const p = panel(opts);
  append(p.content, [inner]);
  return p.root;
}

/** Small-caps label element. */
export const label = (t, cls = '') => h('div', { class: 'vc-label ' + cls, text: t });

/** Restart a CSS animation on an element (class must define the keyframes). */
export function replay(el, cls) {
  el.classList.remove(cls);
  // Force reflow so the animation restarts even if the class never left.
  void el.offsetWidth;
  el.classList.add(cls);
}

/**
 * Typewriter reveal. Returns a controller; call `finish()` to dump the rest,
 * `cancel()` to stop. Uses one rAF-free timer so it costs nothing per frame.
 */
export function typewriter(el, text, { cps = 42, onDone = null, caret = true } = {}) {
  clear(el);
  const span = h('span');
  el.appendChild(span);
  const car = caret ? h('span', { class: 'vc-caret', text: '▌' }) : null;
  if (car) el.appendChild(car);
  let i = 0, timer = 0, done = false;
  const step = () => {
    // Punctuation gets a longer beat — reads as breath, not as a stall.
    const ch = text[i];
    i++;
    span.textContent = text.slice(0, i);
    if (i >= text.length) { finish(); return; }
    const pause = ch === '.' || ch === '!' || ch === '?' ? 5.5
      : ch === ',' || ch === ';' || ch === '—' ? 3.0 : 1;
    timer = setTimeout(step, (1000 / cps) * pause);
  };
  function finish() {
    if (done) return;
    done = true;
    clearTimeout(timer);
    span.textContent = text;
    car?.remove();
    onDone?.();
  }
  function cancel() { done = true; clearTimeout(timer); }
  timer = setTimeout(step, 40);
  return { finish, cancel, get done() { return done; } };
}

/** Format a number with a fixed field width, e.g. pad(4,2) -> "04". */
export const pad = (n, w = 2) => String(Math.max(0, Math.round(n))).padStart(w, '0');

/** Roman numerals for chapter tabs. */
export function roman(n) {
  const t = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
    [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let s = '', v = Math.max(1, Math.round(n));
  for (const [k, r] of t) while (v >= k) { s += r; v -= k; }
  return s;
}

const WORDS = ['ZERO', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT',
  'NINE', 'TEN', 'ELEVEN', 'TWELVE'];
export const numberWord = (n) => WORDS[n] || String(n);
