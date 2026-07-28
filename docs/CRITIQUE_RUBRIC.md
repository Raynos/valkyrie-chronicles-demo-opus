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
