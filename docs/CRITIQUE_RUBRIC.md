# Visual Critique Rubric — "Is this Valkyria Chronicles Remastered?"

The critic agent is given ONE screenshot from our build and must judge it against its knowledge
of *Valkyria Chronicles Remastered* (PS4, 2016 — SEGA CANVAS engine). The critic's default
verdict is **REJECT**. It only passes a shot when it would genuinely mistake it for the real game
in a blind test.

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
