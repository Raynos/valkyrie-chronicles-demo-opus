# r25 VERDICT — regression

**Verdict:** REJECT  ·  **Publishable:** false

## Summary
The waves broke two things badly and both are on the shots that matter most: `aim` and every close-range face. Wave 2 moved the aim camera to vc-088's over-the-shoulder framing (armTarget 1.85, shoulderTarget -0.53 in captureShots.js) — correct instinct, but it dragged hand and weapon geometry that was only ever authored to survive at 40 px into a 1 m close-up, and what you now see is a claw of sausage fingers gripping nothing next to a flat brown slab with no barrel, no bolt and no sights. Independently, rig.js enlarged the eye by 1.8–2.25x and deepened the socket blob (0.155 -> 0.215); on the named cast that yields a bulging wet fish-eye proud of a flat mask (`closeup`), and on procedural militia — which still carry dm=1, i.e. ALL the old crease blobs PLUS the new eye — it yields a face criss-crossed with brown incisions that reads as scarring (`village`, ~90 px). So yes: the eye change reads at small size, and it reads as a wound. Third: the Edelweiss repaint is measured wrong in the frame — hull renders rgb(172,147,113) sat 0.345 V 172 against vc-104's real tank at rgb(118,105,95) sat 0.190 V 118, and in `overview` and `command` the vehicle is an unreadable pale cutout with no turret, gun or track run. Against that, the tonal work genuinely landed (p99 225 -> 236-240, p1 46 -> 38) and `bridge` is the best frame this project has ever produced. But ink density went back to r23 levels on half the set (village 8.88, closeup 8.47, squad 8.08 vs r24's 3.37/4.01 and the reference's 1.8-2.8) and frame saturation went 0.203 -> 0.241-0.279 against 0.19. Two things I must correct in the demo's favour: cold determinism is intact (byte-identical double renders of bridge, closeup and squad — the per-frame boot generator did not break it), and `--verify` is not reporting a resetShotState leak at all, it is comparing a shot's FIRST daemon render against its second, which always differ; after that first render `bridge` is 0.000% differing across an intervening `aim`. `squad`, however, never settles (0.33%, mean 4.5, max 98 LSB, every render).

## Best thing (do not touch)
`bridge`. Cold-measured sat 0.194, ink 3.28, p99 236 — the only plate that lands inside the reference band on every comparable axis simultaneously. Three receding arches carry the eye left-to-right, the water is painted rather than shaded, the far bank has real aerial perspective, and the mill-town skyline closes the top without crowding it. It would survive a blind side-by-side with vc-072 on composition alone.

## Explicitly protected
- `bridge` — its camera, its water, its stone palette and its haze. It is the only plate on the reference numbers and any global knob turned to fix another shot will move it.
- Cold-path determinism. Two cold renders each of bridge, closeup and squad are byte-identical (md5 match). The per-frame boot generator did not break the capture contract; do not 'fix' it.
- The tank *shot*'s Edelweiss modelling — hull facets, running gear, road wheels, track sag, the star insignia. That geometry reads correctly at close range and is the strongest asset work in the build. Only its paint value/chroma needs re-authoring, not its form.
- The leaf pigment re-authoring in worldMaterials.js. Measured canopy rgb(118,131,101) hue 86.4 against vc-072's rgb(144,156,126) hue 84.5 — the hue separation from the sward landed as claimed.
- The `command` screen chrome — roster cards, CP stars, order deck, tactical survey, END TURN ribbon. It is the most convincingly Valkyria interface in the project and _toggleOrders(true) in the shot was the right call.

## Blockers (6)

### `aim` close-range hand and weapon geometry is broken. The rifle is a flat tan slab with no barrel taper, no bolt, no front sight and no trigger guard; the hand is a bundle of oversized sausage fingers curled around empty air with the weapon passing behind them; the forearm meets the hand at a hard interpenetration seam; the second arm is a green tube that clips through the first. This is the one plate whose entire job is to sell the aim mechanic.

**Where:** `src/game/captureShots.js `aim` shot (the new `am.fovTarget = 32; am.armTarget = 1.85; am.shoulderTarget = -0.53;` block) exposing src/actors/rig.js hand/grip geometry`

**Fix:** Cheapest correct fix: back the lens off — armTarget 1.85 -> ~3.2 and scale shoulderTarget with it to hold the same ~16 deg lateral angle (-0.53 -> ~-0.92). That keeps vc-088's left-third placement while dropping the hand from ~330 px to ~190 px, below the size at which the missing grip reads. The real fix is to weld the fingers to the fore-end and give the barrel a muzzle and front sight in rig.js, but that is asset work, not a knob.

**Effort:** camera back-off: 15 min and one cold render. Grip/weapon authoring: half a day.

### The enlarged eye reads as an injury at every distance. rig.js took sclera radius 0.0062 -> 0.0110, iris 0.0071 -> 0.0122, pupil 0.0027 -> 0.0046, eH 0.0060 -> 0.0135 and deepened the socket blob 0.155 -> 0.215. On Alicia in `closeup` the eyeball bulges proud of a flat facial plane with a fleshy fold above it and an incised crease running down the cheek. On procedural militia in `village` — which get dm=1, so they keep every legacy crease blob AND the new eye — the face is criss-crossed with brown gashes and reads as a zombie at ~90 px.

**Where:** `src/actors/rig.js — FRAD, eW/eH, the three eye radii, the `sock` blob, and the `drawnFace`/`dm` gate`

**Fix:** Take the eye radii back to roughly 60-70% of the new values (sclera ~0.0080, iris ~0.0090, pupil ~0.0035, eH ~0.0090) and return the socket blob to 0.155/0.048. Separately, extend the `dm = 0` suppression to ALL characters, not just `o.castName` — the legacy crease blobs are what turn a mid-distance militia face into scarring, and they were tuned against the OLD small eye. Acceptance test: crop a procedural militia head at 90 px from a cold `village` and confirm no dark line crosses the cheek or temple.

**Effort:** 1-2 h including three cold re-renders (closeup, village, squad).

### The Edelweiss is unreadable in `overview` and `command`. In `overview` it is a jumble of pale cream boxes with no turret, no gun barrel and no track run, with a soldier standing inside its silhouette; its ink outline traces an amorphous blob. In `command` it is a white paper cutout indistinguishable in value from the bridge stone. The repaint was measured on the authored hex (0xbdb1a3, 'sat 0.138') but never in the frame: rendered hull is rgb(172,147,113) hue 34.5 sat 0.345 V 172 against vc-104's real tank at rgb(118,105,95) hue 25.0 sat 0.190 V 118 — 46% brighter and 82% more chromatic. This is the 'measure the thing, not its proxy' trap the rubric documents.

**Where:** `src/actors/tank.js PAINT `paint: 0xbdb1a3` / `paintAlt: 0xaca194`, amplified by the raised `uSage` chroma ceiling (0.42) from r24`

**Fix:** Re-author the paint AT ITS RENDERED VALUE, not its albedo: target rendered hull V ~120-135 and sat ~0.19-0.22 on a cold `tank` plate, which means dropping the albedo roughly 25% in value and pulling chroma down before the sage ceiling re-inflates it. Then re-render `overview` and `command` and confirm the turret ring, gun barrel and track run are separable by value at that distance — that is the acceptance test, not the hex.

**Effort:** 1 h, three cold renders.

### `dusk`'s near field is a crushed black hole. The bottom 45% of the frame measures mean L 63, p5 40, p50 59, p95 102 — a 62 LSB total spread with NO highlights anywhere. The foreground soldier is invisible against it and his head reads as a bare pale skull. Frame ink is 22.36% against the reference's 1.8-2.8. Compare bridge's near band (p50 137, p95 160) and the real vc-104's near band (p50 89, p95 188 — it keeps its highlights).

**Where:** `src/render/canvasRenderPipeline.js — the new depth term in the drawing falloff (`fall = max(fall, far01 * uDrawFallAmt)` with uDrawFallAmt 0.66 -> 0.95) interacting with dusk's low key; plus the dusk sun/exposure in the shot setup`

**Fix:** The depth term drains the FAR field but nothing lifts the near field, so at low key the composition splits into a white background and a black foreground. Either gate uDrawFallAmt by scene key (scale it by the frame's own p50) or raise the dusk key so the near band's p95 reaches ~150. Acceptance test: cold `dusk` near band (y 700-1000, x 480-1440) must show p95 >= 150 and ink <= 6.

**Effort:** 2-3 h — this one needs iteration, and it must be re-checked on bridge/grass/firefight because the term is global.

### Ink density and saturation regressed to near-r23 levels across half the set while p99 improved. Cold: village ink 8.88, closeup 8.47, squad 8.08, tank 6.47, grass 6.53, aim 5.74, action 5.55 — against r24's shipped 3.37/4.01 and the reference's 1.82-2.76. Frame saturation went 0.203 -> 0.241 (overview) and 0.202 -> 0.242 (closeup), with squad 0.279 and grass 0.269, against the reference's 0.191-0.194. satE went 0.108 -> 0.173 (reference 0.107-0.141). Part of the ink rise is legitimate (p1 46 -> 38 puts more pixels under the L<70 gate) but the picture agrees with the metric: figure contours are fat, uniform and near-black where vc-104's are thin and brown-grey.

**Where:** `src/render/canvasRenderPipeline.js `uDrawFallStart` 0.64 -> 0.84 and `uDrawFallAniso` 0.86 -> 1.03 (which is what raised satE), plus the ink pass width against the new lower black point`

**Fix:** The falloff pull-back to 0.84 was deliberate and the ratio (1.39-1.78) is still inside the reference's 1.56-2.68, so leave the margin alone — but the ink pass now runs against a black point 8 LSB lower and was never retuned for it. Reduce outlineWidth from 1.35 to ~1.05 and re-measure ink on cold `village` and `closeup`; target <= 5.0 with p1 held at 38. Do not chase this by raising the black point — that undoes the one thing these waves got right.

**Effort:** 1-2 h with cold plates on village, closeup, squad.

### `--verify` is structurally incapable of passing and its failure note is a false diagnosis that has now misled two rounds. It compares a shot's FIRST render in a daemon's life against its second; those always differ (bridge 0.183% mean 1.77, tank 1.450% mean 21.27 max 158, village 0.672% mean 6.85). Render the same shot a third and fourth time and they are byte-identical — I got md5 equality for bridge across an intervening `aim` AND an intervening `tank`. So the r24 note 'resetShotState() is missing something' is wrong for these shots; nothing got better or worse because the tool never measured what it claims. Separately and genuinely: `squad` never settles on the fast path — three consecutive renders gave three different md5s at 0.33% differing, mean 4.5, max 98 LSB.

**Where:** `tools/shoot.mjs lines 156-169 (the --verify block) and whatever animated state `squad` carries`

**Fix:** Two changes. (1) In --verify, render the target shot ONCE to warm it, discard, then do A / intervening / B — otherwise the first-render warm-up is charged to resetShotState. (2) `squad`'s residual 0.33% is a real leak worth finding: it is the only shot of five tested that fails after warm-up, so bisect what squad poses that bridge/tank/closeup/village do not. Note for every critic in the meantime: your first fast render of a shot on a fresh daemon can be 158 LSB off the settled frame — on `tank` specifically.

**Effort:** verify fix 30 min; squad leak unknown, 1-3 h.

## Blind test, per shot

### aim — would pick as real: **the real game**

**The tell:** The hand. Five sausage fingers, each wider than the rifle's receiver, curl around empty air while the weapon slab passes BEHIND them — and the weapon has no barrel taper, no bolt, no trigger guard and no front sight. Valkyria's over-the-shoulder frames put the grip at exactly this scale and the fingers are welded to the fore-end.

**Scores:** linework 5 · banding 5 · temperature 6 · paper 6 · hatching 4 · palette 6 · form 1 · composition 5 · materials 4 · atmosphere 6 · hud 8 · wow 2

**Worst axis:** form

_An over-the-shoulder view down a bridge deck. Filling the left third is the back of a figure in a teal jacket with a huge brown-and-pink hair mass where the head should be; two green tubes emerge from the shoulder and cross in mid-air, one ending in an oversized pale claw of fingers curled around nothing, the other in a blunt stub. A flat tan wedge floats where a rifle should be. A cream-and-red damage table sits across the top of the frame, an orange reticle over a crouched enemy at mid-distance, a ruled Imperial Sturmtruppe stat card at the right._

### closeup — would pick as real: **the real game**

**The tell:** The eye is a sphere sitting PROUD of the face plane with a hard rim around it, like a doll's eye pressed into clay — and a hard-edged crease runs from its outer corner down across the cheek. Alicia in vc-104 has a drawn eye that is flush with the skin and no facial creases at all.

**Scores:** linework 5 · banding 6 · temperature 6 · paper 6 · hatching 4 · palette 7 · form 2 · composition 6 · materials 6 · atmosphere 7 · hud 8 · wow 3

**Worst axis:** form

_Three-quarter rear view of a girl in a teal jacket carrying a bolt-action rifle across her body, a village lane and a wooded bank behind her. Her head is a brown hair ovoid with a pale tan mask on the front; on the mask sits one large wet blue-grey eyeball, a fleshy fold above it, an incised crease running down the cheek, and a second fleshy wedge at the jaw for a mouth. Both hands on the rifle are bunches of five white sausage fingers._

### village — would pick as real: **the real game**

**The tell:** The near soldier's face: at roughly 90 px it carries a dark gash from the eye to the temple, another across the nose bridge, a third from chin to ear, and a fanged scribble for a mouth. It reads as a beaten man, not a soldier. Second tell: the top quarter of the page is a dead flat cream with no cloud, no gradient and no value — the reference always puts something in its sky.

**Scores:** linework 5 · banding 6 · temperature 6 · paper 6 · hatching 4 · palette 7 · form 3 · composition 5 · materials 6 · atmosphere 5 · hud 8 · wow 4

**Worst axis:** form

_A bare earth yard between two half-timbered ranks with pink-orange pantile roofs, a picket fence and a bush at left, sandbag lozenges in the near-left corner, three Imperial soldiers with ruled name labels, a helmeted soldier at close range bottom-centre-right, and a flat cream sky occupying the top quarter of the frame with nothing in it._

### overview — would pick as real: **the real game**

**The tell:** The Edelweiss. It is a heap of pale cream boxes with no turret, no gun barrel, no track run and a heavy ink outline that traces an amorphous blob, with a soldier standing inside its silhouette — and the object is the labelled hero vehicle. Second tell: the three squad members are chopped by the control-legend strip along the bottom edge, one bisected at the waist.

**Scores:** linework 6 · banding 6 · temperature 7 · paper 7 · hatching 5 · palette 7 · form 3 · composition 7 · materials 7 · atmosphere 7 · hud 8 · wow 6

**Worst axis:** form

_High three-quarter view of a stone bridge crossing a green river, a mill town of cream buildings with pantile roofs along the top, a large tree closing the right edge, a green bank in the bottom-right, three soldiers walking up the near bank at the bottom of the frame and a pale mass labelled Edelweiss on the bridge ramp. Field-journal HUD cards at the corners._

### dusk — would pick as real: **the real game**

**The tell:** The near field has no highlights at all — measured p95 of 102 across the bottom 45% of frame, against the real vc-104's 188 in the same band. The foreground soldier disappears into it and his head reads as a bare pale skull. A CANVAS dusk warms and lowers the key; this crushes it and goes cold-green.

**Scores:** linework 5 · banding 4 · temperature 4 · paper 5 · hatching 4 · palette 5 · form 4 · composition 6 · materials 4 · atmosphere 4 · hud 8 · wow 3

**Worst axis:** atmosphere

_A low evening view across a field toward a windmill on a hill, tall trees and telegraph poles at left, a village and a pale tank at right, three soldiers scattered across the field, the nearest at bottom-centre seen from behind. The near half of the frame is an almost black-green mass with harsh horizontal streaks; the far half is drained to near-white._

### command — would pick as real: **the real game**

**The tell:** The Edelweiss is pure white paper with two thin green stripes — the same value as the bridge ashlar beside it, with no turret ring, no track and no shadow anchoring it. It reads as a die-cut counter placed on a board, which is exactly what a fan build does when the vehicle's rendered value was never checked against its surroundings.

**Scores:** linework 6 · banding 5 · temperature 5 · paper 7 · hatching 4 · palette 5 · form 3 · composition 7 · materials 5 · atmosphere 5 · hud 9 · wow 6

**Worst axis:** form

_A top-down tactical map of the bridge sector in browns and dust, criss-crossed with faint violet meander lines, blue and red standing figure markers with weapon pennants, a white tank silhouette in the middle, a roster column of six illustrated unit cards down the left, an objective panel top right, six order cards splayed along the bottom, a tactical survey inset and a red END TURN ribbon._

### firefight — would pick as real: **the real game**

**The tell:** The RATTA lettering measures rgb(236,196,31) at sat 0.867 — a pure cadmium yellow at near-maximum chroma with a hard bevelled contour and a drop shadow. The real game's onomatopoeia in vc-104 measures rgb(183,128,84) at sat 0.539, a muted burnt orange with a rough painted edge. Ours is 1.6x the chroma and reads as a vector graphic pasted on the render.

**Scores:** linework 6 · banding 6 · temperature 6 · paper 6 · hatching 5 · palette 4 · form 5 · composition 7 · materials 6 · atmosphere 6 · hud 6 · wow 5

**Worst axis:** palette

_A shocktrooper in a salmon jacket fires from a bridge parapet toward a village; RATTA in large yellow display lettering sits in the upper-middle of the frame with muzzle flash beside it; damage numerals 61 CRITICAL and 34 float over red splashes; a lancer and a supporting soldier stand on a bright green bank at right._

### squad — would pick as real: **the real game**

**The tell:** The teal figure's leggings are a blown near-white with zero modelling — a value hole in the middle of the frame, brighter than the sky behind her. Valkyria's Alicia wears cream leggings that always carry at least one shade band. Second tell: the lancer's launcher runs off the right edge ending in a salmon-pink tip, and a stray blue ring floats on the ground unattached to any unit.

**Scores:** linework 6 · banding 6 · temperature 6 · paper 6 · hatching 5 · palette 6 · form 4 · composition 6 · materials 6 · atmosphere 6 · hud 8 · wow 5

**Worst axis:** form

_Four soldiers on a sunlit woodland verge under heavy green canopies — a shocktrooper in red and blue at left, a small figure at centre, a girl in a teal jacket and white leggings right of centre, a lancer with a shouldered tube at the right edge. Dappled shadow across a sandy path. A thin blue ring sits on the ground near the centre figure._

### grass — would pick as real: **the real game**

**The tell:** Single-pixel red and cyan specks scattered through the grass — chromatic speckle from the blade cards, visible at 100% across the whole near field. Nothing painted has isolated complementary dots in it. Second tell: the objective ring is sliced in half by the frame edge with its caption cut off mid-word.

**Scores:** linework 6 · banding 6 · temperature 6 · paper 6 · hatching 5 · palette 6 · form 5 · composition 5 · materials 6 · atmosphere 6 · hud 8 · wow 5

**Worst axis:** composition

_Third-person view from behind a soldier in a tan greatcoat walking through a bright green meadow toward a line of tall trees; a second figure at left near farm buildings, a third at right on a track, a half-visible blue objective ring at the right edge labelled GALLIAN._

### action — would pick as real: **the real game**

**The tell:** The Czech hedgehogs are lavender-grey girders — the only cool-violet objects in a warm frame, and they read as plastic. Beyond that the near figure is cropped so hard by the right edge and the ammunition card that only a teal shoulder and a hair mass survive, which no shipped screenshot would do to its own protagonist.

**Scores:** linework 6 · banding 6 · temperature 6 · paper 6 · hatching 5 · palette 6 · form 5 · composition 7 · materials 6 · atmosphere 6 · hud 8 · wow 5

**Worst axis:** form

_Down-the-bridge view with a teal-jacketed figure at the right edge in the near field, a running soldier mid-deck, sandbag courses and boulder piles along the left parapet, half-timbered buildings on the far bank with lavender-grey anti-tank obstacles in front of them, two labelled Imperials._

### tank — would pick as real: **the real game**

**The tell:** The hull renders rgb(172,147,113) at sat 0.345 — 46% brighter and 82% more chromatic than the real Imperial tank in vc-104 at rgb(118,105,95) sat 0.190. It sits at almost exactly the value of the road behind it, so the silhouette is carried entirely by the ink line rather than by tone. Also the lancer's warhead is a salmon-pink lozenge that reads as wrapped meat.

**Scores:** linework 7 · banding 7 · temperature 7 · paper 7 · hatching 6 · palette 6 · form 7 · composition 8 · materials 8 · atmosphere 7 · hud 8 · wow 7

**Worst axis:** palette

_A dust-tan medium tank in three-quarter view on a river embankment, gun traversed right, windmill and village behind, a soldier with a shouldered rocket tube at right, two more figures on a track beyond. Track run, road wheels, tow hooks, spare-track links and a white star insignia are all legible._

### bridge — would pick as real: **the real game**

**The tell:** The near foreground — the bottom-left dark wedge and the flat teal water sheet in the bottom-right — carries almost no drawing: p1 of 53 and a range of 183 against the reference's 32/209, so the frame never reaches a true dark. The real game always plants something with ink weight in the near corner. This is the closest thing in the build to a genuine coin-flip and it is very nearly there.

**Scores:** linework 7 · banding 7 · temperature 8 · paper 8 · hatching 6 · palette 8 · form 7 · composition 9 · materials 8 · atmosphere 8 · hud 8 · wow 8

**Worst axis:** hatching

_A three-arch ashlar bridge spanning a green-teal river, seen from the near bank; a windmill on a rise behind, half-timbered buildings and sandbag emplacements on the right bank, two small figures on the parapet, one seated under the near arch. Loose grey pencil construction lines run around the frame margin._
