# r25 VERDICT — grade

**Verdict:** REJECT  ·  **Publishable:** false

## Summary
The margin drain is real and it is the first thing this project has built that measures like the reference: across a horizontal saturation profile at y 300-800, `overview` runs 0.08 / 0.10 / 0.24 / 0.39 over the leftmost 160 px while REAL vc-072 runs 0.07 / 0.09 / 0.17 / 0.25 over the same span — same ramp width, same depth, same shape — and centre/edge lands 1.73 and 1.78 on `overview` and `tank`, inside the real game's 1.56-2.68 for the first time in 24 rounds. `overview` and `bridge` are genuinely good pictures. What blocks the build is not the drain: it is that the SKY IS NOT A SKY. Measured on clean mid-frame patches well inside the margin (where the falloff term is ~0, so this is not the p99/paper-lift issue), our sky reads (224,220,208) at sat 0.073-0.083 and red-dominant; every reference frame reads sat 0.165-0.212 and blue-dominant — vc-104 (166,196,206), vc-072 (180,199,218). That is exactly `SKY.horizon = 0xe0dcc4` (224,220,196) at sky.js:292 arriving unmodified, because the horizon-to-skyMid ramp spends its whole move above the ~13 degrees a gameplay camera ever sees. In `village` and `tank` the result is a dead flat cream field with a total value range of 6 and 9 LSB over a 520x70 sample, occupying roughly 30% of the frame — the rubric's own "empty regions of frame with nothing to look at". Second blocker: `dusk` is broken, at ink 22.36% against the real game's 1.8-2.8 and against its own siblings' 3.3-8.9, with the foreground field rendering as a mat of near-black streaks and no dusk light anywhere despite the shot requesting t=0.95 at 13 degrees. Honest counterweight: the dark end is now correct (L<32 at 0.04-0.30% against the references' 0.04-2.83%), the HUD and page chrome are properly illustrated, the half-timbering and pantiles are the best set dressing the project has had, and the Edelweiss now reads as a specific tank with running gear and the Gallian emblem. This is two fixes from a defensible ship, not a round of work.

## Best thing (do not touch)
The drawing falloff on `overview`'s right margin. At 1.6x, the grass, rocks and stone steps beyond the tree drain to cream with their contours surviving as thin grey pencil marks — it genuinely reads as the part of the sheet the painter never got to, not as fog or erasure. And it measures: the sat-vs-x ramp (0.08/0.10/0.24/0.39 over the outer 160 px) is within a few hundredths of vc-072's (0.07/0.09/0.17/0.25) in both width and depth. This is the project's central thesis achieved. Do not retune it.

## Explicitly protected
- The drawing falloff geometry and strength — uDrawFallAmt/Start/Scale/Aniso in canvasRenderPipeline.js:2871-2897. Ratio 1.73 (overview) and 1.78 (tank) sit inside the reference's 1.56-2.68 and the edge ramp profile matches vc-072 almost exactly. Any further tuning is now downside risk.
- The hard ink exemption in the lift (dLum smoothstep 0.10/0.34 at canvasRenderPipeline.js:2033). This is what makes the margin read as line-art rather than white ghosts, and the comment's own measurement backs it. Leave it.
- The black point. L<32 covers 0.04-0.30% of our frames against 0.04-2.83% for the references — the dark end is finally right, and it is warm. The r15 ink-floor trap is closed; do not reopen it chasing p1.
- The HUD and page chrome — cream deckled panels, serif small-caps, ribbon name slips, the compass rule, the corner flourishes. This is illustrated field-journal styling and it is the one axis that would pass a blind test outright.
- Building materials in `village` and `bridge` — plaster weathering, brown half-timbering, terracotta pantiles with visible courses, ashlar coursing on the bridge. Best set dressing in the project's history and the thing that most says Gallia.
- The Edelweiss silhouette in `tank`. Contrary to finish_plan.md's 'not started', the hull, running gear and the Gallian star-shield emblem read as a specific vehicle.

## Blockers (3)

### The sky is the paper, not a sky. Clean mid-frame patches (falloff ~0 there) read (224,220,208) sat 0.073-0.083, red-dominant. Every reference sky reads sat 0.165-0.212, blue-dominant: vc-104 (166,196,206), vc-072 (180,199,218), vc-088 (186,185,165) sat 0.165. In `village` and `tank` it is a dead flat cream plateau — 6 and 9 LSB of total value range over a 520x70 sample — filling ~30% of the frame. It also destroys the drain's own legibility: the sky and the unpainted margin are the same colour, so there is no visible boundary between picture and sheet, which is the one thing vc-072 makes unmistakable.

**Where:** `src/world/sky.js:292 (SKY.horizon = 0xe0dcc4 = (224,220,196), i.e. within 12 LSB of exactly what we measure) and the two-stop ramp at src/world/sky.js:117`

**Fix:** Re-author SKY.horizon to a pale blue-grey around 0xc0cfd4 / 0xb9cbd6 (B >= G > R, sat ~0.14) and pull the first ramp stop down so uSkyMid — currently mix(horizon, zenith, 0.5) ~ (150,181,181) — arrives by g ~= 0.15 instead of 0.5. The gameplay camera only ever sees 0-13 degrees of dome, so the entire zenith-to-horizon move must happen inside that band. Acceptance: a 200x150 sky patch at frame centre in cold `tank` and `village` measures sat >= 0.15 with B > R, and the same patch's value range exceeds 25 LSB. Do NOT do this by draining less — the margin drain is correct and must not move.

**Effort:** 1-2 hours, two constants plus a ramp stop, then re-measure the five plates

### `dusk` is not shippable and is not dusk. ink 22.36% against the real game's 1.8-2.8 and against this build's own 3.28-8.88 on the other four shots — 8x the reference and 3-7x its siblings. The foreground field renders as a dense mat of near-black horizontal streaks that reads as scribble, not grass; p50 is 93 where the other four sit at 126-152. And there is no dusk in it: no warm key, no raking shadows, no low-sun rim, sky at (213,209,197). The shot explicitly asks for t=0.95 / 13 degrees elevation / azimuth -1.868 and the authored dusk palette exists (sky.js:324-332, horizon 0xdf9a63, gold 0xffb46c) — none of it is on screen, so the time-of-day is not reaching the dome or the grade.

**Where:** `src/game/captureShots.js:1667 setSun(ctx, 0.95, -1.868) -> the 'world:timeOfDay' subscriber in src/world/sky.js (SkyDome time blend, :447-459) and src/render/lighting.js; the ink blowout is the grass blade pass under low key light`

**Fix:** Two separate things. (1) Trace the world:timeOfDay bus event from captureShots.js:58-61 to SkyDome's night/day blend and confirm k actually reaches ~0.9 at t=0.95; the picture says it does not. Acceptance: cold `dusk` sky patch is warm-orange (R > G > B, sat >= 0.20) and figures cast shadows raking >= 3x their height across the frame. (2) Gate the grass-blade contour on the ink pass by absolute luma, not by local contrast: at t=0.95 every blade falls below the knee and gets its own stroke. Acceptance: cold `dusk` ink lands 2-4%, in family with bridge's 3.28. If neither lands cheaply, cut `dusk` from the shipped shot set rather than ship it.

**Effort:** half a day; alternatively 5 minutes to drop the shot

### The largest human figure in `dusk` has no face. At 1.3x the near soldier at 3.6 m is a green cap over a flat, featureless pale wedge — no eye, no nose, no mouth mark, no shading. This is the 'degenerate pale wedge across the middle of the face' that finish_plan.md pass 3 reports having caused and then clamped out; it is still present on this unit at foreground scale. Adjacent problem in the same family: the near soldiers in `tank` and `village` still read as generic olive-drab WW2 infantry in stamped steel helmets, which is the exact prior finish_plan.md section 1.5 says to delete.

**Where:** `src/actors/character.js / src/actors/rig.js — the makeAppearance parameter clamp described in finish_plan.md pass 3, and the CAST table's headgear assignment`

**Fix:** Render `dusk` cold, crop the head at 4x, and confirm the face params for the unit named 'Marina Wulfstan' are inside the ranges the skull mesh deforms cleanly over. The clamp was applied at the named-lead override site; this unit is getting through it. Acceptance: at 4x the near head shows a distinguishable eye mark and jaw line, and no contiguous >40x40 px region of flat unshaded pale on the face.

**Effort:** 2-4 hours, and it may reduce to a single clamp that is not covering all six units

## Blind test, per shot

### overview — would pick as real: **the real game**

**The tell:** The sky and the unpainted paper margin are the same colour. A 400x100 patch of open sky reads (228,224,211) at sat 0.076 — warmer and less chromatic than the cream sheet beside it — so there is no visible boundary between picture and page at the top of the frame. In vc-072 the sheet is cream and the sky is (180,199,218) at sat 0.212, and you can see exactly where one becomes the other. Second-order: no pixel anywhere in the frame exceeds L 246, so the 'paper' never actually reaches paper (vc-092 has 3.04% above it).

**Scores:** palette 7 · tonalRange 7 · paperDrain 8 · foliage 7 · light 8 · composition 9 · materials 8

**Worst axis:** palette

_A high three-quarter view down a grassy bluff to a three-arch stone bridge over a green-blue river. Terracotta-roofed, half-timbered farm buildings sit on the far bank; large oaks frame the right edge and a line of poplars the left. Four soldiers with ribbon name slips (Rosie Stark, Alicia Melchiott, Edelweiss) climb the near slope. Cream illustrated HUD: a name/class plate and AP gauge bottom-left, an ammunition slip bottom-right, a control strip along the bottom, a compass rule at the top. The outer inch of the frame on all four sides drains to cream with pencil contours surviving. The sky is a flat warm cream._

### village — would pick as real: **the real game**

**The tell:** The top of the frame is a void. A 240x300 patch of 'sky' measures (226,221,209) at sat 0.076 with a 6 LSB total value range — nothing is drawn in roughly 30% of the picture. Beside it, the sandbags read as five smooth ~1.2 m beans with a stippled dot-fill; vc-088's sandbags are small stacked courses with fabric folds and a dark line between rows. The frame also carries the lowest centre/edge ratio of the five at 1.42, and the near-left building — the closest thing in shot after the foreground soldier — is washed to near-white with its shading intact underneath, which reads as fog, not as unpainted paper.

**Scores:** palette 6 · tonalRange 6 · paperDrain 6 · foliage 6 · light 5 · composition 4 · materials 8

**Worst axis:** composition

_A street-level view across a dirt yard between half-timbered village buildings with terracotta hipped roofs. A white picket fence and a cart wheel at left, a low stone wall centre, a telegraph pole right. Three Imperial soldiers with red-dotted ribbon labels, one crouched behind a bush, one standing in a doorway, one on the road. A helmeted friendly fills the bottom-right corner from behind. Five very large smooth tan lozenges (sandbags) stack across the bottom-left. The top ~40% of the frame is a featureless cream field._

### tank — would pick as real: **the real game**

**The tell:** The contour ink on the near soldier is a constant-width, near-black, fully closed stroke with no taper and no break — a vector cut-out edge, not graphite. In vc-072 the character contour is a warm dark brown line that runs ~4 px on the outer silhouette and drops to hairline at interior folds, and it breaks. Ours does neither. The hull is also the largest flat area in the frame at lit (175,150,117) with almost no plate detail, against vc-104's imperial tank which carries rivets, weld lines, bolted hatches and visible wear.

**Scores:** palette 7 · tonalRange 7 · paperDrain 8 · foliage 7 · light 6 · composition 7 · materials 7

**Worst axis:** light

_A low three-quarter view of a pale sand-coloured tank in profile, gun barrel pointing right, with a white-star-on-red shield emblem on the turret side. A windmill and treeline behind it at left; half-timbered houses with name ribbons (Largo Potter, Isara Gunther, Alicia Melchiott) at right. A helmeted soldier in olive drab stands in the near right foreground, back to camera, holding a rifle. Grass and water at the bottom edge. The upper third is flat cream._

### bridge — would pick as real: **the real game**

**The tell:** The shadows have no depth. The bridge's skylit spandrel face measures (93,94,79) and the fully occluded arch soffit measures (85,86,73) — 8 LSB separates a face in open skylight from a hole in the masonry. The whole bridge, which is 35% of the frame and the subject, is therefore one flat olive-grey plane with lines drawn on it, at hue ~63 degrees where limestone in vc-072 and vc-088 is a warm buff with R > G > B. p1 is 53, the highest (weakest) of the five plates.

**Scores:** palette 6 · tonalRange 7 · paperDrain 7 · foliage 8 · light 4 · composition 9 · materials 8

**Worst axis:** light

_A near-elevation of a three-arch ashlar bridge spanning a wide green-blue river, seen from the water. A big oak at upper left, a windmill on the ridge centre, a half-timbered building with a red-tile roof at upper right with barrels, crates and anti-tank crosses. Two figures on the parapet, one seated under the left arch with an Alicia Melchiott ribbon. Water rendered as long horizontal wash strokes. Same cream HUD furniture._

### dusk — would pick as real: **the real game**

**The tell:** ink 22.36%, against the real game's 1.8-2.8 and this build's own 3.28-8.88 on the other four plates. At 1.3x the foreground field is a mat of thin near-black streaks — that is scribble, not grass, and it is roughly a third of the frame. p50 93 against 126-152 on the siblings. And nothing about it is dusk: the shot requests t=0.95 at 13 degrees with the sun hard left (captureShots.js:1667), and the frame renders with a cream sky at (213,209,197), no warm key, no rim light and no raking shadow anywhere.

**Scores:** palette 3 · tonalRange 4 · paperDrain 5 · foliage 5 · light 2 · composition 4 · materials 3

**Worst axis:** light

_A flat field of very dark grey-green under a blown-white sky. Bare-trunked trees with sparse leaf-discs at left, telegraph poles and wires, a windmill on a low hill centre, pale houses and a light grey tank with flat blue rectangular panels at right. Five soldiers scattered across the field with name ribbons. The nearest figure, cropped at the thigh, is a green cap over a blank pale wedge where the head should be. The whole ground plane is covered in dense near-black horizontal streaking._
