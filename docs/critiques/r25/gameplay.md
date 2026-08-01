# r25 audit — gameplay

**Verdict:** blocker

## Summary
The uncommitted diff in src/game/mission.js must be reverted: it is a straight revert of r23's crossing fix, it directly contradicts the comments sitting six lines above it, and I measured it turning a turn-1 rank-A win into a guaranteed turn-21 timeout loss. It puts Hauptmann Jaeger 2.26 m from the Imperial flag pole — inside the 3.6 m FLAG_RING — so a scout standing exactly on the pole gets contested:true and the camp does not flip; at the committed spawn (5.67 m) the same scout wins the mission on arrival. It also pulls the two Sturmtruppen back to 4.4 m off the north bridgehead, which doubles the cost of the 26 m deck run (36 damage / 14 rounds vs 19 damage / 4 rounds) and turns the crouched crossing from survivable into fatal. Underneath the diff the game is in genuinely good shape: the phase machine, CP/AP economy, empty-sortie refund, interception, AI planner and every win/lose objective all fire correctly, with zero console errors and zero NaNs across a 24,790-frame simulated game. The one architectural hole left is that r22's "a mission that cannot be won must end" rule only covers a total infantry wipe — once the last capture-capable soldier is down, the mission happily runs nineteen more unwinnable turns to the timeout, which I watched happen.

## Do not touch (verified good)
Do not touch any of this — it is all measured working:

• The turn/phase machine (battle.js:484-671). briefing→deploy→command→action→enemy→result all transition cleanly. Verified: selectUnit→phase 'action'; endAction→'command'; CP exhaustion→`_pendingPhase='enemyTurn'` and it actually fires 1.1 s later; endTurn mid-action calls endAction('turnEnded') and leaves activeUnit null; manual endTurn with 7 unspent CP is clean. No deadlock found — drainEnemyTurn (battle.js:1254) has a hard 11.5 s escape that force-ends a stuck Imperial phase.

• The BLiTZ economy. AP decay measured live: 1062→450→288→198→144→108→"exhausted" (6 selections max, AP_DECAY.length). 7 CP/turn player, 6 enemy. Scout 45 m/sortie against an 83.7 m nav path to the flag — two sorties to arrive, which is the right shape. refundEmptySortie (battle.js:649) is a genuinely good piece of design.

• Every win/lose objective fires: take-camp (verified→victory, rank A), rout (verified→victory), lose-tank (verified, and it ended a real AI-vs-AI game on turn 7), turnLimit (verified, turn 21), SQUAD_LOST (verified: 91 frames from the last man falling to the results screen, 6 casualties correctly counted).

• Interception is real and symmetric: 14 tracer rounds put on a scout crossing the deck, damage scales correctly with stance and exposure.

• The AI genuinely plans: floodfill → cheap scoring → LOS/expected-damage shortlist, real paths, crouching in cover, grenades, opportunistic contact shots, class doctrine per role. It is not a stand-still AI.

• The aim HUD in the rendered plate is excellent and correct — the damage table reads TO KILL 02 / SHOTS 05 / VS PERS ○ / VS ARMOR × / AREA ×, and I independently measured expectedDamage 84 vs a 96 HP shocktrooper, i.e. the numbers on screen are real.

• Robustness: `errors: []` on every probe and on a cold render; no non-finite hp/ap/suppression/speed/pos anywhere after a 21-turn, 24,790-frame game.

## Findings

### [blocker | small | verified] Uncommitted mission.js diff reverts r23's crossing fix and blocks the primary win condition

**Location:** `src/game/mission.js:178`

**Evidence:** The diff moves five Imperials and Jaeger back to their pre-r23 coordinates — the exact values the comment at mission.js:167 names as the broken ones ("used to stand at (3,-6) and (10,-10)"), and mission.js:194 ("Jaeger used to spawn 2.3 m from the pole"). The code now contradicts its own comments. Measured in-page (probe, two Battles built from the same seed, one mutated to the committed coordinates):

                                     working tree | committed
  nearest Imperial to north abutment      4.4 m   |  13.3 m
  Jaeger distance from the flag pole      2.26 m  |   5.67 m   (FLAG_RING is 3.6)
  sprint the 26 m deck                36 dmg/14 rnds | 19 dmg/4 rnds
  crouch the 26 m deck                76 dmg DOWNED  | 46 dmg, survives
  Alicia standing exactly on the pole  contested:true, owner stays 1 | owner flips to 0, VICTORY
  Imperials with eyes on the squad, turn 1   3     |   2

And a full scripted playthrough (scouts run the real nav path at full sortie, enemy AI live, seed identical):
  committed spawns   -> victory turn 1, rank A, objective 'take-camp'
  working tree       -> by turn 2 ZERO capture-capable soldiers are still active (3 downed), then 19 dead turns to objective 'timeout', rank D.

The diff has no upside anywhere: resetShotState() calls hideAll() and every one of the 12 shots poses its own cast at hard-coded coordinates (e.g. captureShots.js:1052), so no capture plate reads mission spawn positions. This is a pure gameplay regression.

**Proposed fix:** git checkout -- src/game/mission.js. Do not try to finish it — the committed values are the ones r23 derived from measurement and documented in the comment block at mission.js:165-177 and :192-194.

**Acceptance test:** `git diff --stat src/game/mission.js` is empty. Then re-run a probe asserting, on a freshly set-up Battle: Hauptmann Jaeger's snapped spawn is >3.6 m from camp 'imperial'.pos; both forward Sturmtruppen are >12 m from (4,-2); and standing Alicia on camp.pos then calling updateCamps() gives camp.owner===0 and battle.victory===true.

### [blocker | small | verified] Mission runs to the 20-turn timeout after it has become unwinnable — no capture-capable soldier left

**Location:** `src/game/battle.js:1040`

**Evidence:** squadWiped() only fires when infantryStanding(0)===0. But Largo (lancer) and Marina (sniper) both have canCapture:false, so with the two scouts, the engineer and the shocktrooper down, infantryStanding(0) is still 2 and the mission continues. A downed capturer can never return: rescue() sets deployed=false and bleed-out kills them, so once the last active canCapture unit is gone the 'take-camp' objective is permanently unreachable. Measured: in the scripted playthrough, by turn 2 there were zero active capture-capable soldiers and 15 Imperials on the field; the game then ran turns 3 through 21 with the objective panel still promising twenty turns, and ended on 'timeout'. This is exactly the round-22 defect SQUAD_LOST was written for ("eighteen more turns of one immobile tank"), wearing a different costume — the fix was made too narrow.

**Proposed fix:** Add a sibling failure to SQUAD_LOST (battle.js:42) — e.g. NO_CAPTURERS, fail:true, label 'Someone has to reach their flag'. Fire it from the same per-frame watcher at battle.js:1177 with the same WIPE_GRACE beat when `units.filter(u => u.team===0 && u.active && u.classDef.canCapture).length === 0` AND at least one team-1 unit is alive (i.e. the 'rout' win is also gone). Publish it in publishObjectives() the same way SQUAD_LOST is, so the panel reads honestly before it triggers.

**Acceptance test:** Probe: build a Battle, beginBattle(), run 30 frames, then goDown() every team-0 unit whose classDef.canCapture is true (leaving Largo, Marina and the Edelweiss standing). Run 200 frames. Assert battle.over===true, battle.victory===false, and result.objective is the new id — not 'timeout'.

### [major | small | verified] AI arrival actions (capture, grenade, rescue, repair) are gated on a 0.05 s window against a speed-scaled accumulator

**Location:** `src/game/ai.js:353`

**Evidence:** `if (this.stateT < 0.05) this.doArrivalActions(u, p);` — but update() does `const t = dt * this.speedScale; this.stateT += t;` at ai.js:123-124 BEFORE dispatching, and ai.js:82 sets `speedScale = CFG.capture ? 6 : 1`. At speedScale 6 the very first tickSettling frame already has stateT = 0.1, so doArrivalActions NEVER runs. Measured: in a 20-turn AI-vs-AI game at speedScale 6, Alicia planned kind:'grenade' on essentially every activation of every turn for 20 turns — only possible because u.grenades (max 1 for a scout) never decremented; the same game at speedScale 1 threw grenades, captured camps and rescued bodies normally. Today this only bites capture builds, but it silently disables AI camp capture, grenades, body rescue and tank repair for any future change to speedScale or the sub-step size — and battle.js:1150 already sub-steps the AI at a rate chosen by ENEMY_PACE.

**Proposed fix:** Replace the time window with a one-shot flag: set `this._arrived = false` in startAction() (ai.js:174), and in tickSettling do `if (!this._arrived) { this._arrived = true; this.doArrivalActions(u, p); }`. No timing dependency at all.

**Acceptance test:** Probe: build a Battle, set battle.ai.speedScale = 6, run the Imperial turn to completion. Assert that at least one Imperial's `grenades` count decreased, or (easier) instrument doArrivalActions and assert it was called once per activation at both speedScale 1 and 6.

### [major | small | verified] The Gallian relief wave can never spawn — owning the camp ends the mission

**Location:** `src/game/mission.js:223`

**Evidence:** The wave is `{ turn: 6, team: 0, requiresCamp: 'imperial' }`. battle.js:909 only spawns it if camp 'imperial' is owned by team 0. But captureCamp() calls this.checkObjectives() on the same frame it flips the owner (battle.js:895), and the 'take-camp' objective is win:true — so the mission ends the instant the camp changes hands, always before any later startTurn() reaches the wave. Confirmed by the two victory runs: both ended on objective 'take-camp' the moment the flag flipped. So mission.js:222-228 (Wavy Cranston, Nancy Dufour) is dead content, and the intel line implying reinforcements is a promise the game cannot keep.

**Proposed fix:** Either delete the wave, or change its gate to something reachable — e.g. `requiresTurn: 6` plus a condition the player can actually be in, such as having crossed the river (a unit with pos.z < 0) or having lost two or more soldiers. If you want the relief to be a reward for taking the camp, the camp win has to become a hold-for-N-turns objective, which is a larger change and not worth it for a demo.

**Acceptance test:** Either MISSION_VASEL.waves has no team-0 entry, or a probe reaches the wave's condition and observes a `reinforcements` Bus event with team===0 while battle.over===false.

### [major | small | verified] The 'aim' plate's target stands bolt upright with his arms down, in FRONT of the sandbags

**Location:** `src/game/captureShots.js:1052`

**Evidence:** I rendered `aim` cold and looked at it. The Imperial Sturmtruppe at 23 m is standing at full height, arms hanging at his sides, in the open on the forward side of the sandbag emplacement — the emplacement is behind and to the right of him. The line is `pose(ctx, target, 6.6, -14.0, 0.15, 'idle')`: no stance argument, so it takes the STANCE.STAND default, and the 'idle' clip. This flatly contradicts the comment two lines above at captureShots.js:1050, which says "target dug in at the far bridgehead". Four other Imperials in the same shot ARE posed crouched (captureShots.js:1058). It reads as an enemy who has no idea a war is on, on the one plate whose whole job is to sell the aim mechanic.

**Proposed fix:** Give him the same treatment as his squadmates: `pose(ctx, target, 6.6, -14.0, 0.15, 'crouchIdle', STANCE.CROUCH)`, and nudge z a metre or two further from the camera so he sits behind the sandbag course rather than in front of it. Re-check that the dossier still reads a sensible distance (it currently says 23 m).

**Acceptance test:** node tools/shoot.mjs aim <tmp>.png, then look: the target is crouched, his silhouette breaks the sandbag line rather than standing clear of it, and the HUD dossier still shows a target with a live hit percentage.

### [minor | small | likely] The 'lose-camp' failure objective is unreachable — no Imperial will ever walk to the staging post

**Location:** `src/game/mission.js:242`

**Evidence:** `pushRange: { 1: 52 }` (mission.js:66) caps how far an objective may pull an Imperial, and ai.js:729 refuses to target a camp further than that reach. The Gallian staging post is at (-2, 62), roughly 114 m from the Imperial line — more than twice the cap — so pickObjective() falls through to holdPoints[1] = [10,-22] every time. In every simulated game I ran (three full 20-turn playthroughs) no Imperial ever approached the Gallian camp. The objective is listed to the player as a live failure condition it can never reach.

**Proposed fix:** Either drop the 'lose-camp' objective from the list so the panel stops advertising a threat that does not exist, or make it real by giving the Imperials a counter-attack trigger (e.g. raise pushRange[1] once the player takes ground, or add a wave that spawns with a raised push range). Dropping it is the honest one-line option for a demo.

**Acceptance test:** Either MISSION_VASEL.objectives has no 'lose-camp' entry, or a probe runs 20 turns and observes at least one team-1 unit inside camp 'gallian'.captureRadius.

### [minor | medium | verified] Deployment scatters the squad over 15 m of depth with the engineer alone at the front

**Location:** `src/game/battle.js:319`

**Evidence:** Measured post-deploy positions on the shipped seed: Isara (engineer, 60 HP, the squishiest infantry) at (13.25, 17.75) — the most forward AND the most exposed, 13 m east of the road; Rosie (shocktrooper, 96 HP, the one you actually want in front) 15 m behind her at (5.75, 32.75). autoDeploy() sorts the roster by weightOf() so the heavy classes get the low slot indices, but deploySlots() takes its slots from world.deployPositions() in whatever order that returns, so the sort has no relationship to depth. The result is a start line that reads as random rather than as a formation, on the frame the opening cinematic ends on.

**Proposed fix:** In deploySlots(), sort the returned slot list by distance along the start-line direction (the startLineOffset() vector) before handing it to autoDeploy(), so slot 0 really is the front. That makes weightOf()'s existing ordering mean what its comment at battle.js:449 already claims: "Put the heavy classes closest to the front".

**Acceptance test:** Probe after beginBattle(): assert the deployed shocktrooper's and lancer's z is less than or equal to the engineer's and sniper's z, and that the total depth spread of the six infantry is under 10 m.
