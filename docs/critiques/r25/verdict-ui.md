# r25 VERDICT — ui

**Verdict:** REJECT  ·  **Publishable:** false

## Summary
The single most important thing: the HUD's *vocabulary* is genuinely excellent and the HUD's *assembly* is not, and the gap is small and cheap to close. The type system (letterspaced small-caps labels, dot leaders, wobbled ink rules, hatched kraft paper, hexagonal class badges, segmented pigment gauges), the top-centre damage table, the Tactical Survey contour minimap and the hand-drawn order-card icon set are the same family of design as vc-088/104/108 and in two places better than the reference — the dossier's line-drawn soldier with the red dashed ellipse on the aim-point is an invention the real game does not have and should have. That is real, authored work and it must not be touched. What stops it publishing is a handful of assembly defects that are visible in every single gameplay frame. The compass ribbon at the top of `aim` and `action` is clipped by the frame edge, is translucent enough that a chimney renders through it, and contradicts itself (a red "N" and a red heading caret 40 px apart pointing at different bearings). The aim reticle is centred ~65 px ABOVE the soldier it is locked onto and its orange ring cuts through that soldier's own name ribbon, erasing "STURM" — so the one question targeting mode exists to answer, "what am I aiming at", is answered wrongly at the pixel level. The enemy HP ramp is provably unreadable: `icons.js:955` gives `foe` #9c4a3f and `crit` #9d4331, the same colour, with amber `warn` between them, so an enemy at 96/96 and one at 10/285 paint the same red and the middle of the ramp looks healthier than both ends. And the acting soldier has no HP readout anywhere once she sorties. On the specific item I was asked to confirm: the "0% Hit" bug IS fixed and the mechanism in `hud.js:1520-1531` is correct — but cold reads 99% and a freshly-booted resident daemon reads 84% on the same shot, so the two paths do NOT agree, and a stale daemon still served me the old 0% plate on first try. None of the blockers is architectural; four of six are single-file. This is the closest this project's UI has been, and the honest answer to "publish today" is still no.

## Best thing (do not touch)
The dossier card in `aim`: a cream hatched-paper panel with a small-caps/dot-leader row block (Solution / Class / Health / Distance / Aim Point) over a hand-inked front-elevation soldier diagram with a red dashed ellipse marking the selected hit zone. It is period-correct, instantly readable, and it solves "where am I aiming" better than the real game's own UI does. The Tactical Survey minimap (contour lines, scale bar, compass rose, faction chevrons, red selection ring on hatched paper) is a close second.

## Explicitly protected
- The type system as a whole — Cochin/Trajan-ish serif, letterspaced small caps for labels, dot leaders, oldstyle numerals in secondary positions. It is the strongest thing in the build and every panel is consistent on it.
- The top-centre damage table (TO KILL / SHOTS / VS PERS / VS ARMOR / AREA with ○ ×, red 'to kill' numeral, zero-padded). It is structurally identical to vc-088/vc-108, correctly centred on the frame axis, and the numbers are real.
- The dossier's line-drawn soldier body diagram with the red dashed aim-zone ellipse.
- The Tactical Survey minimap panel (contours, 32 M scale bar, compass rose, chevrons).
- The keycap legend strips at the bottom of all three modes — boxed keycaps, small-caps verbs, correctly re-labelled per mode (Tab = Next Soldier in command, Target Part in aim).
- The order cards' hand-drawn icon set (shield-and-check, lightning, SMG, spear, eye) and the red cost pips half-hanging off the card corner.
- The inkGauge construction itself — trough, graphite hatch on the empty run, brushed pigment wash, segment dividers. Only the foe/crit PIGMENT values are wrong, not the widget.

## Blockers (9)

### The compass ribbon at the top of aim and action is clipped by the frame edge, is translucent enough that world geometry (a chimney) renders through it, and contradicts itself — a red 'N' label and a red heading caret sit 40 px apart pointing at different bearings. It is in every gameplay frame and it is the most placeholder-looking element in the build.

**Where:** `src/ui/hud.js — the compass/heading strip; src/ui/style.js for its backing`

**Fix:** Either delete it (nothing in vc-088/104/108 has a compass and the Tactical Survey already carries a rose) or: push its top offset from 0 to ~16 px so the tick strip is not cropped; give the strip an opaque cream paper backing (it currently composites at low alpha over the world); and remove the red colour from the cardinal letter so only the caret marks heading, so the two markers cannot disagree.

**Effort:** 30 min if deleted, ~1 h if kept

### The aim reticle does not sit on its target. The orange ring is centred ~65 px above the locked soldier, the separate white corner-bracket box is ~3× the target's height, and the ring's stroke overwrites the enemy's own name ribbon so the name is unreadable. Targeting mode fails its one job at a glance.

**Where:** `src/ui/hud.js — reticle placement in the targeting update (near _updateTargeting / this.reticlePx), and src/ui/worldLabels.js for the nameplate`

**Fix:** Project the target's actual aim-point world position (the part named in the dossier's 'Aim Point' row) rather than the unit origin/head anchor, and size the corner-bracket box from the target's projected screen bounds instead of a fixed dispersion radius. Suppress the world nameplate for the unit currently locked — its name, class, HP and distance are already in the dossier 300 px away, so the ribbon is pure duplication that only costs legibility.

**Effort:** 2 h

### The enemy HP ramp is unreadable and non-monotonic. icons.js:955 defines foe #9c4a3f and crit #9d4331 — visually the same terracotta red — with amber warn #b8862f between them. An enemy at 96/96 and an enemy at 10/285 paint identical pigment, and the midpoint of the ramp looks healthier than either end. The 96/96 dossier bar renders full and blood-red, contradicting the '96 / 96' text one line below it.

**Where:** `src/ui/icons.js:950-957 (PIGMENT table); consumers at src/ui/hud.js:1756, 2828 and src/ui/worldLabels.js:697`

**Fix:** Make the ramp monotonic and faction-neutral: reuse the existing hp pigment (#818458 olive-green) for the full band, warn amber for 25-55%, crit red below 25% — for foes as well as friendlies, exactly as vc-088 does (its 00110/00110 Imperial scout has a GREEN bar). Signal faction with the panel's red header band and the red name colour, which the build already has, not with the gauge.

**Effort:** 20 min

### The onomatopoeia sprite renders with an opaque background card — the pale rectangle is visible around the letters — and at a size and depth where a crate buries it. It reads as a poster, not lettering.

**Where:** `src/render/fx.js — FxSystem.onomatopoeia() / _weaponWord(), the cached canvas texture and its material`

**Fix:** Clear the word canvas to transparent (ctx.clearRect, no fillRect of paper) and set the sprite material transparent:true with premultiplied alpha; raise the world scale ~2.5× to match vc-108's proportion; set renderOrder / depthTest so the word draws over near-field props rather than being occluded by the first crate in the line of fire.

**Effort:** 1 h

### The acting soldier has no HP readout in action or aim mode. Bottom-left shows name, class and Action Points; bottom-right shows ammunition; nothing anywhere shows how hurt you are. The reference's bottom-right own-unit panel always carries HP with a numeric (00220/00230). You cannot decide whether to break cover.

**Where:** `src/ui/hud.js around :831 (the self panel head/label construction) and the AP bar at :2566`

**Fix:** Add an inkGauge({tone:'hp'}) row with 'HP nnn / nnn' above the Action Points row in the bottom-left self panel, driven from the same unit the AP bar reads. The widget, the pigment and the numeral style all already exist in the roster cards — this is composition, not new machinery.

**Effort:** 45 min

### Identity contradictions between panels of the same UI. Alicia's roster portrait is a dark-haired figure in an olive uniform and green cap; her 3D model in aim and action is auburn-haired in a teal jacket. The Edelweiss roster card — a tank with 1250 HP — uses a human helmeted face as its portrait. Both read as placeholder art the moment you compare two panels.

**Where:** `src/ui/hud.js roster card construction; the portrait source (src/actors/character.js CAST appearance)`

**Fix:** Drive the roster portrait from the same CAST appearance record that dresses the 3D model (hair colour, jacket colour, headgear) so they cannot diverge, and branch the Edelweiss/vehicle case to the tank silhouette glyph already used beside the word TANK on the same card instead of a face portrait.

**Effort:** 2 h

### Cold and resident render paths disagree on the hit forecast for the same shot: --cold reads '99% Hit', a freshly-booted daemon reads '84% Hit'. A stale daemon additionally served the pre-fix '0% Hit' plate on my first attempt. The 0% bug is genuinely fixed (hud.js:1520-1531 snaps the first sample when _hitLast < 0, and the reasoning is correct), but a HUD number that varies 15 points between two renders of one pose is not trustworthy for any screenshot you publish.

**Where:** `src/ui/hud.js:1518-1531 (hitShown snap/damp) and tools/renderd.mjs settle`

**Fix:** The snap only fires when _hitLast < 0, so the resident path is reading a value damped over a prior non-zero reading rather than a fresh one. Force _hitLast = -1 from resetShotState() (captureShots.js) alongside fx.clear(), so every posed shot starts the readout from 'nothing shown yet' and both paths land on the same number. Then re-run shoot.mjs --verify aim.

**Effort:** 45 min

### Text that contradicts itself or is unlabelled jargon. (a) The Tactical Survey key reads 'Gallian Staging Post → HELD' / 'Imperial Base Camp → IMPERIAL' — the right column mixes a status word with a faction word, so 'Held' has no holder. (b) 'Solution — Locked' is firing-solution jargon a player cannot decode. (c) '84 EXPECTED' has no unit, and on the resident plate it sits beside '84% HIT', two identical numerals meaning a percentage and a damage figure. (d) The dossier says 'Class — Shocktrooper' directly under a header reading 'IMPERIAL STURMTRUPPE' — the same unit named twice in two languages inside one card. (e) 'ragnaid' is lowercase on the Resupply order card while Edelweiss, Gallian and Imperial are capitalised. (f) Objective says 'Twenty turns' in words while the turn counter says '03' in numerals, in another panel, so the player subtracts across two cards.

**Where:** `src/ui/hud.js:1763 (Solution row), :2874 (expected), the minimap key, the order-card copy, the objective card`

**Fix:** (a) Print the holder in both rows: 'Gallian Staging Post — GALLIAN' / 'Imperial Base Camp — IMPERIAL', or colour-code and drop the word. (b) Relabel 'Solution' → 'Sight' with values 'Locked' / 'Loose', or drop the row — the reticle already carries that state. (c) '84 EXPECTED' → '84 DMG EXPECTED'. (d) Pick one register: either German unit names throughout with no English class gloss, or English throughout. (e) 'Ragnaid'. (f) 'Turn 03 / 20' in the turn tab and delete the objective line.

**Effort:** 1 h

### Layout slop that reads as unfinished rather than as hand-placed. The bottom-right Ammunition card leaves its left ~45% completely blank. The bottom-left name plate is a hard-edged rectangle while the AP bar directly beneath it has a torn deckled edge, and a tan backing rectangle protrudes above and right of the name plate only. The 'ACTED' stamp on Rosie Stark's roster card is clipped by the card's right edge and overlaps the rank chevron beneath it. The order cards' titles span ~100 px of baseline and the leftmost is occluded by the roster column.

**Where:** `src/ui/style.js (panel edge treatments, .vc-dmg/.vc-ammo widths), src/ui/hud.js (roster stamp, order-card scatter)`

**Fix:** Shrink the Ammunition card to its content or fill the dead half with the weapon silhouette and an ∞/rounds box as vc-088 and vc-104 do — that is the panel the reference is most recognisable by and this is the closest the build gets to it. Apply the same deckled edge to the name plate as the AP bar, or the same rectangle to both, and remove the offset backing. Inset the ACTED stamp by ~10 px and move it above the chevron. Clamp the order-card rotation to ±2° and their vertical offset to ±8 px, and shift the row right so no card sits under the roster column.

**Effort:** 2 h

## Blind test, per shot

### command — would pick as real: **the real game**

**The tell:** The six order cards along the bottom sit at six different vertical offsets spanning ~100 px of title baseline, and the leftmost card ('Caution') is drawn UNDERNEATH the roster column so its left third is occluded by Marina Wulfstan's unit card. A shipped UI does not let one clickable card hide behind another; the real game's order cards are a flush aligned row.

**Scores:** informationDesign 7 · typography 9 · ornament 9 · legibility 6 · consistency 5 · polish 6

**Worst axis:** consistency

_A high three-quarter view of a stone bridge over a river into a village, rendered as an illustrated tactical map in sepia and cream. Left column: a '05 COMMAND POINTS' card with five filled red star pips and two empty, two lines of italic tutorial prose, then seven stacked unit cards each with a portrait box, name, class glyph, rounds count, a green segmented HP gauge with numerals, and a brown range bar with a red end tick. Top-left also carries a 'TURN 03 / GALLIAN' tab. Top-right: an Objective card with a flag icon ('Stand on their flag: Scout, Trooper or Engineer'), crossed swords ('Or destroy every Imperial in the sector'), a rule, then 'The Edelweiss must survive' and 'Twenty turns'. Bottom-right: a 'TACTICAL SURVEY' contour map on hatched paper with red and blue chevrons, a red selection ring, a compass rose, a 32 M scale bar and a two-row key. Bottom-centre: six tipped paper order cards with hand-inked icons and red numeric cost pips. Bottom-right: a red 'END TURN [E]' ribbon. Bottom edge: a boxed-keycap legend. In the world, blue pin-figures mark friendlies, red flag markers mark enemies, and two ribbon labels name the Edelweiss and Alicia Melchiott._

### aim — would pick as real: **the real game**

**The tell:** The orange reticle ring is centred roughly 65 px ABOVE the enemy it is locked onto — the soldier hangs off the bottom rim of the ring — and the ring's stroke passes straight through the enemy's own floating name ribbon, erasing the 'STURM' of STURMTRUPPE. Two different target indicators (orange ring, white corner brackets) disagree about where the target is, and neither encloses him. In vc-088 the orange ring encloses the target cleanly and the enemy's name lives in a dedicated top-left panel that nothing overlaps.

**Scores:** informationDesign 5 · typography 9 · ornament 8 · legibility 5 · consistency 5 · polish 5

**Worst axis:** legibility

_Over-the-shoulder past a teal-jacketed, auburn-haired soldier at lower-left, down a plank bridge toward a half-timbered village. Top-centre: a kraft-tape damage table reading TO KILL 02 / SHOTS 05 / VS PERS ○ / VS ARMOR × / AREA ×, correctly centred on the frame axis. Directly above it, a faint grey compass ribbon with NW / N / NE and a red caret, clipped by the top of the frame. Right: a large cream dossier headed IMPERIAL STURMTRUPPE with an SMG glyph, a red segmented bar, then Solution — Locked / Class — Shocktrooper / Health — 96 / 96 / Distance — 25 m / Aim Point — Torso, over an inked soldier front-elevation with a red dashed ellipse round the torso. Centre: an orange ring reticle with four white dispersion ticks and a corner-bracket target box, sitting over a pale ribbon reading IMPERIAL STURMTRUPPE. To its right a chit with a green arc gauge, '99%', 'HIT', and '84 EXPECTED'. Bottom-left: a hex class badge, 'Alicia Melchiott / Scout', and an AP bar reading 900 / 900, 45 M OF MARCH. Bottom-right: 'AMMUNITION 5 / 5' with five bullet pictograms and 'ZM Kar 8 · reaches 46 m'. Bottom edge: keycap legend._

### action — would pick as real: **the real game**

**The tell:** The 'RATTA' onomatopoeia is drawn on an OPAQUE pale card — the rectangle is plainly visible around the letters, cropped by the crate in front — so it reads as a printed poster nailed to a packing case, not as comic lettering. In vc-108 RATTA is transparent-backed, roughly three times this size, sharp-edged with a heavy dark contour, and drawn in front of the action.

**Scores:** informationDesign 5 · typography 9 · ornament 8 · legibility 5 · consistency 6 · polish 5

**Worst axis:** informationDesign

_Third-person behind a teal-jacketed soldier at lower-right, looking up a cobbled ramp between low block walls toward a half-timbered village. A squadmate runs away from camera mid-frame. Three floating ribbons name 'Imperial Späher' and 'Imperial Sturmtruppe' in red and 'Rosie Stark' in dark ink, each with a thin bar beneath. A small yellow 'RATTA' sits against the house wall, half-hidden behind a crate, on a visible pale rectangle. Top edge: the same clipped grey compass ribbon, with a building's chimney rendering straight through it. Bottom-left: hex class badge, 'Alicia Melchiott / Scout', AP 900/900 bar, 45 M OF MARCH. Bottom-right: AMMUNITION 5 / 5 with bullet pictograms. Bottom edge: keycap legend — WASD Move / Shift Sprint / Ctrl Crouch / RMB-Q Aim / LMB Fire / R Reload / Enter End Action / Esc Pause._
