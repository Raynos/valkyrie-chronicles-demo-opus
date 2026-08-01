# r25 VERDICT — stranger

**Verdict:** REJECT  ·  **Publishable:** false

## Summary
One CSS bug stands between this and publishable, and it sits on the second screen a stranger sees: on the briefing sheet the "Begin Mission" ribbon and its "press Enter — moving out in N s" hint render BELOW the viewport at every size I measured — 1280x720, 1366x660, 1440x810 and 1920x1080 (button top 1085 px against a 1080 px viewport) — while the squad-roll portraits hang off the bottom deckled edge of the paper. The demo's single most important call to action is invisible, its rescue timer is invisible, and the sheet looks broken. Everything around that is genuinely strong and should not be touched: first contentful paint at 68 ms with a hand-set boot card on screen at 56 ms and the title at 4.7 s; zero console errors, zero failed requests and zero 4xx across a full first-run walkthrough; dist/ served from a sub-path (/demo/) made exactly two requests, both relative, and worked; a real results screen for both win and lose with an A/D rank stamp, a full ledger and a named casualty list; and two "you cannot play this here" gates (touch-only, no WebGL2) that render an in-voice message card instead of a stack trace or a black screen. The book chrome — boot card, title, chapter, briefing content, deployment, pause, results — is production-grade and is the best thing in the project. The second real problem is the cast: in three independently rendered frames a squadmate renders flesh-pink from shoulder to hip with no tunic, and the village foreground soldier's face is a semi-transparent decal you can see the helmet brim and the ground through. In a game whose identity is Alicia and Squad 7, that is the tell in every close shot. Fix the briefing overflow and the two character-material defects and I would ship this without hesitation; nothing else I found is a blocker.

## Best thing (do not touch)
The illustrated field-journal UI, end to end, and the fact that it is honest at every boundary. The briefing sheet — contour theatre map with a compass rose, objective glyphs, six lines of intel written as a person would write them, drawn squad portraits — is the single most Valkyria-looking artefact in the build, and the same hand carries through the wax rank stamp, the red ribbon buttons with drawn keycaps, and the deckled paper edges. Underneath it, the engineering is equally good: FCP 68 ms because the boot card is static markup with inline CSS, `base: './'` so a sub-path host works, an inline SVG favicon so there is no 404 in the tab, and refusal screens for phones and no-WebGL2 machines written in the game's own voice.

## Explicitly protected
- The whole book-chrome system in src/ui/ — screens.js (chapter card, briefing content, deployment, pause, results), icons.js (ink rules, ribbons, rank stamp, keycaps, compass rose, contour terrain sketch), portraits.js (the drawn squad portraits) and style.js. This is the reason the demo is worth publishing at all. Fix the briefing's height budget and nothing else in it.
- index.html's static boot card and the handover in main.js: bootDismiss() is called at the moment the title card mounts, so there is never a frame with neither on screen. Measured 56 ms to a legible card and 68 ms FCP on the production bundle. The comment block explaining why is worth keeping too.
- The two refusal gates in main.js — needsDesktop() and hasWebGL2() into bootMessage(). Both verified: a touch-only iPhone context gets "This demo needs a keyboard and a mouse" and a getContext('webgl2')-nulled context gets "This demo needs WebGL2", both in the game's typeface, both with zero page errors and no black screen. This is better failure handling than most shipped web games.
- vite.config.js `base: './'`. Verified end to end: dist/ served from /demo/ made exactly two requests (/demo/ and /demo/assets/index-D8NCC_ft.js), zero 404s, zero requestfailed. The bundle contains no fetch(), no new URL(), and no absolute /assets or /src string literal.
- The metadata block in index.html — title, description, theme-color, the inline SVG wax-seal favicon, and the OG/Twitter card pair. og.jpg is a genuine 1200x630 and is a good plate. Only the relative og:image URL is worth revisiting (see caveats).
- The bottom-of-screen controls legend in both command and action mode, and the deployment sheet's "Your squad is already posted — press Enter to move out" copy. Between them these are the only reason a keyboard-only stranger can reach the field at all, and screens.js documents at length what it cost to learn that.
- The `overview` and `bridge` compositions, the stone bridge ashlar and its three arches, the half-timbered farmhouse frontage, the terracotta pantile roofs, the windmill on the skyline, and the sandbag coursing. r25's own audit lists these as verified-good and my independent cold renders agree.

## Blockers (3)

### The briefing screen's "Begin Mission" ribbon and its "press Enter — moving out in N s" countdown hint render below the bottom of the viewport at EVERY size tested, including 1920x1080. Measured: button rect top 1085 px / bottom 1152 px against innerHeight 1080; at 1440x810 it is top 816 against 810; at 1280x720, top 756. The squad-roll chips also overflow past the paper's own deckled bottom edge (panel bottom 1015, chips continuing below it). A stranger reaches the second full screen of the demo, sees no button and no prompt, and has no way to learn that Enter continues. The 20 s auto-advance saves the session but is itself printed on the invisible line.

**Where:** `src/ui/screens.js — BriefingScreen.show(), the `.vc-page-in` column it appends `.vc-btnrow` to; the `panel()` paper is sized independently of its content so content simply runs past it. Reproduced on the production bundle in dist/.`

**Fix:** Give the briefing sheet a height budget instead of letting content set it: cap `.vc-page-in` at ~84vh, make the two-column body the flexible region (`min-height:0; overflow:auto`), and pin `.vc-btnrow` as a non-shrinking footer inside the paper. Then cap `.vc-squad` in the briefing to a single wrapping row with its own scroll. Verify by asserting `sheet.querySelector('.vc-rbtn').getBoundingClientRect().bottom <= innerHeight` at 1280x720, 1366x660, 1440x810 and 1920x1080 — all four fail today. The deployment sheet already passes this test (button bottom 630 at vh 810), so the fix is briefing-local.

**Effort:** ~30 min including the four-size re-check

### Close-range characters are visibly broken, not merely stylised. (a) One squad member renders flesh-pink from shoulders to hips with no tunic — brown straps over bare skin, a stray blue/gold patch at the belt, stray teal on the shins — reproduced in three independently rendered frames (`overview`, and two live-play frames from the dist walkthrough). (b) The `village` foreground soldier's face is a semi-transparent decal: the helmet brim and the terrain behind the jaw read THROUGH the face, and a smeared moustache-shaped artefact crosses the mouth. (c) In `aim`, the over-the-shoulder shooter is an untextured brown/salmon mass filling the lower-left third with no discernible head, collar, shoulder or weapon. The aim frame is the one people screenshot when they share a shooter.

**Where:** `src/actors/rig.js / src/actors/character.js for the missing torso material on that unit; the face decal's blend/depth state in src/render/materials.js (a face plane that shows geometry behind it is a depthWrite / renderOrder fault, not an art choice).`

**Fix:** Two bounded fixes, not a rig rewrite. (1) Find the squad member whose torso resolves to skin albedo and give it the uniform material the other five get — bisect by logging each unit's torso material name at build time; the neighbouring figures in the same frame render correct olive and teal, so the rig is fine and one assignment is not. (2) Set the face decal opaque with depthWrite:true and a renderOrder above the skull, and re-render `village` and `closeup` to confirm the helmet brim occludes the face instead of showing through it. Do NOT re-pose the aim camera to hide (c) — finish_plan.md P6f records that actionMode.updateCamera()/CONVERGE_* is what r23 rewrote to cure the close-range aim inversion, and moving it can silently reintroduce a gameplay bug.

**Effort:** half a day, and it wants the person who owns rig.js

### Class labels overrun their cards on three separate screens. "SHOCKTROOPER" spills past the right edge of Rosie Stark's chip on the briefing sheet, past the same chip on the deployment sheet, and past her row in the command-map roster panel. In the deployment camp slots, names truncate to "Alicia Melc…" and "Marina Wul…". It is cosmetic, but it is on the two screens whose whole job is to look hand-set, and it is the first thing an eye lands on.

**Where:** `src/ui/screens.js — squadChip(), fixed `width: size + 'em'` (6.4em on the roster, 5.0em in camp slots) with the class label at `font-size:.52em` and no fitting rule; and the roster row in src/ui/hud.js.`

**Fix:** Fit the label to the box rather than the box to nothing: set the class line to `font-size: clamp(.40em, .52em, 1em)` with `letter-spacing:0` and `white-space:nowrap` plus a JS shrink-to-fit pass (compare scrollWidth to clientWidth once after mount and scale the font down), or widen the chip to 7.4em/5.8em. "Shocktrooper" is the longest string in CLASS_NAME, so sizing to it fixes every case.

**Effort:** ~15 min

## Blind test, per shot

### boot card / first paint — dist served from a sub-path (/demo/) — would pick as real: **the real game**

**The tell:** The progress element is a CSS `transition: width` bar and the type is a web font stack — VC's own load screens are a drawn page corner turning, never a horizontal meter. Also, a 4% bar that then sits still for four seconds is a web loading pattern, not a console one.

**Scores:** firstRunClarity 9 · load 10 · outcomes 0 · robustness 10 · textPolish 9 · shareability 8

**Worst axis:** shareability

_A dark warm-brown page. Small-caps letterspaced "GALLIAN MILITIA · SQUAD 7", an italic serif "Valkyrie Chronicles", a thin red rule that animates itself in, "The Bridge at Vasel", a gold progress bar at 4%, "PREPARING THE FIELD…", and one small line: "A fan-made technical demo built in three.js · not affiliated with SEGA". On screen at 56 ms; first-contentful-paint 68 ms; title card at 4715 ms._

### title card — would pick as real: **the real game**

**The tell:** The scrim behind the sheet greys the orbiting valley into a flat desaturated murk — the watercolour palette the whole project exists to produce is the one thing you cannot see on the title screen. VC puts its title over a full-chroma plate. Second tell: the card never says what genre this is; "A record of the Second Europan War" is atmosphere, not a pitch.

**Scores:** firstRunClarity 7 · load 10 · outcomes 0 · robustness 10 · textPolish 9 · shareability 9

**Worst axis:** firstRunClarity

_A cream deckled sheet tilted a couple of degrees over a slow orbit of the valley. "GALLIAN MILITIA · SQUAD 7", "Valkyrie Chronicles" in italic serif, two lines of flavour, a red ribbon reading "Open the Book" with an ENTER keycap drawn on it, and a colophon: fan-made / not affiliated with SEGA / Built in three.js by Jake Verbaten / Source on GitHub (a real target=_blank link)._

### briefing sheet (1920x1080, production bundle) — would pick as real: **genuinely could not tell**

**The tell:** The layout bug is the tell and it is decisive: the squad chips overrun the bottom of their own sheet and the "Begin Mission" ribbon is 5 px below a 1080 px viewport. On content alone I could not tell this from a real VC briefing — it is that good — which is exactly why the overflow is so damaging.

**Scores:** firstRunClarity 2 · load 10 · outcomes 0 · robustness 8 · textPolish 4 · shareability 7

**Worst axis:** firstRunClarity

_A full-bleed cream sheet. Left: "THEATRE MAP" — a drawn contour survey with a blue river, a dashed road, two flag pins and a compass rose — under four lines of mission prose. Right: four objectives with hand-drawn glyphs, six lines of "INTELLIGENCE", and a "SQUAD ROLL" of six drawn portraits. The bottom two portraits hang past the paper's deckled edge. There is no visible button and no visible prompt._

### command map (tactical HUD), cold render — would pick as real: **the real game**

**The tell:** The unit markers are flat 2D paper standees, and they are scaled roughly 3x too large against the world — a soldier on the bridge is taller than the parapet is thick and reads as a sticker laid on the plate rather than a figure standing in it. Second tell: "SHOCKTROOPER" runs off the right edge of Rosie Stark's roster card, and two red damage numerals (61, 34) float over open ground with nothing under them.

**Scores:** linework 8 · banding 7 · temperature 8 · paper 8 · palette 8 · composition 8 · hud 9 · wow 8

**Worst axis:** banding

_Isometric view of the bridge and the river. Left column: command-point pips, a six-soldier roster with drawn portraits, class, HP bars and march range. Top right: objectives on a cream card. Bottom right: a "TACTICAL SURVEY" contour minimap with red and blue arrowheads. Bottom centre: six order cards (Caution, Resupply, Attack Boost, Demolition Boost, Enemy Recon, Direct Command) with CP costs. Bottom edge: a full key legend. A red "END TURN" ribbon._

### overview (action mode), cold plate — artstats: sat 0.241 · centre/edge 1.73 · satE 0.173 · p1 46 · p50 140 · p99 238 · range 192 · ink 4.37% — would pick as real: **genuinely could not tell**

**The tell:** The sky is one flat paper-white with no gradient, no cloud and no cool wash — the horizon is simply where the drawing stops. Measured against the reference the frame is also over-saturated and over-inked (sat 0.241 vs the real game's 0.19; ink 4.37% vs 1.8–2.8%) and has no true darks (p1 46 vs 32–33), though p99 238 is now nearly on target and the centre/edge ratio 1.73 is squarely in range. Third tell: two red damage numerals sit over empty terrain with no unit beneath them.

**Scores:** linework 8 · banding 7 · temperature 8 · paper 9 · palette 7 · form 4 · composition 9 · materials 7 · atmosphere 6 · wow 8

**Worst axis:** form

_A three-arch stone bridge over a green river, a terraced bank, half-timbered farmhouses with terracotta roofs on the ridge, trees framing left and right, three squad members on the near path with name banners. Deckled paper margin all round. HUD: unit card bottom-left, ammunition bottom-right, key legend along the bottom._

### aim / over-the-shoulder — would pick as real: **the real game**

**The tell:** The shooter has no readable silhouette at all — no head, no collar, no shoulder line, no weapon; a pink lobe sits on top of a brown slab on a teal jacket, and the arm resolves into a flat wing-shaped plane. VC's over-the-shoulder shot is the single most recognisable image in the game and it is built entirely on the shooter's readable silhouette. Whatever else is right here, this frame gives itself away in one glance.

**Scores:** linework 7 · banding 6 · temperature 8 · paper 8 · palette 7 · form 2 · composition 4 · materials 6 · atmosphere 5 · hud 9 · wow 3

**Worst axis:** form

_Looking down a wooden bridge deck at two Imperial-held buildings. Top centre: a TO KILL / SHOTS / VS PERS / VS ARMOR / AREA table. Right: an "IMPERIAL STURMTRUPPE" target card with class, health, distance, aim point and a body diagram. Centre: an orange reticle with an 84% HIT dial. Lower left third: the shooter, rendered as a large brown-and-salmon mass._

### village (street level) — would pick as real: **the real game**

**The tell:** The foreground soldier's face is a semi-transparent decal — you can see the helmet brim and the ground behind his jaw straight through it — with a smeared moustache-shaped artefact across the mouth and a green tube of a neck swallowing the chin. Secondary: the top third of frame is a blank white void with nothing in it, and the sandbags/rock pile read as faceted low-poly potatoes.

**Scores:** linework 8 · banding 6 · temperature 8 · paper 8 · palette 7 · form 3 · composition 5 · materials 6 · atmosphere 5 · wow 4

**Worst axis:** form

_A dirt square between half-timbered houses with terracotta roofs, a picket fence, a sandbag heap, a stone wall, telegraph poles, enemy name banners over three Imperials, and a Gallian soldier in the near right foreground. A red circle marked "IMPERIAL" is half cut off at the right edge._

### results — win (rank A) and lose (rank D), both raised through the game's own mission:end event on the production bundle — would pick as real: **genuinely could not tell**

**The tell:** The rank letter is set in the page's body serif inside a clean vector ring. A real VC rank stamp is a struck rubber stamp: off-register, ink pooled at the edges, the letter broken where the pad missed. Ours is a circle with a letter in it. Everything else about this screen reads correctly.

**Scores:** firstRunClarity 9 · load 10 · outcomes 9 · robustness 10 · textPolish 9 · shareability 9

**Worst axis:** outcomes

_A cream sheet. "MISSION REPORT — SUCCESS" / "The Field is Ours" (or "— WITHDRAWAL" / "A Costly Retreat"). Left: a wax-seal rank ring with a large serif A (red) or D (grey), captioned "Evaluation". Right: a ruled ledger — Turns Used, Ducats Earned, Experience, Enemies Routed, Camps Taken, Damage Dealt, Orders Issued, Accuracy — then a casualty list with skull glyphs. A red "Close the Book" ribbon with an ENTER keycap, visible and inside the viewport at 1440x810 in both states._
