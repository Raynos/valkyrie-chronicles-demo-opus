# r25 VERDICT — characters

**Verdict:** REJECT  ·  **Publishable:** false

## Summary
The faces are still the thing that kills this, and at closeup range Alicia's head is not "not yet an anime head" — it is a disfigured one. At 3x zoom her face is a field of thin pink-brown interior strokes reading as wrinkles and cracked plaster, with a hard fold running ear-to-nose that the code's own comments call "a surgical mask over the lower face" and claim to have switched off for authored leads (`dm = 0`, rig.js:4306). It is still there on a lead, so that fix did not land — which means the mask is geometric (the §4c nasolabial trench in the skull displacement, and faceMasses' lower-face pads), not the albedo map that got gated. Second: the character art fails hardest from BEHIND, which is the framing every gameplay camera actually uses. In `action` Alicia's head from the rear is a salmon lozenge sitting on a flat brown paddle — no cranium, no neck, no lock separation, no headscarf knot; in `firefight` Rosie's head is a smooth pale teal dome with a round specular highlight and no hair mass anywhere, i.e. the "bald dome" defect the r25 comment says it cured, cured into a different hue and then blown back up to a pale value by the key light exactly as that comment predicted would happen with red. Third: the fore hand on the rifle in `closeup` is five separate pale beans each carrying a full-weight dark contour — the r15 "isolated pale islands" defect verbatim, and the trigger hand right below it is correctly merged, so this is the third recurrence of "fix every instance, verify the one you did not fix." Against that, two things are genuinely good and must not be touched: the CAST colour-identity table works — Alicia (teal+white), Rosie (red-orange+blue), Isara (cream+green), Largo (olive) are told apart instantly at 20 m in `squad` and `firefight`, which is a real win over anonymous militia; and Isara's rear three-quarter figure in `firefight` is the single best character render in the set, reading cleanly as a person with legible cloth folds, a satchel, boots and a plausible head. Also worth flagging outside my remit: my cold plates measure sat 0.24-0.28 and ink 5.2-8.5% against the finish_plan's claimed r24 numbers of 0.202 / 4.01 and the reference's 0.19 / 1.8-2.8 — the build has drifted back toward over-inking since those numbers were taken, and interior ink on faces is precisely where that drift is most damaging.

## Best thing (do not touch)
Isara Gunther's rear three-quarter figure in `firefight` (crop x1490-1700, y300-720): the cream poncho carries real fold shading, the satchel and rifle sling read as separate objects, the boots plant, the dark bob sits as a mass on a head with a legible jaw sliver, and the whole thing has one clean silhouette contour with no interior scribble. It is the only figure in four shots I would not immediately pick out as ours. Second, and equally important not to touch: the CAST colour-identity table in character.js:70-195 — Alicia teal+white, Rosie red-orange+blue, Isara cream+green, Largo olive are distinguishable at a glance at 20 m in `squad`. That is the cast-distinctiveness axis genuinely won, and it is the one axis that scores above 7 anywhere in this set.

## Explicitly protected
- The CAST identity table (src/actors/character.js:70-195) — the per-lead tunic/collar/trouser/hair colour assignments. Four leads are told apart at 20 m in `squad` and `firefight`. This is the one thing in the character system that unambiguously works.
- Isara Gunther's build as it stands (character.js:147-161) — cream poncho over green dress, near-black bob, `bare: true`. Her rear figure in `firefight` is the best character render in the set. Do not re-tune her while fixing the others.
- The trigger-hand finger merge (rig.js FRAD = [0.0122, 0.0124, 0.0118, 0.0106] against FPITCH 0.0220). On the closed lower hand in `closeup` it works exactly as the comment claims — four fingers become one scalloped mass with a single contour. The fore hand needs the same treatment; do not undo this one to get there.
- The knuckle-bar tube (rig.js:2708-2716) at its current 0.48 weight — it is the one interior line on the hand that reads correctly, and it is what tells a fist from a mitten.
- The eye assembly's layer stand-offs (character.js:1109-1113, sclera 4.4/6.0, iris 5.2/6.8, pupil 6.0/7.1, catchlight 6.6/7.6). The z-ordering is right and was expensive to get right; only the sclera COLOUR needs changing, not the geometry.

## Blockers (6)

### The 'surgical mask' fold across the lower face is still present on an authored lead at closeup range, despite rig.js:4306 setting `dm = 0` to remove it for leads. A hard-edged lighter wedge runs from the ear to the nose across Alicia's cheek and jaw, bounded by a crisp line, with a second hard crease from nostril to jaw. Because `dm` gates only the ALBEDO modelling map, and the mask survives it, the mark is geometric — section 4c of the skull displacement cuts an actual nasolabial trench with a proud cheek pad, and faceMasses' three lower-face pads in character.js are described in the code's own comment as 'the next suspect'.

**Where:** `src/actors/rig.js:4270-4310 (faceMap / dm) and the §4c displacement block it references; src/actors/character.js faceMasses lower-face pads`

**Fix:** Gate the §4c nasolabial trench and cheek-pad displacement amplitude on `o.castName` the same way `dm` gates the albedo map — take both to 0 for leads — and do the same to faceMasses' three lower-face pads. Acceptance test: cold-render `closeup`, crop (560,140)-(860,440) at 3x, and confirm no continuous hard-edged boundary runs from the ear region to the nose. Verify the mask is geometric first by setting §4c amplitude to 0 alone and re-rendering — that is one render and it settles which of the two suspects it is.

**Effort:** medium

### A dense field of thin interior ink strokes covers the whole face at closeup range, reading as wrinkles on a 19-year-old. The crease term in the outline pass is driven purely by normal difference with no per-material gate, so every subtle curvature change on a skinned head becomes a drawn line. In docs/reference/vc-076.jpg the face carries FIVE marks total (two lash-and-iris eyes, two brow strokes, one nose shadow, one mouth line) and zero interior contour ink on the cheek.

**Where:** `src/render/canvasRenderPipeline.js:847-863 (crease term) and :874 (`creaseLine = crease * 0.44 * mix(0.30, 1.0, grain)`)`

**Fix:** Add a per-object crease weight channel alongside the existing `vcOutlineWidth` (materials.js:2338 already threads a per-object width into the G-buffer's `w`), pack it in a spare G-buffer channel, and multiply `creaseLine` by it. Set it to ~0.12 on skin materials and ~0.35 on hair, leaving 1.0 everywhere else. The silhouette term must stay at full weight — the head still needs its outer contour. Acceptance test: cold `closeup`, crop the eye region (700,240)-(820,360) at 7x; no stroke on the cheek plane outside the eye, brow, nose and mouth landmarks.

**Effort:** medium

### Hair reads as a solid cap of colour from every angle. From behind (`action`, Alicia) it is a single flat brown wedge with one hard black outer contour tapering to a point — a wooden paddle, not hair, with no lock separation, no interior value variation and no visible headscarf knot or tails. From the side (`closeup`) it is a bell-shaped shell with exactly one straight parting line drawn on it. In vc-104 Alicia's rear hair separates into four or five distinct locks with visible interior contours, and the red headscarf is tied at the back with a legible knot and two tails.

**Where:** `src/actors/character.js:326 buildHair (the `hairLong` back-mass and lock placement path, ~lines 374-470)`

**Fix:** For `hairLong` leads, replace the single back-mass shell with 4-6 overlapping tapered lock shells at alternating radii (each offset ~8-14 mm in depth so the outline pass finds a real silhouette break between them), each tinted +/-8% in value off `hairColor` so adjacent locks separate under the quantiser rather than fusing into one plateau. Build the headscarf knot as a separate small ellipsoid at the nape with two tapered tails. Acceptance test: cold `action`, crop (1290,470)-(1560,1060); at least three separate lock contours must be visible inside the hair mass silhouette.

**Effort:** high

### Rosie's head from behind is a smooth pale teal dome with a soft round specular highlight and no hair mass — the bald-dome defect in a new hue. Sampled on my cold `firefight` plate the dome runs rgb(104,143,135) to (148,172,147), i.e. a LIGHT teal, well above the authored headCloth 0x35506b = rgb(53,80,107). The r25 comment at character.js:118-134 predicts exactly this failure mode for dark red ('on a domed shell it blows straight back up to the same pale tan') and did not check whether the blue does the same. It does. Her golden hair (0x8a6a34) appears nowhere in the frame.

**Where:** `src/actors/character.js:135 (`headCloth: 0x35506b`) and the gearHead cloth shell that runs crown-to-phi-0.545`

**Fix:** Two changes together, because either alone fails: (a) end the cloth shell at phi ~0.42 instead of 0.545 so a real band of hair shows below it from behind — that is the read the reference gives, a bandana ON hair, not a swim cap; and (b) cap the cloth's specular/key response so the dome cannot exceed the tunic in value — clamp its lit value to <= 0.62 of frame p99. Acceptance test: cold `firefight`, crop (740,440)-(930,720); a contiguous band of hairColor-family pixels at least 15 px tall must be visible between the cloth's lower edge and the collar, and no pixel on the dome may exceed the brightest tunic pixel.

**Effort:** medium

### The fore hand on the rifle barrel in `closeup` is four detached pale beans plus a thumb, each carrying a full-weight dark contour down both sides — the r15 'five isolated pale islands' defect verbatim, and the third recurrence of the rubric's own 'fix every instance, verify the one you did not fix' trap. The trigger hand 200 px below it in the same frame IS correctly merged into one scalloped mass, which proves the FRAD widening works and simply does not survive the open/extended fore-hand pose.

**Where:** `src/actors/rig.js:2652 buildHands, FRAD/FPITCH and the joint-wise curl (MCP/PIP/DIP hinge)`

**Fix:** The radii sum past the pitch only in the curled rest pose; when the hinge curl is reduced for an open barrel grip the capsules separate again. Either drive the fore hand to the same curl as the trigger hand (a rifle fore grip is a closed hand), or make FRAD a function of hinge angle so the capsules widen as the curl relaxes and the merge is preserved at every pose. Acceptance test: cold `closeup`, crop (560,600)-(1000,1000) at 2x; the upper hand must show one outer contour and at most one interior line, matching the lower hand in the same crop.

**Effort:** medium

### The eye has no white. The sclera is authored at 0xc6bcab (character.js:1143), a mid tan that sits within ~15 LSB of the surrounding skin, so at 7x zoom the eye is one muddy teal-brown lens in a socket with no value step, no clean black pupil and no catchlight dot resolving. The code comment at rig.js:175 argues the sclera should be 'NOT paper-white' for the 20 m case, but character.js:1100 states the opposite and correctly: 'that single 150-LSB step is what stops a head reading as a mannequin'. In vc-072 and vc-076 the sclera is near-cream and it is the single loudest mark on the face.

**Where:** `src/actors/character.js:1143 (`const sclera = rgbLin(0xc6bcab)`)`

**Fix:** Raise the lead sclera to ~0xe8dfd0 and keep the rank-and-file at the current tan (the 20 m argument only applies to them). Verify the catchlight survives: the catchlight sits at stand-off 6.6/7.6 in front of the pupil, so a brighter sclera behind it does not erase it, but re-check the limbal ring still separates iris from sclera at the new contrast. Acceptance test: cold `closeup`, crop (700,240)-(820,360) at 7x; a contiguous sclera region >= 30 px at value >= 200 must be visible either side of the iris, and the pupil must measure at least 120 LSB below it.

**Effort:** low

## Blind test, per shot

### closeup — would pick as real: **the real game**

**The tell:** The interior ink field on the face. At 7x zoom the cheek plane carries a dozen thin pink-brown strokes plus a hard continuous fold running ear-to-nose that bounds a lighter wedge over the lower face — a surgical-mask shape. The real game draws exactly five marks on a face at this scale (two lash-and-iris eyes, two brow strokes, one nose shadow, one mouth line) and leaves the entire cheek plane as one unbroken wash. Ours reads as cracked plaster on a mannequin head.

**Scores:** face 2 · hair 3 · silhouette 4 · palette 7 · hands 3 · castDistinctiveness 6 · readsAsAPerson 3

**Worst axis:** face

_A young woman in a teal jacket seen in near-profile from behind-left, filling the left half of the frame, holding a bolt-action rifle diagonally across her body. Behind her a dirt track runs past two pale farmhouses to a river, with a second soldier in red and blue standing mid-ground under a name label, and a wooded hillside beyond. Her hair is a single dark brown bell-shaped mass with a pink-red band across the crown. Her face is a pale tan wedge covered in thin brown strokes, with one dark almond eye, no visible nose in profile, a jaw that juts forward into a point, and a lumpy horizontal mark where a mouth would be. Her lower body is a cream-white mass reading brighter than anything else on the figure. Both hands sit on the rifle as clusters of pale bean shapes. A cream HUD card names her Alicia Melchiott, Scout._

### squad — would pick as real: **the real game**

**The tell:** Rosie's face at 5x. It is a smeared brown mask with one greenish eye, a scribble of horizontal strokes where the mouth and nose should be, and no second eye at all — a shrunken head. Beside it the foreground trooper's face profile is a brown smear with a dark vertical gouge through it. In vc-072 the same head heights (~180-220 px) carry two fully legible eyes with irises, pupils and catchlights, a two-stroke nose and a small clean mouth. Ours has no legible facial feature at any distance in this frame.

**Scores:** face 2 · hair 4 · silhouette 7 · palette 7 · hands 5 · castDistinctiveness 8 · readsAsAPerson 4

**Worst axis:** face

_A woodland clearing on a slope with a dirt track running across it, dappled shadow on grass, scattered rocks and slim tree trunks. Four figures: left, a soldier in a red-brown jacket and blue trousers under a 'Rosie Stark' label; centre-far, a small figure in cream and green; right of centre, a figure in a teal jacket with white legs under an 'Alicia Melchiott' label, holding a rifle; and foreground right, a large olive-uniformed soldier from behind carrying a long tube weapon over the shoulder. A small blue reticle circle floats mid-frame. HUD cards bottom-left and bottom-right._

### action — would pick as real: **the real game**

**The tell:** The back of the head. There is no cranium and no neck — the pink headscarf reads as a balloon resting on a flat brown paddle, and the paddle has one hard black outer contour with zero interior lines. In vc-104, which is the same shot type, Alicia's rear hair separates into four or five distinct locks with visible interior contours, the red headscarf is tied at the nape with a legible knot and two tails, and there is a clear neck and jaw sliver. Second tell in the same figure: her cream lower body measures ~208 luma against a frame p99 of 238 — the brightest thing in the composition is the hero's shins, which is a value inversion the real game never makes.

**Scores:** face 3 · hair 2 · silhouette 3 · palette 6 · hands 2 · castDistinctiveness 6 · readsAsAPerson 2

**Worst axis:** hair

_A rear over-the-shoulder view down a paved street lined with cut-stone block walls and sandbag piles, rising to a two-storey half-timbered building flanked by tank traps and a red-roofed shed. Labels read 'Imperial Späher', 'Imperial Sturmtruppe' and 'Rosie Stark'; a yellow onomatopoeia word sits against the building. A soldier in olive runs away up the street mid-ground. In the lower right foreground, seen from directly behind, a figure in a teal jacket: a broad flat brown wedge of hair with a salmon-pink lozenge sitting on top of it, teal shoulders and sleeves, a khaki pouch centred on the back, and a cream-white lower body. A second, similar figure stands behind it._

### firefight — would pick as real: **the real game**

**The tell:** Rosie's head is a smooth pale teal hemisphere with a soft round specular highlight and no hair below it — a swim cap on a bald dome, and the highlight is straight Phong falloff, which the rubric lists as an automatic rejection. Sampled it runs rgb(104,143,135) to (148,172,147), far lighter than the authored 0x35506b. In vc-108, the equivalent Rosie rear shot, her hair is a large volumetric red-orange mass with separated locks tied at the back and it dominates the head silhouette. Ours has no hair mass at all. Mitigating: Isara at the right edge of the same frame is genuinely good and would not give itself away.

**Scores:** face 3 · hair 3 · silhouette 6 · palette 7 · hands 5 · castDistinctiveness 8 · readsAsAPerson 5

**Worst axis:** hair

_A river valley with a stone arch bridge, a grass bank rising to the right, and a village of pale render and orange-tiled roofs beyond. Red '61 CRITICAL' and '34' damage numerals float over the village with small blood marks. A yellow 'RATTA' word sits centre-right. Centre foreground from behind: a figure in a salmon-pink jacket and blue trousers with a pale teal dome for a head, shouldering a rifle. Right: a soldier in olive shouldering a long tube under a 'Largo Potter' label, and a figure in a cream poncho over a green dress under an 'Isara Gunther' label. Small figures cross the bridge and stand by the water._
