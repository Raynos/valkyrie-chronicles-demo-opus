# r25 audit — publish

**Verdict:** needs-work

## Summary
The worst thing is that the demo opens on 3.3 s of an empty dark rectangle with no text, no logo and no progress — measured on a warm local static host on an M-series Mac; over a real connection (619 kB gzip + world gen + 89 shader compiles) that void is far longer, and it is the first and possibly only thing a stranger sees. The second worst is that the first frame of actual gameplay has the six-card Orders hand dealt open across the bottom-centre of the tactical map by default, overlapping the bridge the mission is about and colliding with the roster at 1366x768; and the gameplay control legend is already painted along the bottom edge of the title card, so the game's first impression is "UI leaking through the menu". Against that, a lot of this axis is genuinely done: the front end is title -> chapter -> briefing -> deployment -> cutscene -> battle with keyboard bindings and auto-advance timers, the results screen is a real VC-style ledger with a slamming rank stamp, the pause menu has six working options plus Restart Mission, the audio is a fully wired procedural synth (verified running: 158 oscillators, 318 gains, 3 convolvers), and `npx vite build` produces a 2.0 MB / 619 kB-gzip dist that boots from a plain static host with zero console errors and survives window resize. The remaining gaps are presentation and hygiene: README and package.json description are still the user's raw prompt, there is no favicon or description meta, a WebGL-less browser gets a minified stack trace, the HUD collapses below ~700 px viewport height, and mobile boots to a playable-looking title screen and then has no input at all.

## Do not touch (verified good)
DO NOT TOUCH THESE — they are the parts that make it read as a real game:

1. `src/ui/screens.js:619-732` ResultsScreen. I rendered it (victory, rank A, full stats) and it is excellent: "Mission Report — Success / The Field is Ours", a wax rank stamp that slams down, a ruled ledger that fills in line by line (Turns Used / Ducats / Experience / Enemies Routed / Camps Taken / Damage Dealt / Orders Issued / Accuracy), a casualty list with skull glyphs, and a "Close the Book" ribbon. The win/lose presentation concern is already solved. `src/game/battle.js:1076-1102` computes a real A/B/C/D rank off turns and losses.

2. `src/ui/screens.js:757-863` PauseMenu — "The Book is Closed / Paused" with Render Quality, Flourishes, Paper Grain, Music, Effects, Invert Aim, plus Restart Mission and Resume. Verified opening and closing on Esc at runtime.

3. The whole front-end chain: title card (`src/main.js:578-614`), chapter card, briefing with a theatre map and a real objective paragraph, deployment with named squad chips, and `autoGo` (`src/ui/screens.js:137-167`) which gives every spread its own Enter/Space binding and a printed countdown. Round 22's note in that comment ("a stranger who only ever presses Enter reached the battlefield in zero of five attempts") is fixed — I drove the whole flow with nothing but Enter and reached command mode in ~12 s.

4. Audio (`src/audio/*`). Verified at runtime, not just read: the AudioContext is created inside the title-button gesture, reaches state "running", and by the time the map opens the game has built 158 oscillators, 318 gain nodes, 147 biquads, 3 convolvers (reverb), 37 panners (3D positioning) and 33 buffer sources. Music state machine, SFX and ambience are all Bus-wired (`src/audio/engine.js:860-960`). This is not a silent tech demo.

5. Zero `console.log` in 61 modules. Zero TODO/FIXME/lorem. No dev overlay ships (`CFG.debug` and `__VC__` are query-gated; `__ENGINE__` is a harmless handle).

6. The build itself: 66 modules -> one 2.0 MB chunk, 619 kB gzip, 449 ms build, boots from `python3 -m http.server` with an empty `errors` array, and `engine.onResize` correctly follows a live window resize down to 900x560 and back with no exception.

7. `src/main.js:776-786` visibilitychange — pauses the engine and suspends audio on tab-out, drops the elapsed background time on return so the fight does not fast-forward. Correct.

## Findings

### [blocker | small | verified] The first 3.3+ seconds are a blank dark rectangle with no loading indicator whatsoever

**Location:** `index.html:18`

**Evidence:** `<body>` contains only `<canvas id="view">` and an empty `<div id="hud">`, over `background:#17120e` (index.html:10). Nothing is drawn until the HUD mounts the title card. Measured in a play-mode iframe against a warm local static host on this Mac: 3350 ms from navigation to `.vc-titlecard` existing. That number excludes network — the real cost adds a 619 kB gzip download plus, from the browser log, `[main] precompile: 89 programs in 1399 ms`. A stranger on a mid-range laptop over a normal connection is looking at a solid dark rectangle for something like 8-20 s with no title, no logo, no spinner and no text. This also happens on every replay, because `src/main.js:724` `Bus.on('ui:resultsDone', () => location.reload())` re-pays the entire boot.

**Proposed fix:** Put static markup in `index.html`'s body — a centred `<div id="boot">` with the words "Valkyrie Chronicles" in the same serif stack and a one-line "Preparing the field…" plus a simple CSS-animated ink rule (no JS, no module, so it paints on first paint). Remove it from `src/main.js` at the point `titleScreen()` appends its root (main.js:606-608), fading it out over ~250 ms. Optionally publish coarse progress from the two known long phases (`new World(...)` in buildSystems and `precompilePlay`'s compileAsync) into its text.

**Acceptance test:** Load the built `dist/` from a static server with the network throttled to Fast 3G and DevTools' "disable cache" on. Readable text must be on screen within 1 s of navigation, and it must be gone (not merely covered) by the time the title card is interactive. Re-run the flow probe and confirm `document.body.innerText` is non-empty at t=500 ms.

### [blocker | small | verified] The Orders card hand is dealt open by default and covers the middle of the tactical map on the player's very first view of gameplay

**Location:** `src/ui/hud.js:291`

**Evidence:** `this.ordersOpen = true;` plus `src/ui/hud.js:2924` `this._toggleOrders(to === 'command')` means the six-card fan is spread every time command mode opens, without the player ever pressing Q. Verified in two independent play-mode renders at 1920x1080 (`ordersOpen: true`, classes `vc-orders open` / `vc-orders-tab open`): Caution / Resupply / Attack Boost / Demolition Boost / Enemy Recon / Direct Command occupy roughly x=150..1290, y=800..1000 — straight across the Vasel bridge, which is the objective the briefing just spent a paragraph on. At 1366x768 the leftmost card ('Caution') sits directly on top of Marina Wulfstan's roster card. Meanwhile a closed-looking "ORDERS  Q" tab sits in the bottom-left corner, so the UI simultaneously says the drawer is shut. Nothing in the game teaches Q as the way to clear it.

**Proposed fix:** Default `ordersOpen` to `false` at hud.js:291 and change hud.js:2924 to `if (to !== 'command') this._toggleOrders(false);` so leaving command mode still gathers the hand in but entering it does not deal it. The `vc-orders-tab` in the bottom-left already advertises Q, so the feature stays discoverable. If the dealt hand is wanted as a flourish, deal it once on the first entry to command mode and auto-gather it after ~2.5 s.

**Acceptance test:** Drive the front end to command mode and screenshot. No `.vc-card` may intersect the rect between the roster's right edge and the tactical survey's left edge, and `hud.ordersOpen` must be false until Q is pressed. Then press Q and confirm the six cards deal in.

### [major | small | verified] The in-game control legend is painted along the bottom of the title card, the chapter card and the briefing

**Location:** `src/ui/hud.js:1105`

**Evidence:** `_buildChrome()` appends the `.vc-legend` panel to the HUD root at construction and calls `setControls('command')` at hud.js:1109; nothing hides it for the front-end phases. In my play-mode render of the title screen the strip "Drag Pan Map | LMB Select Unit | Tab Next Soldier | Q Orders | Enter Sortie | E End Turn | Esc Pause" is clearly visible along the bottom edge, behind and below the "Valkyrie Chronicles" card. It is also present on the 390x844 phone-portrait boot. This is the first frame of the demo and it looks like the menu failed to cover the game.

**Proposed fix:** Add `this.legendEl.parentElement.classList.add('vc-hidden')` (or a `.vc-legend{opacity:0}` state) whenever no battle phase is live, and clear it in `_onBriefingDone`/`_onDeployed` (hud.js:3098-3099) and on the first `phase:change` into command/action. Simplest robust form: gate the legend panel on `this.phase` being one of command/action/aim/enemy, and start it hidden.

**Acceptance test:** Render the title card in play mode and confirm `.vc-legend` has zero visible height (`getBoundingClientRect().height === 0` or `offsetParent === null`), and that after reaching command mode it is back with the seven command keycaps.

### [major | small | verified] README.md and package.json still contain the user's raw prompt instead of a description of the demo

**Location:** `README.md:1`

**Evidence:** README.md is nine lines of "I want you to build a tactical role-playing game… Fan out sub-agents and have sub-agents tackle each one individually… /loop until it's utterly perfect. Fan out sub-agents and ultracode." `package.json:4` has the same prompt as its `description`, `author` is empty and `license` is the npm default "ISC". Anyone who follows the repo link from a published demo reads that first.

**Proposed fix:** Rewrite README.md as: what it is (a browser tactical RPG in the CANVAS watercolour style, one mission: The Bridge at Vasel), a screenshot, the controls table (mirror `LEGENDS` in src/ui/hud.js:225-245), how to run (`npm i && npm run dev`, `npm run build`), the tech (three.js r185, no other runtime deps, ~65k lines), browser requirements (WebGL2, desktop keyboard+mouse), and a fan-project/trademark note. Set `package.json` description/author/license to match.

**Acceptance test:** `head -30 README.md` contains no imperative addressed to an AI agent, contains a controls list, and contains a run command. `node -e "console.log(require('./package.json').description)"` no longer prints the prompt.

### [major | small | verified] A browser without WebGL gets a minified JavaScript stack trace as its error page

**Location:** `src/main.js:129`

**Evidence:** I stubbed `HTMLCanvasElement.prototype.getContext` to return null for webgl/webgl2 in a play-mode iframe of the built dist. `showFatal` rendered, full-screen, in monospace: "Valkyrie Chronicles — boot failed / Error: THREE.WebGLRenderer: Error creating WebGL context. / at new lg (http://…/assets/index-Cz6FhtD-.js:4108:23888) / at new wg (…) / at tB (…) … / capture=false shot=- quality=2 seed=20250728". That is a developer diagnostic shipped as the public failure page. There is no capability check before `new THREE.WebGLRenderer` (src/core/engine.js:8) and no `webglcontextlost` handler anywhere in src/.

**Proposed fix:** Before `buildSystems()`, probe `document.createElement('canvas').getContext('webgl2')`. If it is null, render a human page in the same paper/serif style: "This demo needs WebGL2. Try a recent Chrome, Edge, Firefox or Safari on a desktop machine, and check that hardware acceleration is enabled." Keep the stack trace behind `?debug`. Separately, split showFatal into a player message (top) and a `<details>`-collapsed stack, so a real crash mid-session also reads as a game and not a console dump.

**Acceptance test:** Re-run the getContext-nulling probe against dist and assert the visible text contains no "at new" frame and no ".js:" offset, and does contain the word WebGL2 and an actionable sentence. `?debug` must still show the stack.

### [major | small | verified] No favicon, no description meta, no social-card tags — the browser tab is a blank page icon and a shared link is a bare URL

**Location:** `index.html:6`

**Evidence:** `document.querySelectorAll('link')` on the running built page returns an empty array; the only metas are charset and viewport. `GET /favicon.ico` against the static dist returns 404. So the tab shows the generic document icon, and pasting the URL into Slack/Discord/Twitter produces no title card, no description and no preview image.

**Proposed fix:** Add to index.html head: an inline SVG-data-URI favicon (the red wax rank stamp or the Gallian shield from `src/ui/icons.js` would be on-brand and costs no extra request), `<meta name="description">`, `<meta name="theme-color" content="#17120e">`, and og:/twitter: title, description, image. For the image, commit one 1200x630 crop of a good plate (the `command` or `bridge` shot) into `public/` so vite copies it into dist, and reference it with an absolute URL.

**Acceptance test:** Load dist and confirm a non-default favicon renders in the tab; run any OG debugger (or just grep dist/index.html) and confirm og:title, og:description and og:image are present and og:image resolves 200 from the deployed host.

### [major | medium | verified] The command-mode HUD collides with itself below roughly 700 px of viewport height

**Location:** `src/ui/style.js:234`

**Evidence:** Measured at 1366x768 in play mode: root font is already clamped to its floor (13.30 px from `font-size:clamp(13px, 0.40vw + 1.02vh, 20px)`), the top-anchored roster spans y=128..641 (513 px tall, seven cards), the orders tab sits at y=708..736 and the order fan at y=534..702 — only 67 px of slack, and the leftmost order card already overlaps the sniper's roster card. At 1024x600 (verified by screenshot) it is a pile-up: Marina Wulfstan's card is clipped and sits underneath the "ORDERS Q" button, three order cards overlap the roster, "Direct Command" covers the Tactical Survey's "Gallian Staging Post" caption, and the legend wraps to two rows with the second row colliding with the End Turn ribbon. A maximised window on a 1366x768 laptop gives ~680 px of viewport, so this is a common case, not an edge case.

**Proposed fix:** Add a short-viewport media query beside the existing `@media (max-width:1400px)` block at style.js:1269: at `(max-height: 760px)` collapse the roster to a compact one-line-per-soldier form (portrait + name + AP bar, drop the second stat row), and at `(max-height: 700px)` force the order hand shut by default and move `.vc-orders-tab.open` clear of the roster. Also give `.vc-roster` a `max-height: calc(100vh - 14em); overflow: hidden` so it can never run under the bottom furniture.

**Acceptance test:** Render command mode at 1920x1080, 1366x768, 1280x720 and 1024x600. At every size, assert no `.vc-card`, `.vc-otab` or `.vc-legend` bounding box intersects any `.vc-ru` bounding box, and that the last roster card's `bottom` is above the orders tab's `top`.

### [major | medium | verified] On a phone the demo boots to a polished, tappable title screen and then has no input at all

**Location:** `src/core/input.js:18`

**Evidence:** `Input.attach` binds only keydown/keyup/mousemove/mousedown/mouseup/wheel/contextmenu/pointerlockchange — there is not one touch or pointer event in the file, and pointer lock (input.js:70) cannot exist on iOS at all. I booted the built dist in a 390x844 portrait frame: it renders, the title card lays out correctly and is readable, and "Open the Book" is a real clickable div, so a phone user will tap it and get in. From there command mode needs Drag/LMB/Tab/Q/Enter/E and action mode needs WASD + RMB-aim + LMB-fire. There is nothing to press. The demo looks like it works and then silently doesn't.

**Proposed fix:** Cheap and honest: on boot, if `matchMedia('(pointer: coarse)').matches` or there is no fine pointer, replace the title card's button with a paper card that says "This demo needs a keyboard and mouse. Open it on a desktop or laptop." plus a still image of the game, and skip building the battle entirely (which also avoids melting a phone GPU on 986k triangles). Do not ship half-working touch controls.

**Acceptance test:** Load dist in a 390x844 coarse-pointer emulation. The page must show the desktop-required card, must not enter deployment or command mode, and must not construct the World (assert `window.__ENGINE__` is undefined or `engine.battle` is null).

### [minor | small | likely] The first press of Esc in command mode closes the order hand instead of opening the pause menu the legend advertises

**Location:** `src/ui/hud.js:2049`

**Evidence:** `if (Input.pressed('escape') && !escSpent) { if (this.ordersOpen) this._toggleOrders(false); else … this._setPaused(...) }`. Because `ordersOpen` defaults to true (hud.js:291) and is re-opened on every entry to command mode (hud.js:2924), the hand is always open when the map first appears, so the player's first Esc is swallowed by a drawer they never opened — while the legend strip two lines below reads "Esc  Pause". I confirmed at runtime that Esc opens and closes the pause menu correctly once the hand is already shut; the ordering is the problem, not the pause menu.

**Proposed fix:** Fixing finding #2 (default the hand closed) removes the symptom. Belt and braces: reorder the branch so Esc always means Pause, and let Q alone gather the hand in — Esc-as-back-button is not carrying its weight here.

**Acceptance test:** From a fresh boot, reach command mode and press Esc exactly once. `hud.pause.visible` must be true and `engine.paused` must be true.

### [minor | small | verified] The keyboard-shortcut cap on every ribbon button is clipped by the ribbon's swallow-tail

**Location:** `src/ui/style.js:637`

**Evidence:** Cropped and enlarged from my own render of the results screen: the "Enter" cap on "Close the Book" has its right border and the final letter cut off by the ribbon's notched tail. The same clipping is visible on "Open the Book  [Enter]" on the title card and on "End Turn  [E]" in command mode. `.vc-rbtn-t` uses `justify-content:center` with `padding:0 1.5em .2em .7em`, but the SVG ribbon (240x58 viewBox, `width:100%`) loses roughly 12% of its right edge to the notch, which at w=15em is more than 1.5em.

**Proposed fix:** Widen the right padding at style.js:637 to about `2.6em` (keep the left at `.7em` so the asymmetry still centres the group over the flat body), or set `justify-content:flex-start` with a computed left inset. Check at the three widths in use: w=15 (title/results), w=16, and the End Turn button.

**Acceptance test:** Render title, results and command mode; in each, the `.vc-rbtn-t .vc-key` bounding box must sit entirely inside the ribbon's flat rectangle (i.e. its right edge at least 8% of the button width clear of the button's right edge).

### [minor | medium | verified] Two giant tree canopies sit dead-centre of the tactical map and hide the objective and half the enemy positions

**Location:** `src/game/commandMode.js:1`

**Evidence:** In my play-mode render of command mode at both 1920x1080 and 1366x768, two full-density tree crowns fill the middle of the overhead view; four of the six visible enemy blips float over foliage with no readable ground under them, and the bridge deck is partly hidden. The real game's command view is a clean, legible plan of the terrain — this is the screen the player spends most of their turn on, and it is the one that most needs to read as a map.

**Proposed fix:** In command mode, fade foliage/canopy materials that lie between the map camera and the ground to low opacity (or drop the top LOD entirely) while `commandMode.active`. There is already a per-mode hook set — `Bus.on('phase:change')` — and `World.update(dt, camera)` already owns the foliage LOD, so this is a mode flag threaded into the foliage material's opacity rather than new machinery. I did not locate the exact foliage-opacity site, so treat the line number as the module, not the statement.

**Acceptance test:** Render command mode. Every friendly and enemy blip must have visible terrain (not canopy) directly beneath its stem, and the bridge deck must be unobstructed from the staging post to the far bank.

### [minor | small | verified] Every page load prints a three.js deprecation warning and three Canvas2D performance warnings to the console

**Location:** `src/core/engine.js:33`

**Evidence:** From the browser log of a clean dist load: `"THREE.Clock: This module has been deprecated. Please use THREE.Timer instead."` (twice, once per context) and `"Canvas2D: Multiple readback operations using getImageData are faster with the willReadFrequently attribute set to true"` three times. Source of the first is `this.clock = new THREE.Clock()` at engine.js:33; the second comes from the procedural texture bakers that call `getImageData` on a 2D context created without the hint (src/world/textures.js:33, :63, :372, :497; src/world/worldMaterials.js:768, :869; src/render/textures.js:517). Nobody will die of it, but the first thing a curious player or a hiring manager does with a browser demo is open DevTools.

**Proposed fix:** Pass `{ willReadFrequently: true }` to the `getContext('2d')` calls that are followed by `getImageData` in those seven sites. For the Clock warning, either migrate to `THREE.Timer` or keep `Clock` and accept it — but note main.js's determinism contract overrides `clock.getDelta`, so a migration must preserve that hook exactly (see the CAPTURE_DT comments in src/main.js:50-100).

**Acceptance test:** Load dist with a console listener attached and assert zero messages of type warning/info from the app before the title card appears.

### [minor | small | verified] The build hardcodes absolute /assets/ paths, so dist only works when served from a domain root

**Location:** `vite.config.js:1`

**Evidence:** `vite.config.js` sets no `base`, so dist/index.html emits `<script type="module" crossorigin src="/assets/index-Cz6FhtD-.js">`. Serving dist from a root static server works (verified, 200 on both / and /assets/…). Serving it from any sub-path — a GitHub Pages project site, a preview under /demo/, an S3 prefix — 404s the only script and the page stays a dark rectangle forever with no error. There is a configured Vercel project (.vercel/project.json, framework vite, root deploy) so the currently-planned deploy is fine; this is one line of insurance against the next one.

**Proposed fix:** Add `base: './'` to vite.config.js. Everything the game loads is bundled or generated in JS, so there are no other absolute asset URLs to chase.

**Acceptance test:** `npx vite build` then serve dist from a sub-path (e.g. `python3 -m http.server` in a parent dir and load `/dist/`). The title card must appear and the console must be clean.

### [minor | small | verified] No credits, no fan-project disclaimer, and nothing anywhere identifies who made this or what it is not

**Location:** `src/main.js:585`

**Evidence:** The title card reads "Gallian Militia · Squad 7 / Valkyrie Chronicles / A record of the Second Europan War…" and then a single button. There is no author, no "built with three.js", no link, and no note distinguishing this from Sega's Valkyria Chronicles — whose character names (Alicia Melchiott, Welkin, Rosie, Largo, Isara, Edy, Marina), tank (Edelweiss), factions and art style it reproduces directly. For a publicly linked demo that is both a courtesy gap and a small legal one.

**Proposed fix:** Add a third line under the subtitle on the title card, small and in the label style: "A fan-made technical demo · not affiliated with SEGA · built in three.js by <name>" with the repo link as a `clickable` anchor. Repeat the one-liner in the README.

**Acceptance test:** Render the title card and confirm the disclaimer line is present and legible at 1366x768, and that the repo link opens in a new tab without stealing the Enter binding.
