// Minimal synchronous event bus. See docs/ARCHITECTURE.md for the event table.

const listeners = new Map();

export const Bus = {
  on(evt, fn) {
    let s = listeners.get(evt);
    if (!s) listeners.set(evt, (s = new Set()));
    s.add(fn);
    return () => Bus.off(evt, fn);
  },
  once(evt, fn) {
    const off = Bus.on(evt, (p) => { off(); fn(p); });
    return off;
  },
  off(evt, fn) {
    listeners.get(evt)?.delete(fn);
  },
  emit(evt, payload) {
    const s = listeners.get(evt);
    if (!s) return;
    for (const fn of Array.from(s)) {
      try { fn(payload); } catch (e) { console.error(`[Bus:${evt}]`, e); }
    }
  },
  clear() { listeners.clear(); },
};
