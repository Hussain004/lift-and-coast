# LIFT & COAST

A serverless, browser-based formula racing game for the 2026 regulation era.

Real circuit layouts, a living racing line, skill-based driving physics, energy management, wheel-to-wheel AI, and a retro-modern art style. No database or server backend, and no mystery buttons that do not belong on a racing car.

**Save the juice. Send the apex.**

## What is in the garage

- 27 real circuit layouts, including the 2026 calendar additions
- A generated racing line with throttle, lift, trail-brake, and hard-brake zones
- A readable racing-line overlay with a thicker broadcast-style ribbon
- AI difficulty tiers from Rookie to Ace, with personality, mistakes, tire curves, traffic, overtakes, and active racing
- Seven-speed sequential manual gears with an auto-gear assist
- Energy harvesting, thermal-limited ERS modes, and Push-to-Pass deployment
- Dynamic clear, cloudy, and rain weather with changing grip, drag, visibility, and track temperature
- Race strategy with fuel burn, fuel mass, tire age, tire temperature, blankets, compound selection, and pit service
- Knockout qualifying in the real F1 format: Q1/Q2/Q3 with eliminations between phases
- Track-derived 2026 overtake zones with race proximity and practice/qualifying access
- Race Ops telemetry, steward decisions, FIA-style penalties (5s/10s/drive-through/stop-go), license points, the 12-point race ban, invalid laps, and disqualification status
- Rolling instant replay with a synchronized TV camera, seek controls, and a speed trace
- Active Aero with high-downforce and low-drag modes
- Tire compounds, wear, grip changes, damage, and per-wheel surface effects
- Traction control, ABS, manual gears, and a toggleable racing line
- Keyboard, gamepad, wheel, and adaptive phone touch controls with shaped steering and braking
- Chase, cockpit, helmet, T-cam, TV broadcast, orbit, replay, and rewind cameras, with live side mirrors
- Practice, qualifying (one-shot, open, or knockout Q1-Q3), quick races, and full championship weekends
- Multiplayer rooms with synchronized timing and race-control telemetry
- Ghost laps, personal bests, sector timing, a delta timer, and a compact F1-style tower
- Procedural trackside architecture, barriers, flora, kerbs, gravel, paved runoff, and grass
- Madrid banking at T12 and Zandvoort's Hugenholtzbocht cross-slope
- Synthesized Web Audio engines, tires, wind, impacts, limiter, and gear shifts

The game is entirely client-side. Your setups, championship, best laps, and preferences stay in the browser unless you export a save.

## The racing line

The line is generated from each circuit's real centerline and width data. It has two jobs:

1. Give the AI a physically reachable speed target and steering reference.
2. Give the driver an honest visual guide for where to lift and brake.

The line builder now guards against sharp hairpin offsets, duplicate centerline samples, and start-finish splices. Its speed profile is checked for finite values, track containment, reachable acceleration, reachable braking, and readable zone runs. The AI follows the target-speed profile, not the displayed colors.

For a repeatable solo-line check, run:

```bash
npm run diagnose:line
```

That command runs the quality gates and hot-laps every registered circuit with the solo AI controller before racecraft is enabled. It reports the theoretical line lap, measured AI lap, off-track distance, and maximum tilt. The normal test suite still runs the fast analytic checks and the multi-car stability gates.

## Race Ops

Open the Race Ops panel during a session to change weather, ERS mode, strategy mode, and compound. Request a pit service with `O`, arm 2026 overtake mode with `X`, pause singleplayer with `P`, and toggle instant replay with `J`. The panel shows fuel, tire temperature, grip, overtake state, steward decisions, penalties, and a rolling speed trace.

Weather is shared by the track, player, and AI. Rain reduces grip and increases drag while the scene adds rain particles, lower visibility, and a darker atmospheric feel. Overtake zones are derived from long, low-curvature sections of each circuit. In a race they activate only within one second of the car ahead; in practice and qualifying they can be armed throughout the zone.

## Penalties and the super-license

Track limits follow the FIA ladder: three warnings, then a black-and-white flag, then escalating time penalties for repeat offenses (+5s, +10s, a drive-through, a stop-go). Unsafe rejoins and pit-lane speeding are drive-through penalties. Every penalty carries super-license points, and a driver who collects 12 points in a season receives an automatic race ban. The five red start lights illuminate one by one, then extinguish - lights out and away we go.

Pit service currently uses the marked start-finish service window as a playable vertical slice. A full drivable pit-lane route and route-aware championship classification are the next simulation milestone.

## Controls

| Action | Keyboard | Gamepad or wheel |
| --- | --- | --- |
| Throttle | `W` or `ArrowUp` | Right trigger or pedal |
| Brake | `S` or `ArrowDown` | Left trigger or pedal |
| Steer | `A` / `D` or arrow keys | Left stick or wheel |
| Push-to-Pass | `Shift` | Assign as a button if supported |
| Shift up | `Q` | Assign as a button if supported |
| Shift down | `Z` | Assign as a button if supported |
| Rewind | Hold `R` | Assign as a button if supported |
| Auto-gear toggle | `G` | Assign as a button if supported |
| Traction control | `T` | Assign as a button if supported |
| ABS | `B` | Assign as a button if supported |
| Racing line | `L` | Assign as a button if supported |
| Active Aero | `E` | Assign as a button if supported |
| Camera (includes helmet view) | `C` | Assign as a button if supported |
| Side mirrors | `N` | Mirror button in the HUD/touch deck |
| Tires | `1` / `2` / `3` | Assign as buttons if supported |
| Mute | `M` | Assign as a button if supported |
| Race Ops panel | `H` | Header click |
| Overtake arm | Hold `X` | Assign as a button if supported |
| Pit request | `O` | Race Ops button |
| Pause singleplayer | `P` | Resume button |
| Instant replay | `J` | Race Ops button |
| ERS mode | `I` | Race Ops button |
| Strategy mode | `Y` | Race Ops button |
| Weather cycle | `U` | Race Ops button |

ABS and traction control are assists, not driving eras. Turn them off when you want to feel the consequences.

On a phone, the race automatically adapts to the orientation. Portrait mode gives the game the upper portion of the screen and places analog steering and pedal sticks in a lower control deck. Landscape mode keeps the full game view and overlays the sticks in the lower corners. The touch deck also provides Overtake, ERS, side-mirror, pause, and replay actions.

## Development

Install dependencies and start the local server:

```bash
npm install
npm run dev
```

Open `http://localhost:3000`, choose a circuit and session, and press Drive. The home screen stores garage choices, race settings, weather, and lighting preferences locally.

Run the normal checks with:

```bash
npm test
npm run lint
npx tsc --noEmit
npm run build
```

The deeper diagnostics are available when you are changing physics or AI behavior:

```bash
npm run diagnose:ai
npm run diagnose:line
```

`diagnose:ai` prints per-wheel contact, suspension, and impulse data around excursions. `diagnose:line` measures the generated line first, then measures clean solo AI laps. The multi-car tests then cover launches, traffic, overtakes, parked cars, and Suzuka's bridge after the solo line is stable.

## Track data

Circuit geometry comes from the `bacinger/f1-circuits` dataset under the MIT license. Raw polylines live in `data/tracks/raw/`. The processed files in `data/tracks/*.json` are built by projecting the source lon/lat path into a local meter plane, fitting a centripetal Catmull-Rom spline, and resampling it at a fixed arc-length interval.

Track widths come from the vendored `TUMFTM/racetrack-database` files. The build aligns the width frame to the processed centerline with a deterministic ICP fit, then transfers the real per-point width. Monaco's narrow street sections use authored width ranges where no satellite width file exists.

Elevation comes from Copernicus DEM GLO-90 samples with a 2D blend around the circuit. The blend is deliberate: a DEM cannot distinguish the two arms of a crossover, so Suzuka's bridge and Monaco's overlapping sections need a shared hillside. Cars drive on a terrain height field built from that profile, not on a flat plane with a pretty texture.

To rebuild every processed circuit:

```bash
npm run build:track
```

To add a circuit, place its raw GeoJSON in `data/tracks/raw/`, add it to `scripts/build-track.mts`, register its id and display name in `lib/tracks/registry.ts`, and add a stability entry. The quality and AI gates will then include it automatically.

## Stack

- Next.js App Router
- React and TypeScript
- Three.js through React Three Fiber
- Rapier physics through `@react-three/rapier`
- Zustand for client state
- Vitest for unit, geometry, physics, and AI tests

## Deployment

The project is ready for Vercel or any static Node host. There are no environment variables, server database, or server-side game-state requirements. The race route loads circuit data in the browser, while the menu route stays light.

## Support

If the project earns a coffee, you can support it here:

[donatr.ee/hussain](https://donatr.ee/hussain/)

## Legal

Lift & Coast is an unofficial fan game. It is not affiliated with or endorsed by Formula One, the FIA, any team, driver, or circuit. See `NOTICE` for the full disclaimer and third-party data licenses.
