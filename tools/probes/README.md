# Gameplay probes

Run with the introspection harness, which evaluates the script inside the page with
`vc` (= `window.__VC__`) in scope:

```bash
node tools/probe.mjs overview tools/probes/shipgate.js
node tools/probe.mjs overview tools/probes/nav.js
```

## `shipgate.js` — run this before shipping any gameplay change

Asserts the mission is still **winnable and loseable**, and that the bridge is still
passable. Four checks, each ending a turn because `checkObjectives()` evaluates at
turn boundaries and **not** per frame — a probe that only calls `update()` will sit
there forever and tell you the game is broken when it is not.

Expected (r26):

| check | expected |
|---|---|
| `win` | `victory: true`, rank A, objective `take-camp` |
| `loseTank` | `victory: false`, objective `lose-tank` |
| `loseSquad` | `victory: false`, objective `squad-lost`, losses 6 |
| `bridgeStillPassable` | `netNorth` ≈ `intended` (16.5 m) |

`bridgeStillPassable` is the one that catches the two regressions that have actually
happened. Densifying the village once sealed the Imperial flag into a 17-cell island
and made the primary win condition physically unreachable; separately a 1.8 m sandbag
on the bridge deck stopped every body dead at z ≈ −3.2 with seven metres of clear
ground beside it, and `nav` string-pulled paths straight through it. Both were in
builds that otherwise rendered and played fine.

## `nav.js` — the connectivity gate

Cheaper and more specific: asserts `findPath` resolves for the squad start, both
bridgeheads and the Imperial camp. **Run this after ANY change to buildings,
footprints, colliders or nav.**
