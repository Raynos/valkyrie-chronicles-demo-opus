# r25 audit — tank-fx

**Verdict:** needs-work

## Summary
The worst thing in my three frames is the onomatopoeia, and it is not the false claim you suspected — it fires, it is just wrong in every particular. In my cold `firefight` render "RATTA" is 595 px wide (31% of frame width; vc-108's is 14.5%), it is set in **Georgia serif**, and it is **semi-transparent**: the same letter stroke measures (233,208,110) over sky and (146,113,72) over dark foliage, i.e. you can read the village, the chimney courses and the tree crowns straight through it. vc-108's letters are opaque (255,194,8), sat 0.97 vs our 0.53. Two words at once cover the whole upper-middle band of the picture and bury the (genuinely good) damage plates behind them. Second: the tank is not camouflaged in the reference and ours is — measured on the turret side plane our hue runs p10–p90 = 40–93° (a 53° span) against vc-104's 18–31° (13°), and our glacis reads hue 40° while the turret reads 79°, a 39° split across one painted vehicle where the reference splits by 2°. Third: the muzzle flash never gets above L 211 while the frame's own p99 is 225 — the flash is dimmer than ordinary sunlit stone, which is why it reads as fog. Against all that: **the `tank` plate is as good as you said and I would not churn the hull, gun, handrails, hooks or composition.** The Edelweiss-silhouette work (P6d) is real but it is the largest and riskiest item here and I rank it below four cheap fixes that buy more recognition per hour.

## Do not touch (verified good)
DO NOT TOUCH:
• The `tank` plate's composition and staging — the three-quarter low angle, the windmill on the left third, the village and treeline recession, the sky, the water. It is the best frame in the demo and the camera reasoning in captureShots.js:1255-1275 (the solved sun-bearing key) is why. Leave the sun key and the framing alone.
• The tank's UPPER works: hull massing read, the gun with its muzzle brake, the full-length towing cable with hooks, the handrails, the stowage. Those are legible and well drawn at 1:1 and at 3× zoom.
• The onomatopoeia FEATURE ITSELF. r24's P6e claim is TRUE — it fires in both `firefight` and `action`, it is a world-space sprite occluded and scaled by distance exactly as vc-108's is, its rotation is a deterministic counter (capture contract respected), and `fx.clear()` is wired into `resetShotState()`. The concept and the plumbing are right. Only the typography, the size, the opacity and the spawn cap are wrong. Do not rewrite it as a HUD element — world space is the correct call and matches the reference.
• The damage plates ("61 CRITICAL" / "34" as thrown ink blots) in `firefight`. These are genuinely Valkyria and are one of the best-drawn objects in the project. The only thing wrong with them is that the oversized lettering sits on top of them.
• The FX system's breadth in src/render/fx.js — impact by material (fx.js:447-457), tracers, casings, backblast, the muzzle-brake dirty ring, smoke columns — and the capture harness's finale/shutter reasoning (captureShots.js:286-336) which is careful and correct. The problem is intensity and legibility, not missing systems. Do not add new effect types.
• The deckled frame, the name slips, and the bottom-left/bottom-right HUD panels.

## Findings

### [blocker | medium | verified] Onomatopoeia is semi-transparent — the scene reads straight through the letters

**Location:** `src/render/fx.js:1176`

**Evidence:** Cold render /tmp/claude-501/tka-firefight.png. Sampling ONE letter stroke of "RATTA" at three points: (620,300)=(228,198,103) over sky, (535,310)=(233,208,110) over roof, (950,325)=(146,113,72) over dark foliage. The fill colour tracks what is behind it, so the sprite is compositing at well under full alpha AND is being drained by the grade — the authored fill is #f2c02c (242,192,44), sat 0.82; it renders at sat 0.53 and lifted 66 LSB in blue. At 5× zoom (/tmp/claude-501/c-ff-flash.png) the tree trunk, the sky, the leaves and the tree crown's own ink outline are all fully legible inside the "O" and "M" of DOOM. vc-108's letters measure (255,194,8) / (249,195,17) / (249,197,17) — sat 0.97, constant regardless of the enemy soldier standing directly behind them, i.e. fully opaque and untouched by the paper grade. The SpriteMaterial at fx.js:1176-1181 sets transparent:true, depthWrite:false and nothing else — no toneMapped:false, no fog:false — so the word goes through the whole watercolour chain (drawing falloff, haze, pigment) like a piece of scenery.

**Proposed fix:** Composite the words late and opaquely. Keep the world-space POSITION (that is correct and matches the reference) but take the glyph out of the graded chain: set `toneMapped:false, fog:false, depthWrite:false` on the SpriteMaterial at fx.js:1176, give the sprite a layer/renderOrder that the drawing-falloff and haze terms in GRADE_FRAG skip, and verify the material's opacity is 1.0 at capture time (the fade at fx.js:1209 only starts at k>0.60, so a shutter inside the plateau must show alpha 1). If a late overlay pass is too invasive, the cheaper 80% is to exempt fx sprites from uDrawFall/uHaze by material flag.

**Acceptance test:** node tools/shoot.mjs --cold firefight /tmp/x.png. Sample 3 pixels inside the SAME letter stroke over three different backgrounds (sky, terracotta roof, dark foliage). All three must be within 8 LSB of each other on every channel, and saturation must be >=0.85. Reference: vc-108 gives (255,194,8) and (249,197,17) across a sky background and a soldier background — 6 LSB apart, sat 0.97. Current: 8-38 LSB apart, sat 0.53.

### [blocker | small | verified] Onomatopoeia is ~2.1× too large and two words fire at once, burying the composition

**Location:** `src/render/fx.js:1185`

**Evidence:** /tmp/claude-501/tka-firefight.png: "RATTA" spans x 520→1115 = 595 px = 31.0% of frame width, letter height ~205 px = 19% of frame height. "DOOM" spans another ~480 px (25%). Together they occupy the entire upper-middle band and occlude the bridge, the burning village and the two damage plates ("61 CRITICAL" and "34" are unreadable behind the glyphs — see /tmp/claude-501/c-ours-ratta.png). vc-108's RATTA spans 278 px = 14.5% of frame width, individual letter height ~120 px = 11%, and it is the ONLY word on screen. Mechanism: fx.js:1185-1186 `const scale = opts.scale ?? 1.35; sp.scale.set(scale*2, scale, 1)` fed from fx.js:720 `{ scale: 0.9 + s * 0.5 }`, giving ~3.0 m × 1.5 m of world space per word; and fx.js:1173 `if (this._words.length >= (opts.max ?? 3)) return` is a GLOBAL cap with no per-unit dedup, so the `firefight` finale's 8 muzzleFlash calls (captureShots.js:1216-1229) hand three slots to arbitrary units rather than to the hero.

**Proposed fix:** Halve the world scale at fx.js:1185 (target `0.45 + s*0.25`, i.e. ~1.4 m × 0.7 m) and drop the cap at fx.js:1173 from 3 to 1 so only one word is on screen at a time — that is what vc-108, vc-104 and vc-066/068/070 all show. Additionally offset the sprite laterally off the bore instead of sitting on it (fx.js:1183-1184 currently only lifts y by 0.35) so the word sits BESIDE the muzzle rather than across the target, as in vc-108.

**Acceptance test:** node tools/shoot.mjs --cold firefight /tmp/x.png; measure the bounding box of contiguous saturated-yellow pixels. Exactly ONE word must be present and its width must be <=18% of frame width (reference 14.5%). Both damage plates must be fully legible — no glyph pixel may overlap the '61 CRITICAL' or '34' plate bounds.

### [major | small | verified] Onomatopoeia is set in Georgia serif; the reference is a hand-drawn comic brush face

**Location:** `src/render/fx.js:1151`

**Evidence:** fx.js:1151 `g.font = '900 150px Georgia, "Times New Roman", serif'` — a book text face with bracketed serifs and high stroke contrast, drawn on one flat baseline with a single whole-word rotation (fx.js:1180). Side by side at matched zoom (/tmp/claude-501/c-ours-ratta.png vs /tmp/claude-501/c-ref-ratta.png) ours reads as a carved stone sign or a film title card; vc-108's reads as a marker-drawn comic word: uniform-weight strokes, closed counters, EACH LETTER individually rotated (R upright, A ~+8°, T ~-6°, T ~-12°, A ~-20°) so the word descends in an arc, and a solid black contour ~7 px at 1920 (ours is #2b1d10 at 20 px on a 150 px em, which renders as a soft mid-brown edge because it is being drained with the fill).

**Proposed fix:** Replace the serif stack at fx.js:1151 with a heavy geometric/grotesque display face (Impact / Arial Black / 'Haettenschweiler', system-safe) at a wider tracking, and draw the word letter-by-letter in _wordTexture with a per-letter rotation of ±(4..20)° taken from a deterministic seed (the same counter idiom already used at fx.js:1180) so the word arcs. Change the stroke to true near-black (#141014) — the current #2b1d10 is already mid-brown before the grade touches it.

**Acceptance test:** Render firefight cold and crop the word at 3×. Every letter must sit at a visibly different angle from its neighbours, the strokes must be of uniform weight with no thin/thick serif modulation, and the contour must measure L<=45 (vc-108's contour core measures ~(50,42,20)).

### [major | medium | verified] The tank's paint spans 53° of hue on one plane and 39° between faces — it reads as camouflage, the reference is monochrome

**Location:** `src/actors/tank.js:46`

**Evidence:** Cold /tmp/claude-501/tka-tank.png, measured on flat single-albedo boxes. Turret side (x 620-920, y 400-445): hue p10/p50/p90 = 40/79/93 (span 53°), sat p50 0.244. Glacis (x 750-1010, y 520-560): hue 24/40/62 (span 38°), sat p50 0.319. vc-104's tank, same-sized boxes: hull side hue 21/25/31 (span 10°) sat 0.185; turret side hue 18/23/30 (span 12°) sat 0.194 — the two faces differ by 2° of hue. Ours differ by 39°. Visually (/tmp/claude-501/c-tank-emblem.png at 4×) this is irregular teal-green blobs over cream with scattered orange freckles, i.e. a disruptive camouflage scheme; vc-104 is one flat dust-tan with dark wash streaking. Root: PAL.paint at tank.js:46 is 0xaeb5a6 = hue 88° sat 0.083 (sage-green) and mat.paint carries `bandBleed: 1.7` at tank.js:1065, the highest bandBleed anywhere in the file (its neighbours are 0.45/1.3/1.35/1.5) — the wet edge spreads adjacent bands' hues into ~45 px blobs. NOTE: this is NOT the ruled-out albedo-mottle amplitude fix documented at tank.js:599-610 — that was already halved and the comment explicitly warns against flattening the map. This is hue spread and chroma, which that pass did not address.

**Proposed fix:** Pick ONE deliberate vehicle hue and hold the whole vehicle inside a <=20° window. Re-author PAL.paint (tank.js:46) at its current luminance — per the r15 lesson, re-author hue AND chroma at the new L and measure there, do not just rotate. Two defensible targets: Gallian tan in the reference's window (hue ~25-30°, sat ~0.19), or the Edelweiss's own pale slate blue-grey (hue ~205-215) with tan running gear. Either is fine; the 53° spread is the defect, not the specific hue. Then pull mat.paint's bandBleed (tank.js:1065) from 1.7 down toward its neighbours' 1.3-1.5 and re-measure the span.

**Acceptance test:** node tools/shoot.mjs --cold tank /tmp/x.png. Over a 300×45 box on the turret side and a 260×40 box on the glacis: each box's hue p10→p90 span must be <=20°, the two boxes' hue medians must be within 15° of each other, and sat p50 must land 0.17-0.22. Reference vc-104 scores 10-12° span, 2° between faces, sat 0.185-0.194. Current: 53°/38° span, 39° between faces, sat 0.244/0.319.

### [major | small | verified] The muzzle flash peaks at L 211 — dimmer than the frame's own p99 of 225

**Location:** `src/render/fx.js:729`

**Evidence:** Cold firefight. Flash core at the lancer's muzzle (box x1185-1245, y300-370) has max L 211.1 at RGB (224,215,157) — a soft warm cream. node tools/artstats.mjs on the same plate gives the whole frame p99 = 225. So the flash is DARKER than 1% of the ordinary picture; at 5× (/tmp/claude-501/c-ff-flash.png) it reads as a smudge of fog with a few thin radial spikes, not a flash. At the hero's muzzle (box x850-960, y440-520) the brightest pixel is L 216.7 (226,223,160) and is indistinguishable from the sunlit stone parapet behind her — you cannot tell from the frame whether Rosie's weapon fired at all, while a 595 px 'RATTA' hangs over her. vc-108's brightest impact highlight measures 251.4 (255,255,223). The code comment at fx.js:734-737 asserts the core is 'pure white at 2.6× … comfortably over the 0.72 bloom threshold' — that reasoning predates r24's exposure 1.06→0.84 and the drawing falloff, and no longer holds. Contributing: flash life is 55-85 ms (fx.js:729) against the word's 620 ms (fx.js:1189), a 10:1 ratio, so most frames that show the word show no flash.

**Proposed fix:** Exempt the flash pool from the drawing falloff and the exposure drop (same overlay/late-composite route as the onomatopoeia fix) so the hot core clips to paper white, and raise the flash life at fx.js:729 from 0.055-0.085 to ~0.10-0.14 so a shot is visible for a plausible fraction of the word's life. Do NOT compensate by scaling the flash up — a bigger dim blob is worse; the defect is peak luminance, not area.

**Acceptance test:** node tools/shoot.mjs --cold firefight /tmp/x.png; node tools/artstats.mjs /tmp/x.png. The max luminance inside a 60×70 box centred on each firing muzzle must exceed the frame's reported p99 by >=15 LSB (i.e. >=240 at today's p99 of 225). Reference vc-108's brightest combat highlight is 251. Current: 211 and 217, both BELOW p99.

### [major | small | verified] Road wheels carry a cream crescent smear that does not follow the wheel form — rim 0.78 stacked on curvature 0.32

**Location:** `src/actors/tank.js:1141`

**Evidence:** /tmp/claude-501/c-tank-idler.png (3× on the rear road wheels) and /tmp/claude-501/c-tank-gear.png (2×): each wheel face carries a bright cream 'C' plus a second pale wedge, at inconsistent angles between neighbouring wheels, that read as paint splashed onto the disc rather than as light on a form. This is the exact albedo-patch-instead-of-lit-band trap the rubric documents at docs/CRITIQUE_RUBRIC.md:84-101. vc-104's road wheels (/tmp/claude-501/c-ref-tank.png) are clean discs with a modelled hub, a bolt circle and a dished spoke pattern, lit by one soft terminator. Mechanism: mat.gear at tank.js:1139-1143 sets `rim: 0.78` — the highest rim value in the file, its neighbours run 0.30-0.62 — on top of `curvature: 0.32` and `spec: 0.22`. Three independent bright-edge terms stack on a face-on disc and produce two unrelated arcs per wheel.

**Proposed fix:** Drop mat.gear's `rim` (tank.js:1141) from 0.78 to the running gear's neighbouring range (~0.45) and keep exactly ONE of the two edge terms — the file's own comment at tank.js:1134-1138 argues for `curvature` on a face-on disc, so cut rim rather than curvature. Re-render and check the wheel still has a wash edge on its flange (which is what the curvature term was added for) but no free-floating crescent.

**Acceptance test:** node tools/shoot.mjs --cold tank /tmp/x.png; crop the three rear road wheels at 3×. No pixel on a wheel FACE may exceed the median luminance of the lit glacis (currently ~193 at its p90), and each wheel must show at most one continuous light-to-dark boundary. Re-render with the sun azimuth moved and confirm the boundary MOVES (rubric §metric-integrity test 3) — a painted-on crescent will not.

### [major | small | verified] The tank plate carries 5.16% ink against the real game's 2.76% — every track link is separately outlined

**Location:** `src/actors/tank.js:2536`

**Evidence:** node tools/artstats.mjs on my cold plates: tka-tank.png ink 5.16%, p99 228, range 188. Same tool on docs/reference/vc-104.jpg (converted): ink 2.76%, p99 241, range 209. The tank is the most over-inked shot in the demo (r24's own log records overview 3.37 / closeup 4.01). At 3× (/tmp/claude-501/c-tank-idler.png) the cause is visible: tank.js:2536 sets `this.linkMesh.userData.outline = true` on the InstancedMesh of ~80 track shoes, so every 23 px link gets its own ~1.05 px silhouette and the whole track run collapses into a solid black serrated strip. vc-104's track is drawn with ONE outline round the run and light interior division lines. The marking assembly adds more: tank.js:2438 and :2446 outline both the raised plate and an ink torus ring, giving the roundel a contour roughly 3× the reference decal's.

**Proposed fix:** Set linkMesh.userData.outline = false at tank.js:2536 and let the track's silhouette come from the hull/sponson outline plus the shoe geometry's own shading; if the run then reads as mush, restore outlining only for the top and bottom runs' extreme shoes. Separately drop the ink torus at tank.js:2444-2447 (the raised plate at :2438 already gives the marking a real silhouette for the outline pass).

**Acceptance test:** node tools/shoot.mjs --cold tank /tmp/x.png; node tools/artstats.mjs /tmp/x.png → ink <=3.0% (vc-104 = 2.76%) with p50 within 6 LSB of today's 142, i.e. prove the ink came off the track and the picture did not just get lighter. Crop the running gear at 3× and confirm individual shoes are still distinguishable.

### [minor | small | verified] The turret marking is a red-bar-in-circle roundel — a generic invented national marking, not a Gallian crest

**Location:** `src/actors/tank.js:674`

**Evidence:** /tmp/claude-501/c-tank-emblem.png at 4×: a cream disc with a horizontal maroon bar and a heavy soft brown ink ring. It reads as an aircraft roundel or a no-entry sign. vc-104's Imperial tank carries a stencilled glyph decal — a drawn sigil with a crisp white outline and a cast shadow, no disc — repeated on the turret cheek and the hull side. Valkyria's factions are identified by a CREST/GLYPH, never by a roundel; the Edelweiss specifically wears the Gallian shield plus its own hand-painted name/flower. tank.js:669-673 and :2404-2409 both describe this as 'the Gallian roundel … the thing that tells you at a glance whose tank it is' — it currently tells you nothing, because no such marking exists in the game. Secondary: green camo flecks bleed through the stencil onto the cream disc.

**Proposed fix:** Redraw makeInsigniaTexture (tank.js:674) as a shield/crest glyph on alpha with a white keyline and no disc: silhouette first, interior mark second, no field. Keep the raised-plate geometry at tank.js:2438 (its silhouette is what gives the outline pass something to draw) but drop the ink torus at :2444. This is a canvas-drawing change; no geometry work.

**Acceptance test:** Render tank cold, crop the turret cheek at 4×. The marking must read as a shield or glyph, not a disc-with-bar, and its contour must be a light keyline rather than the current heavy soft ring. Put the crop beside vc-104's turret marking — a Valkyria player must not read ours as a national roundel.

### [minor | medium | verified] No rivets read anywhere on the vehicle; the reference rivets every plate seam

**Location:** `src/actors/tank.js:1816`

**Evidence:** At 4× on the turret side (/tmp/claude-501/c-tank-emblem.png) and 2× on the hull side (/tmp/claude-501/c-tank-lower.png) there is not one visible rivet on our tank. vc-104 at matched zoom (/tmp/claude-501/c-ref-tank.png) has dense rivet rows along every plate edge on the turret, the sponson, the hull side and the glacis, and they are the single loudest 'this is riveted armour, not a smooth box' cue. Ours exist but cannot read: _buildRivets is called ONLY from _buildHull (tank.js:1816) — _buildTurret at :1851 never calls it — and the domes are r=0.026 m squashed to 0.62 with `mesh.userData.outline = false` (tank.js:1829), so on a hull mostly hidden behind the fender skirt (tank.js:1448) they contribute nothing.

**Proposed fix:** Call _buildRivets from _buildTurret with a seam list along the turret cheek and shoulder folds, and raise the dome radius at tank.js:1822 from 0.026 to ~0.038 so a rivet is 2-3 px in the `tank` framing rather than sub-pixel. Leave outline false (the comment at :1829 is right — outlining them would be a scribble field, and the ink budget is already 1.9× the reference).

**Acceptance test:** Render tank cold, crop the turret cheek at 4×. A row of rivets must be countable along at least two plate seams, AND node tools/artstats.mjs must show ink not risen above whatever the track-outline fix lands it at (i.e. prove the rivets did not come back as ink).

### [major | large | verified] P6d Edelweiss silhouette: our turret and running gear are generic WW2 — real, but the largest and riskiest item here

**Location:** `src/actors/tank.js:1851`

**Evidence:** Against vc-104 and the plan's P6d brief: our turret (/tmp/claude-501/c-tank-turret.png at 2×) is a low flat welded wedge with a chamfered top, no cupola, no hatch, no vision port, no external mantlet — a Panzer/Sherman median. The running gear (/tmp/claude-501/c-tank-idler.png) is Tiger-style overlapping large road wheels behind a plain fender skirt, with no toothed drive sprocket, no idler and no return roller visible at either end, and the top track run dead straight with no sag. vc-104's tank shows a spoked toothed sprocket with lightening holes, small bogie-mounted wheels on visible spring assemblies, a fine-pitch sagging track and a full-length track guard. The Edelweiss's own recognition cues — a rounded cast turret set forward with a big external mantlet and a raised commander's cupola, a pointed nose, large Christie road wheels with the track riding directly on them, and the Gallian crest — are all absent. Ranked honestly: this has the highest recognition ceiling of anything in my concern and the worst value per hour. _buildTurret is tank.js:1851-2180 (330 lines) and _buildHull is :1199-1818 (620 lines); reshaping either means re-deriving glacisAt(), the turret race/skirt geometry at :1914-1916, the marking placements at :2461-2468 and the running-gear path at :3159. The four findings above are all constant-level edits and together move the picture more.

**Proposed fix:** If the round has capacity, do ONE massing change only, in this order of recognition-per-line: (1) the turret shell — replace the flat angular wedge in _buildTurret (tank.js:1851) with a rounded cast form plus a raised commander's cupola and a proud external mantlet ring; that is the object the 'Edelweiss' nameplate points at and it is ~150 lines. (2) Delete or shorten the fender skirt at tank.js:1448-1450 so the suspension reads, as it does in every reference frame. Do NOT attempt hull profile, sprocket/idler modelling and turret in one pass — and do not start this before the paint-hue, flash-luminance and wheel-rim fixes, which are hours not days.

**Acceptance test:** Render tank cold and put the crop beside docs/reference/vc-104.jpg. A Valkyria player must name the vehicle class from the turret silhouette alone. Regression gate: node tools/artstats.mjs must hold ink <=3.0% and the turret-side hue span <=20° (i.e. the new geometry did not reintroduce the ink or camouflage defects), and node tools/shoot.mjs --verify tank must be no worse than baseline.

### [minor | medium | likely] No visible drive sprocket, idler, return roller, track sag or track mud on the running gear

**Location:** `src/actors/tank.js:2182`

**Evidence:** /tmp/claude-501/c-tank-idler.png at 3× on the rear end: the track's top run is a dead-straight hard-edged strip that disappears into the hull with no return roller under it, and at the rear the track wraps a plain boxy housing with no toothed wheel. vc-104 shows an 8-spoke toothed sprocket with lightening holes engaging the track, a visibly sagging top run, and heavy dark grime in every recess. _buildRunningGear (tank.js:2182) is documented as building 'road wheels, idlers, sprockets, return rollers' and _updateTrack (tank.js:3118) carries a `trackSag` array, so the machinery exists — it just does not read at this framing/angle. I did not isolate WHY (whether sag is being driven to zero, or the sprocket is simply occluded by the hull at this camera), so treat the cause as unconfirmed.

**Proposed fix:** Diagnose first, then fix: log this.trackSag during the tank shot to see whether the sag term is live, and check whether the sprocket/idler meshes are inside the frustum and unoccluded at the tank camera. If sag is zero, drive it to ~40-60 mm on the top run; if the sprocket is occluded by the fender skirt, that is a second argument for shortening the skirt (see the P6d finding).

**Acceptance test:** Render tank cold, crop the rear and front track ends at 3×. A toothed sprocket must be identifiable at one end, and the top track run must show a measurable downward deflection between its supports (>=3 px at this framing) rather than a straight line.
