// Keyboard + mouse + pointer lock. Engine calls Input.update() at end of frame.
//
// THERE IS DELIBERATELY NO TOUCH INPUT HERE, AND THAT IS A SHIPPED DECISION.
//
// Command mode needs drag/LMB/Tab/Q/Enter/E and action mode needs WASD + RMB-aim
// + LMB-fire; pointer lock (requestLock below) does not exist on iOS at all. A
// phone used to boot to a polished, readable title card with a real tappable
// "Open the Book" and then have nothing to press — the demo looked like it
// worked and then silently didn't, which is worse than saying no.
//
// So `needsDesktop()` in src/main.js checks `(any-pointer: fine)` /
// `(any-hover: hover)` at boot and shows a "this needs a keyboard and mouse"
// card INSTEAD of building the world — which also spares a phone GPU 986k
// triangles it was never going to be able to play. Half-built touch controls
// would be a worse answer than an honest gate; if touch is ever added it has to
// be a real scheme (virtual stick, tap-to-select, aim reticle drag), not a
// mousedown alias.

const keys = new Set();
const justDown = new Set();
const justUp = new Set();

export const Input = {
  keys,
  mouse: { x: 0, y: 0, nx: 0, ny: 0, dx: 0, dy: 0, left: false, right: false, wheel: 0,
           leftJust: false, rightJust: false },
  pointerLocked: false,
  enabled: true,

  down: (c) => keys.has(c),
  pressed: (c) => justDown.has(c),
  released: (c) => justUp.has(c),

  attach(el) {
    const norm = (e) => (e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase());
    addEventListener('keydown', (e) => {
      if (!Input.enabled) return;
      const k = norm(e);
      if (!keys.has(k)) justDown.add(k);
      keys.add(k);
      if (['tab', ' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) e.preventDefault();
    });
    addEventListener('keyup', (e) => { const k = norm(e); keys.delete(k); justUp.add(k); });
    addEventListener('blur', () => { keys.clear(); Input.mouse.left = Input.mouse.right = false; });

    el.addEventListener('mousemove', (e) => {
      if (Input.pointerLocked) {
        Input.mouse.dx += e.movementX;
        Input.mouse.dy += e.movementY;
      } else {
        const r = el.getBoundingClientRect();
        Input.mouse.dx += e.movementX || 0;
        Input.mouse.dy += e.movementY || 0;
        Input.mouse.x = e.clientX - r.left;
        Input.mouse.y = e.clientY - r.top;
        Input.mouse.nx = (Input.mouse.x / r.width) * 2 - 1;
        Input.mouse.ny = -(Input.mouse.y / r.height) * 2 + 1;
      }
    });
    el.addEventListener('mousedown', (e) => {
      if (e.button === 0) { Input.mouse.left = true; Input.mouse.leftJust = true; }
      if (e.button === 2) { Input.mouse.right = true; Input.mouse.rightJust = true; }
    });
    addEventListener('mouseup', (e) => {
      if (e.button === 0) Input.mouse.left = false;
      if (e.button === 2) Input.mouse.right = false;
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('wheel', (e) => { Input.mouse.wheel += Math.sign(e.deltaY); e.preventDefault(); },
      { passive: false });

    document.addEventListener('pointerlockchange', () => {
      Input.pointerLocked = document.pointerLockElement === el;
    });
    Input._el = el;
  },

  // Pointer lock is a request, not a guarantee: the browser refuses it when the
  // document is not the active one, when a previous lock is still unwinding, or
  // when it does not believe a user gesture is in play. Since Chrome 111 that
  // refusal arrives as a rejected promise, so leaving it unhandled turns an
  // entirely normal outcome into an uncaught console error. The game reads
  // `Input.pointerLocked` (set from the pointerlockchange event) and plays fine
  // unlocked, so a refusal is genuinely nothing to report.
  requestLock() {
    const p = Input._el?.requestPointerLock?.();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  },
  exitLock() {
    try { document.exitPointerLock?.(); } catch { /* not locked */ }
  },

  update() {
    justDown.clear();
    justUp.clear();
    Input.mouse.dx = 0;
    Input.mouse.dy = 0;
    Input.mouse.wheel = 0;
    Input.mouse.leftJust = false;
    Input.mouse.rightJust = false;
  },
};
