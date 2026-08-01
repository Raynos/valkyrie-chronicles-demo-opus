# Visual Critique Rubric — "Is this Valkyria Chronicles Remastered?"

The critic agent is given ONE screenshot from our build and must judge it against its knowledge
of *Valkyria Chronicles Remastered* (PS4, 2016 — SEGA CANVAS engine). The critic's default
verdict is **REJECT**. It only passes a shot when it would genuinely mistake it for the real game
in a blind test.

## Render your own frame (round 15's most expensive lesson)

**A critic must never judge a pre-existing `shots/*.png`.** Render the shot yourself, with the
authoritative single-shot tool, and judge only that file:

```bash
node tools/shoot.mjs <shot> /tmp/claude-501/<shot>-<yourname>.png          # ~1.6 s, for looking
node tools/shoot.mjs --cold <shot> /tmp/claude-501/<shot>-cold.png        # ~11 s, for MEASURING
```

Use the fast resident path to look at a frame and the `--cold` path for any number you quote:
the resident renderer sits at a broad ~1.7 LSB offset from cold, which is invisible to the eye
and larger than some of the deltas critiques have argued over. `docs/HARNESS.md` has the table.

Round 15 lost a whole agent's work to this. The old batch harness booted once and re-posed the
world per shot, and the `tank` plate came out carrying the **`aim` shot's over-the-shoulder camera** —
proven by a cold re-render differing from the shipped plate by **mean 35.8 LSB** while matching the
`aim` frame. The verifier dutifully reviewed the corrupt frame, reported "the Edelweiss is cropped
into an unreadable pale deck", and scored a round of genuinely good running-gear work as a failure.
The frame was wrong, not the work.

Two rules follow, and they are cheap:

1. **Critics and fixers render their own frames**, always, with `shoot.mjs`. It is ~1.6 s.
2. **A claim that a shot looks wrong must be checked against a cold render before it is believed** —
   including when the claim comes from a previous round's critic.

The leak itself is fixed: `captureShots.js` now runs `resetShotState()` at the top of `runShot()`,
and `node tools/shoot.mjs --verify <shot>` asserts a shot is reproducible across an intervening
shot. Render your own frame anyway — it costs 1.6 s.

## The blind test protocol

For each shot the critic must answer, in order, without hedging:

1. Describe what you see, literally, as if you had never read this brief.
2. If this image and a real *Valkyria Chronicles Remastered* screenshot of the same subject
   were placed side by side and shuffled, **which would you pick as the real game, and what
   specific pixel-level tell gives ours away?** Name the tell. There is always a tell — find it.
3. Score each axis below 0–10. Any axis below 8 = REJECT.
4. Give at most 6 concrete, implementable fixes, each naming the file/system responsible and
   the specific parameter or algorithm to change. "Improve the lighting" is a useless note and
   will be rejected as a critique.

## Scoring axes

| # | Axis | What a 10 looks like |
|---|---|---|
| 1 | **Linework** | Graphite outlines with *variable* width — fat on silhouettes, hairline on interior creases, visibly wobbly, with tooth/grain, and a faint double-stroke. A uniform 1px dark edge scores ≤3. Lines must not crawl or shimmer. |
| 2 | **Watercolour banding** | Lighting quantised to 3–4 bands whose boundaries bleed irregularly, like pigment on wet cold-press. Smooth PBR falloff scores 0. Hard aliased steps score ≤4. |
| 3 | **Colour temperature** | Lit = warm cream/straw. Shade = violet-blue, hue-shifted from albedo, never neutral grey, never black. Darkest pixel in frame is a warm brown-violet, not #000. |
| 4 | **Paper substrate** | A convincing cold-press fibre grain multiplies the frame, strongest at midtones, gone in highlights. Must read as *paper the scene is painted on*, not a noise overlay on a 3D render. |
| 5 | **Hatching** | Pencil cross-hatch in the darkest bands, screen-aligned, constant stroke width regardless of depth, with drawn-looking jitter. |
| 6 | **Palette discipline** | Desaturated sage/olive greens, ochre and umber earth, dusty brick red, cream highlights, muted teal-grey sky. Any saturated video-game green, pure blue sky, or neon accent = automatic REJECT. |
| 7 | **Form & silhouette** | Characters read instantly by silhouette; stylised-realistic proportions; clean smooth-shaded forms with no faceting, no candy-wrapper joints, no interpenetration. |
| 8 | **Scene composition** | Reads like a page from an illustrated wartime memoir: clear focal subject, depth layering (foreground framing / midground action / atmospheric background), believable set dressing density. Not an empty plane with objects scattered on it. |
| 9 | **Materials & detail** | Terrain shows layered ground materials, not flat vertex colour. Buildings have tile, stucco, timber, damage. Vegetation has volume and variety. Nothing looks like an untextured primitive. |
| 10 | **Atmosphere** | Aerial perspective / haze with distance, generous warm bloom, believable sun direction and long soft shadows, sky that grades correctly. |
| 11 | **HUD** (UI shots only) | Illustrated field-journal book styling — cream deckled paper, ink rules, red ribbon, serif type, hand-drawn icons. Any default sans-serif, any flat rectangle with a hex fill, any browser-default control = REJECT. |
| 12 | **The "wow"** | Would a stranger scrolling past stop on this image? Does it look *authored* rather than *generated*? |

## Automatic rejections

- Any visible WebGL default look: smooth Phong falloff, uniform ambient, grey fog.
- Z-fighting, shadow acne, peter-panning shadows, visible LOD pop, aliased edges.
- Floating objects, geometry clipping through terrain, feet not planted on the ground.
- Repeating textures with an obvious tiling period.
- Empty regions of frame with nothing to look at.
- Anything that reads as a debug view (wireframe, gizmo, un-styled text).
- Pure black or pure white pixels in the shadow/highlight ends.

## Metric integrity — how these numbers get gamed

Every measurement below has been satisfied at least once without the picture improving.
When you measure, measure the thing, not its proxy.

**The banding plateau count is the worst offender.** "A luminance scan across a shaded mass
shows ≥3 plateaus of ≥12 samples" is satisfiable two ways: by *lighting a form* so the
quantiser lays washes across it, or by *painting hard albedo patches* so the scan crosses
colour boundaries. Round 11 found the codebase had done the second — `rig.js` states outright
that three albedo zones "put hard albedo AND hard value steps across the torso, so a vertical
scan finds plateaus instead of the ramp every round so far has measured." The metric passed.
The soldier came out looking like he was wearing camouflage instead of a uniform, because the
value steps were painted on rather than lit.

So, when measuring banding:
1. Sample **within a single albedo zone** — one continuous piece of cloth, one stone face, one
   patch of grass. A plateau that ends where the colour changes is not a band.
2. Check the **terminator follows the form**: a real band boundary curves around a body and
   wanders irregularly (pigment into wet paper). A straight vertical or horizontal edge is an
   albedo seam or a construction seam, not a wash.
3. Confirm the same surface bands **differently under different light** — re-render the shot at
   another sun azimuth. Painted-on steps do not move; lit ones do.

The same caution applies elsewhere:
- **Hatch dark:lit energy ratio** can be passed by darkening the lit half rather than putting
  strokes in shadow. Check the strokes are actually *there*, and that they sit where a crease is.
- **Cast-shadow LSB delta** can be passed by darkening the whole ground. Check the *un*occluded
  ground did not move.
- **Frame violet fraction** can be passed by tinting everything violet. Check lit surfaces still
  read as their own hue.
- **Contact-shadow footprint counts** can be passed by moving the sampling annulus. State the
  annulus you used and why.

If a metric and the picture disagree, the picture wins — say so plainly and explain what the
metric was actually measuring.

## Where the violet actually comes from (round 12 archaeology)

Four rounds tried to fix "shade is violet / lavender stonework" by turning knobs that are not
the cause. Measured, on `bridge`, shaded stone sits at **hue 259.4, sat 0.168, val 0.537** —
a 219 degree rotation from its own albedo (`0xbdb09a`, hue ~40). Ruled out by direct test:

- `SURFACE_PIGMENT.masonry.violet` (`world/worldMaterials.js`): moved 0.78 -> 0.34. Shaded stone
  hue did **not** move (259.4 -> 259.4) although 5.23% of the frame changed. Not the cause.
- `uShadeTurn` (`render/materials.js:1464`) is 34 degrees total, applied as `*0.30` and `*0.78`
  in two places. It cannot produce a 219 degree rotation. Not the cause.
- `uPaperWhite` is a correct cream (250,244,230). Not the cause.
- The haze uniforms: `uHazeStart` 9 -> 20 and `uHazeMax` 0.70 -> 0.60 moved `bridge` sd only
  30.66 -> 30.91. Not the cause of the flat value range either.

The actual mechanism, which `materials.js:1168-1174` already describes: at low saturation the
shaded hue is set by the **ambient**, not the albedo. The hemisphere sky fill is `0xa9c0cc`
(hue ~200, blue-grey), and the pipeline's contact wash then "raises BLUE against green, which
on a still-red-dominant pigment produces MAGENTA and on one whose green has already been
brought up produces violet."

So: to change the hue of shade, change the **ambient colour and the contact wash**, in
`render/lighting.js`'s sky-fill ramp and the contact pass in `render/canvasRenderPipeline.js`.
Per-material violet knobs only scale how much of that ambient reaches the deepest wash; they
cannot change what colour it is.

## The shade pole, and why picking its hue does not work (round 13)

Round 13 correctly moved the fix to the right layer: the shade "pole" colour in
`render/lighting.js`, which is what a low-saturation surface's shaded hue actually resolves to.
Swapping the violet pole `0x5d5080` for a slate `0x54585c` took shaded masonry from **hue 259.4
(violet) to 99.0 (moss green)** while leaving lit surfaces untouched (lit bank hue 43.6 -> 51.2,
value unchanged) and preserving the cast shadows (under-arch water 71.16 -> 63.92 LSB below open
water, open water itself unmoved). That is the right mechanism and it should stay.

But **choosing a better pole hue does not solve it.** Measured, sweeping only the pole's chroma at
a constant ~213 degrees:

| pole | measured shaded-stone hue | reads as |
|---|---|---|
| `0x54585c` (sat 0.09) | 99.0 | moss green |
| `0x4c5766` (sat 0.24) | 162.9 | teal grey |
| `0x44536b` (sat 0.36) | 192.0 | **blue-violet blockwork** — back near the original defect |

Two lessons:

1. **The metric misleads here.** At `0x44536b` the median shaded hue reads 192, nominally a
   respectable grey-blue, but the frame shows blue-violet brickwork: the median is averaging dark
   mortar lines with the block faces, and the blocks are well off it. Sample block faces
   specifically, and always confirm against the picture.
2. **The pole DOMINATES the albedo, and that is the actual defect.** Weathered limestone in shade
   should be its own warm grey-buff, cooled a little. Instead the shaded hue tracks the pole
   almost regardless of what the surface is made of, which is why every pole choice yields a
   uniformly-tinted frame in some hue or other. The fix is to reduce **how much** the pole glazes
   over the albedo in the deepest washes — so the surface keeps its identity and the skylight only
   cools it — not to keep hunting for a pole colour that happens to look acceptable on stone.
   Settled at `0x4c5766` (hue 162.9) as the least objectionable of the three pending that work.

## The violet came back through the INK FLOOR (round 15)

Rounds 12–14 closed "shade is violet" at the ambient/pole layer, and that fix held — r15 measured lit
surfaces keeping their own hue and the shade family reading as cool grey-buff. **Round 15 then
re-introduced violet through a completely different door**, while chasing a legitimate and unrelated
goal (value range).

The legitimate goal: the frame was compressed into midtones with no near-ink darks, so nothing
snapped. `min L 42.4`, `p1 67`, only `1.49%` of pixels below L 70. Lowering the ink floor was right,
and it worked — `min L 26.1`, `p1 47`, `10.4%` below 70, with `p99` held at 221.

The regression: the floor was *re-authored darker without being re-authored warm*.

| uniform | before | after | effect |
|---|---|---|---|
| `uInkBlack` | `0x3c3947` (L 59, hue ~253, sat 0.20) | `0x2b2333` (L 39, hue 270, sat 0.31) | deeper, **+17° toward magenta, +55% chroma** |
| `uInk` | `0x342e33` (L 48) | `0x241d26` (L 32) | same drift |
| green clamp | `max(g, min(r,b))` | `min(r,b) * 0.90` | deliberately weakened the guard that prevents exactly this |

Measured consequence on `closeup`: the mean of all frame pixels below L 45 went from **hue 23.0 /
sat 0.423** to **hue 282.6 / sat 0.137**; the hero's silhouette ink went hue 232.7 → 281.9 and the
face-profile ink 244.2 → 270.1. Every outline on the hero turned purple.

**The lesson is general, and it is the one to carry forward: darkening a colour is not a
luminance-only operation.** Any change to a floor, a black point, or a shadow end must re-author hue
and chroma at the new luminance and be measured there — an sRGB triple that reads as a neutral
warm-slate at L 59 reads as saturated violet at L 39, because chroma is roughly scale-invariant
while the eye's tolerance for it is not. And when a guard clamp exists specifically to stop a
documented defect (here, green being pulled below both red and blue), **weakening it to make a
different metric move is how you re-enter a dead end you already paid to escape.**

Acceptance test for any future ink-floor work: the mean of frame pixels with `L < 45` must land
**hue 12–45, sat 0.18–0.32**, with `min L <= 30` and `p99` within 2 LSB of 221 — i.e. prove you kept
the depth *and* the warmth, in the same measurement.

## The shade-turn pendulum — five rounds of violet, then zero turn (round 16)

**Read this before touching the shade turn again.** The project has now overshot in BOTH
directions, and the two failures look nothing alike from inside a round.

| rounds | glaze weight | measured shaded-vs-lit hue | reads as |
|---|---|---|---|
| 12–14 | 0.48–0.69, chromaticity *substituted*, clamped to 242–290° | +219° rotation off albedo | saturated violet blockwork |
| **16** | driven to ~0 | **Δhue −0.2° (face), +1.5° (sleeve), +0.3° (sand)** across a 70–81 LSB value drop | Lambert falloff under one warm ramp |

Round 16's `closeup` verifier put it exactly right: *"every shaded surface on the hero is the
same hue as its lit side … a CANVAS shade always turns cool away from its albedo, and this
round's violet-removal has driven that turn to literally zero."* `closeup` scored temperature
**2/10** and its average went **down**, 4.6 → 3.8, while the violet defect it was fixing was
already closed.

**The knob is the MIX WEIGHT, not the hue.** Round 13 ruled out hue-hunting by measurement
(sweeping pole chroma gave moss 99° / teal 163° / blue-violet 192°, all wrong). Round 14 removed
the chromaticity substitution and the violet clamp, which was correct and must stay. Round 16
then took the weight to zero, which is the opposite error: a surface that keeps 100% of its own
chromaticity in shade is not painted, it is shaded.

The target is a **bounded, non-zero** turn — the surface keeps its identity and the skylight
cools it:

- stone, grass and cloth must still shade to three *different* hues (the r14 acceptance test), AND
- each must shade to a hue measurably **cooler than its own lit side** — the r16 test that was
  missing. Require **8–25° of cool rotation**, not 0 and not 219.
- Sample lit and shaded patches of the *same* albedo zone and report both hues. A single
  "shaded hue" number cannot distinguish "no turn" from "correct turn" and that is how round 16
  passed its own checks while the picture went flat.

Owners: the glaze weight in `render/lighting.js`, applied at `render/materials.js`'s two
`uShadeTurn` sites (~1168–1174 and ~1464).

## Measure the thing, not its proxy — 24 refuted claims in one round

Round 16's three verifiers refuted **24 of the fixers' claims**. Almost none were dishonest; they
were acceptance tests that measured something adjacent to the defect. This is the single most
expensive recurring failure in the project, so the specific traps:

- **A "darkest pixel per row" tracker walks onto whatever is darkest.** A fixer proved 56–66 px of
  sleeve taper; the tracker had walked onto the *rifle stock's* outline against open sand. Tracing
  the actual tunic silhouette gave 12 px of excursion that then held dead straight for 25 rows —
  the ruled line the finding was about.
- **A horizontal scan across a figure crosses its OUTER CONTOUR first.** A fixer read
  `133 113 | 48 44 47 | 60 87 84` as "a 3 px ink welt between two lit masses"; the 133–137 to the
  left was open *sand*, not a lit leg. The interior welt did exist — 30 px lower.
- **Fix every instance, then verify the one you did not fix.** The hand weld was applied to the
  trigger hand and verified on the trigger hand. The fore hand still showed five isolated pale
  islands — the r15 defect verbatim.
- **"Brightest pixels are sky, deliberately exempt"** — 1209 of 1236 were the HUD caption card.
  Bin your outliers spatially before you attribute them.

So: **state the region you sampled, why that region isolates the defect, and what ELSE could be
in it.** If a statistic moved but the picture did not, the statistic was measuring something else
— say so and re-measure.

## Output contract

The critic returns strict JSON:

```json
{
  "shot": "overview",
  "verdict": "PASS" | "REJECT",
  "blindPick": "ours" | "real",
  "tell": "one sentence naming the single most damning giveaway",
  "scores": { "linework": 0, "banding": 0, "temperature": 0, "paper": 0, "hatching": 0,
              "palette": 0, "form": 0, "composition": 0, "materials": 0, "atmosphere": 0,
              "hud": 0, "wow": 0 },
  "fixes": [ { "system": "src/render/canvasRenderPipeline.js", "problem": "...", "change": "..." } ]
}
```

`verdict` may only be `PASS` when every scored axis is ≥8 **and** `blindPick` is `"ours"` or the
critic states it genuinely could not tell.

---

## Round 25 — four dead ends and one false wall, all measured

Recorded so no future round re-derives them. Each was found by an agent that reported an honest
negative result, which is why they are worth more than the fixes around them.

### A full-frame `mix-blend-mode: multiply` DOM layer is a hard p99 ceiling

The project chased p99 in the **shader** for twenty-four rounds while carrying **two** full-frame
multiply layers in the DOM — `.vc-vignette` and `.vc-fibre` in `ui/style.js`. A multiply layer caps
the maximum achievable luminance at `base * (1 - a + a*ink)` no matter what the renderer outputs.
The grade agent raised its own paper-lift uniform to maximum, measured **no movement in p99 at
all**, and only then went looking outside its own file.

**Rule: before attributing a whole-frame tonal limit to the renderer, ablate every DOM layer
composited over the canvas and re-measure.** With both layers ablated the ceiling was still 227 —
which correctly redirected the search to the falloff's sky and near-depth gates.

### `renderScale` is not the only harness blind spot — `dt = 0` freezes damped readouts too

The resident settle runs at `dt = 0` by design (the frozen shutter). That freezes **every**
`damp()`-driven HUD value at whatever `resetShotState()` left in it, not just CSS animations. The
symptom was an `aim` plate reading **"0% Hit" beside "Solution: Locked" and "84 expected"** — which
looked exactly like a broken forecast and was not: the game layer was publishing `chance: 0.99` at
that frame. Two agents disagreed about it in good faith because neither owned both files.

**Rule: a readout that disagrees between `--cold` and the resident path is a harness artefact until
proven otherwise.** Grep `damp(` in `ui/hud.js` before believing any HUD number on a fast-path plate.

### Suppressing an albedo map cannot remove a mark the crease term is cutting from geometry

Two separate agents tried to remove the "surgical mask" on rank-and-file faces by gating the face
**albedo** map (`dm`), and both measured **no visible difference at all**. The mask was the
shock/lancer **chin strap** — 8.5 mm of near-black leather crossing the cheek — and the residual
scribble around it is cut into the **skull surface**, where the composite's crease term inks any
sufficiently hard normal discontinuity.

**Rule: the crease term sees normals, not albedo.** If a mark survives zeroing the albedo map, it is
geometry or it is the crease term's weight — and the crease term has no per-material gate, so a
face gets inked on exactly the same terms as a riveted tank plate.

### A "the mesh cannot deform past here" wall that was never there

`finish_plan.md` recorded, for two rounds, that anime face proportions were blocked because "the
parameters are already at the edge of the range the mesh deforms cleanly over", evidenced by a
"degenerate pale wedge" at `nose 0.62`. An agent probed the skull displacement's clamp across
**25,600 sampled directions at every parameter value and found it is never hit — 0.00%**. The real
cause was a sub-millimetre depth coincidence: the nose is a separate tube whose stand-off *and*
radius both scale with `f.nose`, so at 0.62 two of its seven stations sat 0.6–0.7 mm **behind** the
skin instead of proud of it. Three lines, and the wall was gone.

**Rule: a recorded blocker with a plausible mechanism and no measurement behind it is a hypothesis.
Probe it before planning around it.** This one cost two rounds of scope.

### Densifying the village sealed the mission's win condition into a 17-cell island

`_placeBuildings` went 13 → 19 buildings at a clash clearance of 8.2 → 3.9 m to make the street read
as two continuous frontages — the right art call, made by an agent that even wrote "this is also the
number that decides how wide the AI's path through the village is" in the same diff. Nothing enforced
it. `nav.findPath(squad → Imperial flag)` then returned null at 24k *and* 200k maxNodes, because the
goal was in a different connected component: 17 cells against the squad's 10,613.

**Rule: any change to building placement, footprints or colliders must run the nav acceptance test
before it ships.** It is one probe and it is definitive:

```js
vc.battle.nav.findPath({x: 2.75, z: 52.25},
                       vc.battle.camps.find((c) => c.id === 'imperial').pos, {}) !== null
```
