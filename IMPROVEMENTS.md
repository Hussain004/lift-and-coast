# LIFT & COAST — Improvement Plan

*Written Nov 2026 after a full pass over the codebase. Headline request: make the
drivability better and closer to the real F1 driving experience, then list the
other improvements and features worth adding.*

Everything below was checked against the current code, not guessed. File and
line references point at where a change would land.

## 0. Ground rules this plan obeys

The owner's standing orders (`REVAMP_2.md` appendix) are treated as settled and
are **not** re-proposed anywhere below: no flashback timeline, no bloom or
post-processing, no dynamic lights, no AI difficulty via control-law gains or
cornering-speed scaling (validated pace scales only), **no brake-bias slider**,
nothing adding thrust above the 1750 N cap, no tree LOD, no glTF car model, no
real F1 branding, and no Supabase changes without approval.

Two project facts shape every physics proposal:

1. **Player and AI share one physics path.** `applyCarControls`
   (`lib/physics/vehicle.ts`) is the same function `Car.tsx`, `AICar.tsx` and
   the headless harness call. Any change to grip or brakes is therefore an AI
   change too, and every gate must be re-run:
   `npm run diagnose:line`, `npm run diagnose:ace`, `npm run diagnose:ace-field`,
   plus `tests/vehicle-stability*.test.ts`, `corneringRoll.test.ts`,
   `aiFieldRace.test.ts` and the per-track AI gates.
2. **Definition of done** (`HANDOFF_PROMPT.md` §6): pure logic in `lib/` with
   unit tests, `tsc`/`eslint`/`vitest` exit 0, measured numbers quoted for
   anything that changes how the car drives, README updated when user-visible.

## 1. Where the game stands (verified snapshot)

- **Physics:** Rapier rigid-body (220 kg chassis) + raycast vehicle, fixed
  1/60 s step (`app/race/Scene.tsx`, `<Physics timeStep={1/60}>`). Per-gear
  torque curve gearbox, load-sensitive friction, per-wheel surface grip
  (kerbs/gravel/grass/paved), aero drag + downforce impulse, slipstream tow,
  ERS modes with a per-lap deploy budget, overtake mode, damage multipliers,
  active-aero modes.
- **The designed "skill-based" tire model is only half-wired** — see finding F1,
  the single biggest drivability gap this plan addresses.
- **30 circuits** registered in `lib/tracks/registry.ts` (README says 27 — fixed
  in the cleanup list). Generated racing line with lift/brake zones and quality
  gates (`npm run diagnose:line` hot-laps every circuit).
- **AI:** four difficulty tiers (rookie/club/pro/ace) driven by measured pace
  scales, racing line following with target-speed profile, racecraft
  (overtakes, defence, mistakes, launch), tyre-curve pacing, pit stops,
  safety-car behaviour. Chaos-sensitive; only pace-scale knobs are allowed.
- **Race structure:** practice programmes, one-shot/open/knockout Q1–Q3
  qualifying, quick races, championship weekends (with sprint every 4th round,
  contracts, objectives), daily challenge, four-drill driving school, time
  trial with local + shared ghosts, PeerJS multiplayer rooms at 30 Hz.
- **Race control:** FIA track-limit ladder, steward penalties, super-licence
  points and the 12-point ban, safety car / VSC ceilings, flags, invalid laps.
- **Pit lane:** drivable lane, limiter, interactive release minigame, AI stops,
  drive-through/stop-go serving.
- **Player aids:** assist presets Casual/Standard/Expert, TC/ABS/auto-gear
  toggles, racing-line overlay (full/corners), five assist keys, damage Off/
  Reduced/Simulation.
- **Feel & feedback:** rumble/vibration (kerb, skid, impact), synthesized V6
  audio (shift cuts, overrun, MGU-K whine), chase/cockpit/helmet/T-cam/TV
  cameras, side mirrors, rewind buffer, instant + full-race replay, photo mode.

## 2. Drivability findings — what actually limits feel today

Verified code-level findings, in priority order. Each notes the fix it feeds in
§3.

### F1 — The tire model that was designed was never wired into the live car

`lib/physics/tireModel.ts` contains a complete slip-based model: peak-then-fall
slip curves (`slipCurveShape`), sub-linear load sensitivity, and an enforced
**friction circle** (`computeTireForces`). The original plan (§5 of
`implementation_plan.md`) intended exactly this, "layered on the raycasts".

But a search shows `computeTireForces` is referenced **only by its own unit
test**. The live car never computes slip angle or slip ratio (aside from a
display-only telemetry readout); cornering grip is Rapier's raycast
lateral-velocity constraint scaled by a handful of multipliers
(`applyLoadSensitiveFriction`, `lib/physics/vehicle.ts`), and longitudinal grip
is a fixed brake/throttle strength. Same for `computeWheelLoads`
(`lib/physics/weightTransfer.ts`) — a complete load-transfer model that is
**dead code** (referenced only by `tests/weightTransfer.test.ts`); the live car
reads Rapier's suspension force instead.

Consequences the player feels today:

- **No wheelspin and no lockups.** Full throttle corner-exit cannot light up the
  rears because the raycast wheels don't model slip-based spin; ABS/TC have
  nothing real to correct.
- **No friction circle in the sim.** Trail braking and throttle modulation
  don't trade grip against each other the way the model and README promise;
  braking while turning is only approximated by `combinedBrakeScale` (a flat
  20% trim at speed).
- **No breakaway character.** The lateral constraint never "lets go" past a
  slip angle, so oversteer snap, four-wheel drift and figuratively catching a
  slide with throttle can't happen.

This is the finding F1-level fix (phase A) below.

### F2 — ABS and TC are input shaping, not slip control

- "ABS" is a 0.5 s brake-input ramp (`BRAKE_RAMP_SECONDS`, `lib/input/steering.ts`)
  that exists to stop the chassis pole-vaulting on a step input. ABS-off simply
  lets full brake through instantly.
- "TC" is a throttle scale that only fires below 15 m/s *with steering input*
  (`tractionControlThrottleScale`, `lib/physics/vehicle.ts`) — an anti-launch
  aid, not traction control.

Meanwhile the Rapier controller API exposes everything a real loop needs:
`wheelRotation(i)` (slip ratio from wheel speed vs ground speed),
`wheelForwardImpulse(i)`, `wheelSideImpulse(i)`, `wheelIsInContact(i)`. The raw
wasm API (`rapier3d-compat@0.19.2`) confirms these. Real per-wheel TC and ABS
are implementable today with no engine change.

### F3 — Downforce grip is decorative, not aerodynamic

`computeDownforceN` is `0.5 × v²` newtons — ~450 N (0.21× weight) at 30 m/s and
~1800 N (0.83× weight) at 60 m/s. A real 2026 F1 car generates several times
its weight at high speed. More importantly, **lateral grip does not scale with
downforce**: `applyLoadSensitiveFriction`'s side-friction term is clamped at
1.0 (documented flip trigger above 1.0), and the load-sensitivity exponent is
small, so the downforce→load→grip coupling is negligible at cornering speeds —
`aero.ts` itself documents this ("the load-sensitivity curve barely moves").

The felt effect today: high-speed corners are no more grippy than medium ones
(the opposite of F1, where Copse, 130R and Eau Rouge are full-throttle *because*
of downforce), and low-drag mode is a flat 0.5× grip multiplier rather than an
aerodynamic trade — a penalty switch, not a wing.

### F4 — Braking is speed-blind

`DEFAULT_BRAKE_FORCE = 25` per wheel gives a near-constant 2.1–2.6 g at every
speed (measured in the `vehicle.ts` comment block: 39 m from 40 m/s). Real F1
braking is dominated by aero load: ~5 g from 300 km/h tapering to ~2 g by
150 km/h. The fixed force is also why a hard brake step can flip the car —
force-limited-by-grip braking would be self-taming at speed (that's what makes
F1 cars stop harder than they launch).

### F5 — Lift-and-coast is audio only

The game is named after lift-and-coast, and the audio has the turbo whoosh and
overrun crackle, but a closed throttle imposes **zero engine braking** —
coasting decel is only aero drag and linear damping (`LINEAR_DAMPING = 0.05`),
both speed-friendly and neither gear-dependent. There is no brake-by-wire/regen
blend, no lift harvest, and no fuel or tyre benefit from lifting early, so the
strategy tool and the driving have no mechanical relation.

**Outcome (2026-11-07):** closed. Lift-and-coast now harvests battery charge
for the player (30% of the braking rate above 12 m/s, HUD-visible via
`harvestRate`), and the player's car runs a closed-throttle engine-braking
retarder (`engineBrakeForceN`, 1st-gear-referenced, speed-ramped, rear wheels,
full-coast only). The AI was deliberately **excluded** from both: the retarder
shifted the headless field's coast-phase trajectories and the VER/HAM
crossover-deck run at Suzuka lost margin (maxTilt 0.29 -> 1.71). The player
keeps the feature; the AI's validated pace/line is untouched. The lift-and-
coast harvest was already player-only by construction.

### F6 — Fuel is a percent, not a mass

`strategy.ts` reduces pace by up to 3.5% from a full tank
(`FUEL_MASS_PACE_LOSS_AT_FULL_TANK`) but never touches `CHASSIS_MASS`. A full
car and an empty car weigh the same in physics: identical acceleration,
braking and tyre loads. A real F1 car is roughly three seconds a lap quicker
with a burned-down tank than a brimmed one (the ~0.3 s per 10 kg rule of
thumb). Rapier supports dynamic mass
(`rbSetAdditionalMass` is in the wasm API).

### F7 — The gearbox has no shift time and no clutch character

Upshifts/downshifts are instantaneous gear-state changes (`updateGearbox`).
"Missed shifts cost real time" is only the torque curve's falloff; there is no
shift torque cut (60–90 ms), no synchro penalty, no anti-stall clutch at
launch. Manual gears are correct-but-weightless: there is no pace difference
between a clean auto and a perfect manual except rev-band placement.

### F8 — Tyre temperature is one number, and per-wheel temps are displays

`strategy.ts` runs one carcass temperature into `thermalGrip`
(0.86 at cold → 1.0 at ~100 °C) and one wear pool. `lib/race/wheelTemps.ts`
spreads four displayed temperatures from a display-only model ("an estimate for
the driver, not an input to the physics" — its own header). So the classic F1
feel — outside tyres falling away in a long corner, left-side tyres ruined by
an anti-clockwise track, one flat-spotted wheel from a lockup — cannot occur.

### F9 — The assist structure stops short of the F1 game's

TC and ABS are single booleans; the F1 games ship stepped assists (TC
Off/1/2/3 plus line/braking assists), and the code comments themselves note
the missing "Pro tier" twice (`vehicle.ts`'s TC block, `useDriveInput.ts`'s
auto-gear block). The Casual/Standard/Expert presets (`app/AssistPresets.tsx`)
are a good foundation, but inside each assist there is no middle ground —
which is exactly the space where "drives like the F1 game on hard" lives.

### F10 — The stability layer is band-aids doing the tire model's job

`computeStabilizingTorque` (upright-correcting torque), `resolveYawDampingTorque`
(AI spin damper), `BRAKE_RAMP_SECONDS`, and the `combinedBrakeScale` trim are
all compensating for the absence of F1. Once slip-based lateral grip carries
the load, several of these can be tuned down — **carefully and by measurement**
— which would also make flips rarer than they are today.

### F11 — What is already good (protect it)

The per-wheel surface model (`lib/tracks/surfaces.ts`) is genuinely strong:
kerb types with grip 0.96/0.90/0.80 plus a raised-kerb suspension kick, gravel
0.3 grip with heavy drag (a passenger experience, as intended), grass falloff
with a measured 0.6 floor, paved runoff for street circuits, per-wheel
classification. Rewind handling of state, the ERS thermal/budget model, and
the interactive pit release are F1-accurate in spirit. Nothing below should
regress these.

## 3. The drivability roadmap

Phases are independently shippable. Letters A/B/C map to "drivability core",
"feel & feedback", "setup depth".

### A. Wire the designed tire model into the live car (the headline)

**A1. Layer the friction circle onto the raycast vehicle — the plan §5 design,
finally built.**
Compute per-wheel slip every step from data the controller already exposes:

- *Slip angle* per wheel: angle between the wheel's heading (chassis yaw + steer)
  and the wheel's contact-patch velocity (`rbVelocityAtPoint` at
  `wheelContactPoint(i)`).
- *Slip ratio*: `wheelRotation(i)` delta vs the contact-point ground speed.

Map those through the existing slip curves and clamp the **combined** usage to
the friction circle, then translate the result into the two knobs the
controller has — `setWheelSideFrictionStiffness` and `setWheelFrictionSlip` —
exactly how `applyLoadSensitiveFriction` already does it. Implementation
sketch: a new `lib/physics/slipModel.ts` holding a small state machine per
wheel (slip estimates, lockup state, wheelspin state) consumed by
`applyLoadSensitiveFriction`; `Car.tsx`, `AICar.tsx`, `harness.ts` and
`driveSession.ts` all call it through the unmodified public signature so every
caller stays in sync.

Constraints to respect:

- Never push `sideFrictionStiffness` above its 1.0 ceiling; the circle limits
  *allocation* of existing grip (like `computeTireForces` does), it does not
  add grip.
- The 1750 N thrust cap and brake-forces stay.

Why it matters: this single change makes trail braking, throttle modulation,
lockup recovery and slide-catching real skills instead of display
abstractions, and turns TC/ABS from input tricks into systems with a job.

**A2. Real ABS as per-wheel slip control.** Detect slip ratio < lock
threshold per wheel from `wheelRotation`; modulate that wheel's brake between
full and released (pulse train), on top of the untouchable 0.5 s anti-flip
ramp. ABS on = ideal modulation; ABS off = lockups with flat-spot consequences
below and the ramp still guarding the chassis step. The steering trim
`combinedBrakeScale` can then shrink or retire because the circle does the job
physically.

**A3. Real TC as axle slip control plus stepped levels.** Cap per-wheel engine
force when rear slip ratio exceeds the spin threshold (per-wheel split makes
this cheap — see A4). Ship Off / TC-1 / TC-2 / TC-3 (loose-to-tight throttle
slip budgets) so the assist becomes a difficulty choice the way the F1 games
do it, replacing the current boolean with the same G-key toggle UI it already
has.

**A4. Open-diff torque split for the driven axle.** The controller already
accepts per-wheel engine force; divide rear torque between the two rear wheels
by their current grip ceiling (open-diff behaviour: a spinning inside wheel
stops pulling). This is the corner-exit skill F1 sims live on, it cannot add
thrust, and it gives A3's TC something physical to limit.

**A5. Wire the load-transfer model (or delete it honestly).** Feed
`computeWheelLoads` geometry with the chassis' real longitudinal/lateral
acceleration each step and use the output in the grip-scale product — or, if
measurement says Rapier's suspension force term already tells the story well
enough, **delete the dead module and its test**. Decision point by
measurement; either outcome is an improvement.

**A6. Make downforce aerodynamic (grip that grows with speed).** Give
`applyLoadSensitiveFriction` an explicit aero term: `gripScale ∝ sqrt((W +
k·v²)/W)` produced by `computeDownforceN` itself, so cornering grip follows
squat geometry instead of a flat mode multiplier, and retire the flat 0.5×
low-drag `grip` penalty in favour of the real mechanism (less downforce ⇒ less
grip, measurably in fast corners).

This is the riskiest item in the plan and must be treated as a measured
experiment:

- Raise the side-friction ceiling only behind a re-validated stability matrix
  (`vehicle-stability-track`, `corneringRoll`, danger-scenario set from
  `vehicle.ts`'s header), because values above 1.0 are a documented flip
  trigger in Bullet-derived raycast vehicles.
- Re-run all AI benchmarks: the AI's validated pace scales were measured under
  the old grip curve; toured circuits will read differently at 60+ m/s.
- Expected payoff: high-speed corners finally reward commitment, and low-drag
  mode becomes an actual wing choice rather than a penalty flag.

**A7. Engine braking, lift-and-coast, and brake-by-wire blend.** On closed
throttle, apply gear-scaled negative wheel force (visible only mid-band so
low-speed coasting never stutters); route a slice of lift-and-coast into ERS
harvest and a small fuel/wear saving; let the regen blend bias rear "braking"
during harvesting so the driver balances entry with pedal and fuel mode. This
makes the namesake mechanic meaningful: lifting early becomes a real decision
with measured costs and gains.

**A8. Fuel as real mass.** At session start set `CHASSIS_MASS + fuelKg × scale`
via `rbSetAdditionalMass` (available in the wasm API), recompute on every listed
service, and remove `FUEL_MASS_PACE_LOSS_AT_FULL_TANK`'s gameplay role (keep
the constant only for AI pace-table compat if measurement demands). The car
gets lighter and the track keeps changing underneath you across a stint — the
most F1 feel-per-line-of-code in the whole plan.

**A9. Brake temperature and fade.** Brake energy (speed × brake force) heats
per-axle brake temps with airflow cooling; above the fade threshold, scale
`DEFAULT_BRAKE_FORCE` down and shorten the 0.5 s ramp's authority (a hot fade
car can't pole-vault). Surface for the driver: brake-temp readout in the MFD,
an engineer radio line on overheat, and cold-bite behaviour on the out-lap.
This also deepens A2 (lockups raise temp faster).

**Sequencing and gates.** A1 → A2/A3 (they depend on A1's slip estimates) →
A4/A7 (independent, both cheap) → A5/A6 (measurement-heavy) → A8/A9. Every step
re-runs the §0 gates and quotes before/after lap times from
`diagnose:ace` per circuit, plus the standing-start and braking scenario
numbers already recorded in `vehicle.ts`'s comments (0–100 must stay ≈ 2.5 s;
stop-from-40 m/s must stay inside the measured band or be justified).

### B. Feel and feedback (pairs with Phase A)

- **B1. Surface the new physics.** Per-wheel slip telemetry in the Race Ops
  panel (lockup/spin/circle-usage corners), tyre page colouring by *work* not
  just temperature, and engineer radio lines that teach the systems ("rears
  are spinning out of the hairpin, try third").
- **B2. Rumble vocabulary.** `lib/settings/hapticsPref.ts`'s `rumbleFor`
  already reads kerb/skid/impact; add distinct lockup pulses (front piston)
  and wheelspin buzz (rear) when A1/A2 land.
- **B3. Audio cues.** Flat-spot rumble after a full lockup persists (tyre
  damage feedback), plus a dryer screech for lockups vs the existing slide
  squeal. All inside the existing mixer channels.
- **B4. Steering feel options.** Keep `steerSensitivity`/deadzone, add return
  rate and a "speed-sensitive lock" toggle for wheel users, plus an on-screen
  steering indicator bar for keyboard players (learn-the-input aid, off by
  default).
- **B5. Stopwatch assists (optional, off by default).** Brake assistant (a
  suggested braking board key on approach) and auto-ERS posting, as the
  boundary between Casual and Standard. Cheap to compute from the racing line
  the game already owns.

### C. Setup depth (player-only car, AI stays on the validated build)

- **C1. Aerodynamic balance slider** (front/rear wing trim split). This is
  aerodynamic, *not* the rejected brake-bias slider, but it changes grip
  distribution, so it enters under the same measured-first rule: ship only if
  the stability matrix and per-track gates stay green, and if the measured
  lap-time trade matches its promise (more front = entry rotation, less rear
  stability).
- **C2. Brake-duct cooling** (C-folded into A9): more cooling, more drag —
  pairs the brake-temp model with a setup decision, per-track tuned from
  braking-zone lengths the racing line already computes.
- **C3. Recommended setup per circuit**, generated from the line's speed
  profile (long straights → short final drive etc.) with a "load preset" and
  a measured "test lap" like the existing sliders have.
- **C4. Setup sharing**: export/import a setup blob alongside ghost sharing
  (`ghostShare.ts` infra) so the community can trade setups without any new
  backend.

## 4. F1-accuracy items (rules and regulations)

- **R1. No refuelling decision (needs owner's call).** The game refills
  ~100 kg per stop (`PIT_STOP_FUEL_REFILL_KG`); F1 hasn't refuelled since 2010
  and 2026 certainly doesn't. Option: a "Realistic fuel" session toggle —
  the car starts with a lap-count budget + margin, stops are tyre-only, fuel
  is a real pace cost mid-race (A8 synergy). AI pit logic unchanged; strategy
  advice updates. Keep the current refill behaviour as the arcade default if
  preferred.
- **R2. Track evolution ("rubbering in").** A slow global grip term that grows
  over green-flag distance across a weekend — greasy Friday practice, rubbered
  race Sunday — same shape as the existing weather grip composition. Street
  circuits start greasier. Needs its own AI-benchmark pass per circuit; the
  per-track tables in `lib/race` already exist as patterns.
- **R3. Dirty air (front-downforce loss in a tow).** The tow currently only
  reduces drag (`towDragScale`); add a modest front-load penalty when
  nose-to-tail in a corner following, so closing in fast sweepers gets harder
  (why F1 racing looks like it does). Apply identically through the shared
  path; measure AI train behaviour carefully before shipping (chaos-sensitiv-
  ity warning).
- **R4. Safety-car procedure details:** lapped cars may unlap themselves
  before the restart; VSC "synchronised" pit-exit rule. Cheap, visible rules
  texture on the existing SC system.
- **R5. Parc fermé (championship only):** after qualifying, setup sliders lock
  for the race and only tyre pressure may change — one setting, big realism
  for career players.
- **R6. Tyre set allocation per weekend:** a per-weekend bank of sets
  (soft/medium/hard/inters/wets), drawn on by practice/quali/race — displayed
  on the strategy screen. Pure bookkeeping against existing compound state.
- **R7. Formation lap (optional toggle):** a slow lap to warm tyres and brakes
  before the lights, or a grace jump-to-grid for those who just want to race.
  Pairs with cold brakes from A9 making the out-lap meaningful.
- **R8. Out-lap procedure (qualifying/TT):** brake and tyre warm-up matter on
  the first lap (A9's cold-bite + tyre warmth window) — officially a "push lap
  prepare" experience rather than an instant spawn-and-go.
- **R9. Lapped-car awareness for AI racecraft:** under blue flags AI cars
  yield cleanly for the leaders (a lateral hold-out instead of a wobble), and
  engineers announce blue flags. Light addition to `racecraft.ts`.

## 5. Beyond drivability — additional features worth adding

- **S1. Lap-comparison telemetry (debrief & TT).** Speed/brake/throttle trace
  overlay of your best lap vs the current one, plus corner-by-corner deltas —
  every source exists already (`raceRecorder.ts` at 10 Hz, `telemetry.ts`,
  `deltaTimer.ts`); this is mostly presentation in the debrief.
- **S2. Async ghost racing.** Race a full grid of friends' or rivals' shared
  ghosts in any session (the shared-ghost infra, codec and guardrails all
  exist); a "ghost grid" mode delivers the multiplayer feeling offline.
- **S3. Driving School level 2** teaching the new physics: a trail-braking
  drill, a lockup-save drill and a wheelspin throttle drill as self-contained
  programmes like the existing four (directly monetises Phase A as learnability).
- **S4. Career texture:** driver ratings that drift with results (spin off the
  existing roster data), one-line team orders and interteam rivalries in the
  radio and debrief — narrative only, no AI changes demanded.
- **S5. Full-screen live timing display** (F1-TV style standalone timing page
  during races/timed quali, using the tower data) — nice for streamers.
- **S6. WebXR camera mode (stretch, flag-topped):** an optional VR camera rig
  behind the existing helmet/cockpit views. Large perf risk on the SSR
  SwiftShader budget and needs explicit owner sign-off; listed only as a
  candidate, not a commitment.
- **S7. Highlights export** (clip files from the existing highlight slices)
  so players can share their overtakes without streaming the whole race.

## 6. Small fixes and cleanup (grab bag)

- **C-a. Delete the dead `lib/physics/drs.ts` shim** — nothing imports it
  (the revamp doc itself flagged this: "delete it if nothing imports it").
- **C-b. README says 27 circuits, registry ships 30** — update the copy (or
  un-register dev tracks deliberately).
- **C-c. `weightTransfer.ts` decision** — used or deleted, not parked (A5).
- **C-d. Balance the `START` fuel default** against race length once refruel
  rules settle (R1), so 5-lap quick races don't start drag-heavy.
- **C-e. `app/Multiplayer.tsx` + `NetSync` drift note:** keep the 30 Hz
  snapshot budget in mind if any per-frame physics state (slip, brake temps)
  gets mirrored — add fields deliberately, not accidentally.

## 7. Suggested order

| # | Item | Effort | Risk | Why first |
|---|------|--------|------|-----------|
| 1 | A1 friction circle on raycasts | L | M | Every other drivability item depends on slip existing |
| 2 | A2 real ABS, A3 stepped TC | M | L | Convert assists into real systems once A1 lands |
| 3 | A7 engine braking + lift/coast, A4 diff split | M | L | Big feel, cheap, independent |
| 4 | A8 fuel mass | S | L | One constant, F1-defining feel |
| 5 | A9 brake temps (+C2) | M | L | completes braking realism |
| 6 | A5 load-transfer decision, then A6 aero grip (measured) | L | H | biggest accuracy win, biggest validation cost |
| 7 | B1–B4 feedback pass | S | — | teaches the new systems |
| 8 | R1 decision, R2 rubbering in | M | M | needs owner's call + benchmark pass |
| 9 | C1/C3/C4 setup depth | M | M | only after physics settles |
| 10 | S1–S5 features | — | — | clean wins anytime |

*The point of the whole plan:* today the car behaves like a very well-behaved
rail with weather, wear and strategy on top. Phase A makes the car itself a
thing you drive — grip you can spend, wheels you can lock, brakes that breathe
with the track — which is exactly what "more like the real F1 game and the
real formula car" means at the physics level.
