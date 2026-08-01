# r25 audit — aimhud

**Verdict:** needs-work

## Summary
It is (a) a capture-harness defect, and I have the root cause verified in-page. The COLD render of `aim` has the full sight picture — crosshair on centre, dispersion brackets, 99% Hit chit, the r24 damage table (TO KILL 02 / SHOTS 05 / ○ × ×) and the Imperial dossier. The RESIDENT (fast) path renders the identical shot with the entire `.vc-tgt` layer at computed opacity 0, which is exactly the frame in `shots/aim.png` that the concern was written from. Cause: `main.js:958-961` appends a permanent `<style>` that sets `animation-play-state:paused` on everything under `#hud`; the daemon re-poses the same page forever, so when `resetShotState()` drops `.on` and the shot re-adds it, `vc-sight` restarts and can never play — I measured `playState:"paused", currentTime:0, startTime:null` and its `from` keyframe is `opacity:0`. Calling `document.getAnimations().forEach(a=>a.finish())` before the shutter restores it to opacity 1 (measured). A played build never runs `captureFlow()`, so gameplay is unaffected — this is not a shipping blocker, it is a review-loop blocker of exactly the round-15 class, and it already cost this round one agent's review. Separately and genuinely wrong in the picture: the damage table is 232 px right of centre, the over-the-shoulder framing is not over-the-shoulder at all (the shooter's head projects at x=1917 of 1920 and her body is off-screen), and the reticle is dark ink where the real game's is saturated orange. NOTE: the shared daemon on port 5200 is dead (page closed, /health still says ok) — I could not use the fast path through it and started one on 5201 instead; kill 5200 to unblock everyone.

## Do not touch (verified good)
The aim-line geometry is correct and must not be touched. I measured the lock and the horizontal crosshair-to-target offset at 3 / 6 / 12 / 25 / 40 m: dx = 16, 2, 0, 0, 0 px, with `am.aimTarget` acquired at every range. r23's convergence fix (`actionMode.js:1251-1265`) genuinely killed the r22 shoulder-parallax inversion, and it does so in a way that is independent of arm length, shoulder offset and fov — the AIM branch aims `camLook` at `pivot + fwd*convergeDist` with a zero lateral term. Do not re-derive it. The damage table's content is right too: real numbers, correct shooter-vs-target weapon profile, ruled cells, ○/× glyphs, red "to kill" numeral — it is a dead ringer for vc-088's table apart from where it sits. The cold `aim` plate's HUD as a whole (dossier with body diagram and aim point, ammo panel with ZM Kar 8 / reaches 46 m, control strip) is the best HUD work in the project.

## Findings

### [blocker | small | verified] Resident render path renders the ENTIRE aim overlay at opacity 0 — every fast-path `aim` plate is a lie

**Location:** `src/main.js:958`

**Evidence:** I rendered `aim` both ways myself. Cold (`shoot.mjs --cold aim`): crosshair, brackets, accuracy ring, 99% Hit chit, target dossier and the damage table all present. Resident (fresh daemon, sequence overview,command,action,aim): none of them, and the frame matches `shots/aim.png` byte-for-eye — that is the plate the concern was written from. Root cause verified in-page with tools/probe.mjs: after a resident re-pose, `hud.tgtLayer` is `class="vc-tgt on"` with `hud.aiming=true`, `hud._aimActive=true`, `reticlePx=27.6`, `aimTarget=Imperial Sturmtruppe` — yet `getComputedStyle(tgtLayer).opacity === "0"` and `transform: matrix(1.055,…)`, i.e. pinned to the `from` keyframe of `vc-sight`. `tgtLayer.getAnimations()` returns `{name:'vc-sight', playState:'paused', currentTime:0, startTime:null}` and it is still exactly that after 24 rAF frames AND after a further 600 ms of wall clock. The freeze `<style>` appended at main.js:958-961 (`#hud *{animation-play-state:paused!important}`) is created once at the end of captureFlow and never removed; the daemon re-poses the same page for every subsequent shot, so any HUD entrance animation restarted after that point is frozen at t=0 — and `style.js:831` starts `vc-sight` at `opacity:0`. The damage table, the hit chit, the dossier and the crosshair are all children of `.vc-tgt` (hud.js:952/960/964/998/1021), so one paused animation deletes the whole sight picture. Both candidate fixes measured in the same probe: `document.getAnimations().forEach(a=>a.finish())` → opacity "1"; removing the freeze style before the re-pose → opacity "1".

**Proposed fix:** In `tools/renderd.mjs` IN_PAGE_RUN, immediately after the finale loop and BEFORE the `getDelta`/`paused` restore at lines 223-224, insert:
  `document.getAnimations().forEach((a) => { try { a.finish(); } catch {} });`
  `await raf();`
Finishing rather than un-pausing is the deterministic choice: it lands every entrance animation on its end state, which is exactly where a cold boot's >1 s settle lands a 0.22 s animation, so the fast path converges to cold instead of diverging from it. Infinite animations throw on finish() and stay paused, which is today's behaviour — hence the try/catch. Belt-and-braces in `src/ui/style.js:831`: drop `opacity:0` from the `from` step of `@keyframes vc-sight` (keep `transform:scale(1.055); filter:blur(2.4px)`) so a paused sight picture can never be an invisible one — `.vc-tgt.on` already declares `opacity:1` at :829. Do NOT 'fix' this by deleting the freeze style from main.js; main.js:938-955 documents why it exists.

**Acceptance test:** `node tools/shoot.mjs --port <fresh> overview,command,action,aim --out /tmp/x` then Read /tmp/x/aim.png: the crosshair, the accuracy ring, the 99% Hit chit, the Imperial dossier and the top damage table must all be present, matching `node tools/shoot.mjs --cold aim`. Stronger, scriptable: `node tools/probe.mjs aim <script>` where the script re-runs `runShot('aim')` the way renderd does and asserts `getComputedStyle(vc.hud.tgtLayer).opacity === '1'`.

### [major | medium | verified] Aim camera is not over-the-shoulder: the shooter's body is entirely off-frame

**Location:** `src/game/captureShots.js:1074`

**Evidence:** Probed the live `aim` shot and projected the shooter to screen: `headPoint` lands at (1917, 586) on a 1920x1080 frame — 3 px from the right edge — and `centerPoint` at (1990, 1542), i.e. off-screen in both axes. Camera state: fov 17.89°, armLength 1.45 m, shoulder 0.46 m. Cropping the cold plate at (1220,600)+700x480 shows what is actually in frame: a formless pale-teal smear at the right margin that cannot be read as a person, let alone as Alicia — and it sits inside the P5 drawing falloff's drained margin, so the one character the shot is about is the one thing the grade erases. docs/reference/vc-088.jpg puts Alicia in the LEFT third from mid-torso up, head about 25% of frame height, fully saturated, with the target at dead centre. A 17.9° lens 1.45 m behind a crouched soldier's chest cannot see her; VC's over-the-shoulder is a normal ~30-35° lens (its magnification is the scope view, a separate mode).

**Proposed fix:** Fix it SHOT-LOCALLY first — zero gameplay risk. `captureShots.js:1074` already snaps `am.fov = am.fovTarget; am.armLength = am.armTarget; am.shoulder = am.shoulderTarget` inside the 30-frame settle loop, so set the targets just after `am.enterAim()` (line 1070): `am.fovTarget = 30; am.armTarget = 1.05; am.shoulderTarget = 0.85;` and iterate on those three numbers against vc-088 until the head projects near (0.30W, 0.45H). The aim line survives because `actionMode.updateCamera()` recomputes `camLook = pivot + fwd*convergeDist` with a ZERO lateral term in AIM mode (actionMode.js:1257-1265) — the convergence that cured r22's inversion is a function of the aim focus distance only, not of arm/shoulder/fov, so none of those three can reintroduce the parallax. Only touch `actionMode.js:664-666` (the gameplay defaults) as a second, separate step, gated on the probe below.

**Acceptance test:** Two gates, both runnable. (1) Framing: probe the shot and assert `shooter.headPoint` projects inside x∈[0.20W,0.42W], y∈[0.35H,0.60H], then put the cold `aim` plate beside docs/reference/vc-088.jpg — the shooter must read as a specific person, not a smear. (2) Aim line, non-negotiable: re-run my probe (scratchpad/aimaudit/probe3.js) which walks the target to 3/6/12/25/40 m along the camera yaw and reports `dxFromCentre` and whether `am.aimTarget` locked. Baseline today is dx = 16, 2, 0, 0, 0 px with a lock at all five ranges; the change is only allowed to ship if it still measures |dx| ≤ 8 px and locks at all five.

### [major | small | verified] Damage table is 232 px right of centre — `left:50%` never gets its `translateX(-50%)`

**Location:** `src/ui/style.js:850`

**Evidence:** Measured `hud.dmgPanel.getBoundingClientRect()` in the page: x=960, w=465 on a 1920-wide frame, so the table spans 960→1425 and its centre sits at 1192 px instead of 960 — a 232 px offset, plainly visible as an off-centre table in my own cold `aim` plate. Computed transform is `matrix(0.999997, 0.00261799, -0.00261799, 0.999997, 0, 0)`: a pure 0.2° rotation with ZERO translation. `panel()` writes an inline `root.style.transform = 'rotate(Ndeg)'` at src/ui/dom.js:85, and an inline style beats the stylesheet, so the `transform:translateX(-50%)` on style.js:850 is dead code. vc-088 centres the table on the frame.

**Proposed fix:** Centre it without using `transform`, since the panel helper owns that property: `.vc-dmg{ position:absolute; left:0; right:0; top:1.6em; margin:0 auto; width:max-content; padding:.16em .18em .2em; }` (drop `left:50%` and the transform). `translate:-50% 0` (the standalone CSS property, which composes independently of `transform`) also works if you prefer to keep `left:50%`.

**Acceptance test:** In a probe: `const r = vc.hud.dmgPanel.getBoundingClientRect(); Math.abs(r.x + r.width/2 - innerWidth/2) <= 4`. Then render `--cold aim` and check the table is centred over the frame like vc-088's.

### [major | small | verified] Reticle is dark ink where the real game's is saturated orange — it disappears into the scene

**Location:** `src/ui/icons.js:391`

**Evidence:** In my own cold `aim` plate the crosshair is legible only when you crop and zoom: thin `#2b211a`/`#f0e1bd` hairlines (SIGHT_INK/SIGHT_CHALK, used at icons.js:437-443 for the cross and :454-460 for the accuracy ring) drawn over a mid-value plaster wall, with the accuracy ring at 3.4/1.5 px stroke. At full size the frame reads as 'a soldier standing in front of a house', which is precisely what the concern reported. docs/reference/vc-088.jpg puts a saturated orange ring with tick marks on the target — it is the strongest chroma anywhere in that frame and it is the single element that says 'this is a targeting mode'. Our overall plate saturation is now on the reference (sat 0.212 vs 0.191) precisely because everything, including the reticle, is desaturated together.

**Proposed fix:** Give the sight picture its own accent, separate from the paper-ink palette: add `const SIGHT_ACCENT = '#e07a1f'` (vc-088's ring reads ~#e8801f warm orange over #d4541c shadow) and use it for the accuracy-ring stroke (icons.js:454, and raise its width ~3.4 → 4.2), the crosshair's centre splat (icons.js:441) and the tick marks. Leave the crosshair ARMS as ink — VC's are a fine dark cross — so the change is an accent, not a repaint. Do not desaturate it in the grade: the reticle is DOM, above the canvas, so the drawing falloff cannot touch it.

**Acceptance test:** Render `--cold aim`, crop the centre 600x600 and Read it: the ring must be identifiable as a targeting reticle at a glance in the full-size frame, not only when zoomed. Put it beside vc-088 — the reticle should be the same order of visual weight relative to its scene.

### [minor | small | verified] `.vc-dmg` is declared twice for two unrelated widgets — a latent trap for whoever centres the table

**Location:** `src/ui/style.js:987`

**Evidence:** `.vc-dmg` at style.js:849 is the r24 HUD damage table (created at hud.js:1007). `.vc-dmg` at style.js:987 — `transform:translate(-50%,-50%); z-index:3` — belongs to the floating world-space damage NUMBER (created at src/ui/worldLabels.js:430 as `class="vc-wl vc-dmg"`). Same specificity, later rule wins, so the table currently inherits `translate(-50%,-50%)` and `z-index:3`, and the world number inherits `position:absolute; left:50%; top:1.6em` from :849. Today the collision is masked by panel()'s inline transform (see the centring finding) — which means the moment someone removes that inline transform to centre the table, the table jumps half its height upward and clips off the top of the frame.

**Proposed fix:** Rename the HUD table's class to something unshared — `vc-dmgtable` — at hud.js:1007 and style.js:849/853/854/858/859/864/865, leaving `.vc-dmg` to worldLabels.js. Cheap, mechanical, and it removes the trap before the centring fix trips it.

**Acceptance test:** `grep -n 'vc-dmg\b' src/ui/*.js` returns the world-label widget only. Render `--cold aim` (table still correct) and a shot that shows floating damage numbers, e.g. `--cold firefight` (numbers still correct).

### [major | medium | verified] The shared render daemon on port 5200 is dead but reports healthy, so every agent's fast path fails

**Location:** `tools/renderd.mjs:366`

**Evidence:** `node tools/shoot.mjs aim …` fails with `page.evaluate: Target page, context or browser has been closed` at renderd.mjs:346, repeatedly. The daemon process is alive (pid 29194) and `curl /health` returns `{"ok":true,"served":24,…}`, so `shoot.mjs`'s `ensureDaemon()` sees the port open, never restarts it, and every fast-path render in this session errors out. The chromium page has crashed under the daemon. I worked around it by starting a daemon on port 5201 (`--port 5201`), which rendered fine — so this is the daemon's page, not the machine or the code.

**Proposed fix:** Two parts. (1) `/health` (renderd.mjs:366) must actually probe the page — `await page.evaluate(() => 1)` inside a try — and report `ok:false` when it throws. (2) In `doShoot`, catch a closed-page/closed-browser error once and re-launch the browser + re-goto (the same path `reloadIfStale()` already uses) before failing the request; a crashed page is recoverable and costs one 7 s boot, versus every agent in the round silently losing the fast path. Housekeeping for this session: kill pid 29194 (I was told not to run `--stop`, so I left it), and kill the 5201 daemon I started once nobody needs it.

**Acceptance test:** With a deliberately closed page (`page.close()` via a debug hook, or just after a crash), `curl 127.0.0.1:5200/health` returns `ok:false`, and `node tools/shoot.mjs bridge` succeeds by re-launching instead of erroring.

### [minor | medium | likely] At close range the crosshair sits ~650 px below the target's centre — worth one look, not a claim

**Location:** `src/game/actionMode.js:1264`

**Evidence:** Same probe as the framing finding. Horizontal alignment is perfect, but vertically the target's `centerPoint` projects at dy = -651, -344, -137, -11, +36 px from screen centre at 3, 6, 12, 25 and 40 m. At 3 m the man's chest is more than half a screen above the crosshair. The lock still acquired him at every range (screen-space magnetism, actionMode.js:688-708), so this is not the r22 inversion returning and I did not measure any hit-rate consequence — but a player at 3 m sees his crosshair on the dirt in front of a man he is locked onto, which is the kind of thing that reads as 'the aiming is broken'. It is a consequence of the shot's fixed `camPitch = 0.035` (captureShots.js:1069) against a crouched pivot, so part of it may be shot-specific staging rather than gameplay.

**Proposed fix:** Before changing anything, reproduce it in free play rather than in the posed shot: drive `enterAim()` at 3 m with the player's own look pitch and see whether the offset persists. If it does, the candidate is to converge the LOOK point on the aim focus's actual height rather than on `pivot + fwd*convergeDist` (actionMode.js:1264) when `aimFocusIsMan` — but that touches the exact math that fixed r22, so it needs the 5-range probe as its gate and is not worth doing for the demo plate.

**Acceptance test:** scratchpad/aimaudit/probe3.js extended to report `dyFromCentre` against the target's chest: |dy| ≤ 120 px at 3 m and beyond, with `am.aimTarget` still locked and |dx| ≤ 8 px at all of 3/6/12/25/40 m.
