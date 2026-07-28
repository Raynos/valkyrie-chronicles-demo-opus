// Keyboard + mouse + pointer lock. Engine calls Input.update() at end of frame.

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

  requestLock() { Input._el?.requestPointerLock?.(); },
  exitLock() { document.exitPointerLock?.(); },

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
