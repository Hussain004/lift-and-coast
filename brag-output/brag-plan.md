# Brag Plan: LIFT & COAST

## What is this app?

LIFT & COAST is a 2026-regulation open-wheel formula racing game that runs entirely in a
browser tab — Next.js + React Three Fiber + Rapier physics, no server, no database, no
install. Twenty-seven real circuits are rebuilt from real GPS centerlines, real
per-point track widths, and Copernicus DEM elevation, and every circuit gets a
generated racing line that paints itself onto the tarmac to tell the driver where to
lift and where to brake.

## The angle

The game is named after a real driving technique: **lift and coast** — raising off the
throttle mid-corner to rotate the car, save fuel, and set up the next straight. The
whole product is an argument that going slower-looking is actually faster. The
project's own footer line says it best: *"Lift & coast: it's not slow, it's
strategic."*

That contradiction is the hook. The video is framed as an **F1 TV broadcast graphics
package**: timing tower, sector strip, red accent, gold kicker, mono data type,
restrained motion. The product's own in-race HUD is the hero asset — this is a brag
about a *game*, so the game is on screen from the first frame, not described in
abstract cards.

The distinctive, video-native feature is the **racing line ribbon**: a thick
broadcast-style band of color laid on the track ahead of you — teal where you can
commit, amber where you lift, orange where you brake hard, crimson at the hardest
braking points. It is the single most recognizable thing in the product and the
centerpiece of the middle of the video.

## Hook (first 2-3 seconds)

Full-bleed, no logo card first: a real in-game TV broadcast camera shot of Eau Rouge at
Spa at sunset, kerbs and grandstand in frame, the racing line ribbon sweeping through
the corner and **changing color as it brakes** (teal → amber → crimson). A slow push-in.
Over it, in the product's own gold mono kicker: `2026 REGULATION ERA · BROWSER FORMULA
RACING`, then the hook line slamming in:

> **IT'S NOT SLOW.**
> **IT'S STRATEGIC.**

## Key moments (the middle)

1. **The line tells you where to lift** — a push into the ribbon on the long straight,
   the four zone colors called out one at a time (THROTTLE / LIFT / BRAKE / BRAKE
   HARD) in the exact product colors, then the claim: *27 circuits from real GPS
   centerlines*.
2. **A 20-car grid that races you** — the broadcast timing tower builds itself one row
   at a time with real 2026 driver codes and team color chips (LEC, VER, NOR, HAM,
   PIA, RUS, …), gaps ticking, over live chase-cam gameplay of the player's car sitting
   on the line.
3. **The whole race weekend, in one tab** — weather rolls in (clear → rain, grip drops,
   visibility drops), then a strip of broadcast tags lands: WEATHER / ERS / TIRES /
   STRATEGY / STEWARDS, capped by the real in-game red `TRACK LIMITS WARNING 2/3`
   banner flashing over the cockpit camera.

## Outro / punchline

The project's real home hero, full-bleed — real title lockup, real tagline, real DRIVE
button, real 27 / 11 / 22 / 20 stat block, real circuit ticker. Above it, the five F1
start lights from the hero's own markup light up one by one, hold, then all go out on
the beat — the one gesture every racing person knows. The tech credit line lands as a
mono strip along the bottom: `REACT THREE FIBER · RAPIER PHYSICS · 27 CIRCUITS FROM
REAL GPS CENTERLINES`.

## User flow worth showing

- **Entry** — home hero → the real circuit planner: world map with all 27 circuit pins,
  region filters (World 27 / Europe 11 / Americas 6 / Middle East 5 / Asia-Pacific 5),
  per-circuit length + corner count + direction, then LIGHT / WEATHER / SESSION /
  RIVALS / AI LEVEL / GRAPHICS and a red DRIVE button.
- **Key action** — drive. Throttle, brake, steer, seven-speed sequential manual gears,
  ERS deployment, overtake arm, pit request, while the racing line ribbon and the
  timing tower update live.
- **Result** — lap time and sector splits (S1 / S2 / S3) on the top strip, positions on
  the tower, penalties and invalid laps from the stewards, ghost laps and personal
  bests, and a 27-round championship that persists in the browser.

The video shows **entry → drive → result** in that order: the map/planner is Scene 2's
background crop, the drive and live timing are Scenes 3 and 4, and the result state
(the tower + sectors + championship claim) lands in the outro stat block.

## Tone

- Preset: `polished`
- Creative direction: *F1 TV broadcast graphics package — timing tower, sector strip,
  red accent, gold kicker, mono data, confident restraint.*
- Interpretation: the product is genuinely impressive, so the video plays it straight.
  Few scenes, long holds, one claim per scene, type that lands and stays. Confidence
  comes from the real footage, not from cuts, speed ramps, or shouted copy.

## Format: landscape — 1920x1080
## Duration: 21.3s

## Visual identity (from the project)

- Background: `#040509` (page base) / `#0a0c12` (raised panel)
- Accent: `#e10600` (F1 red — CTA, selection, track-limits banner)
- Secondary accent: `#d3ab63` (gold — kickers, mono data highlights)
- Text: `#f4f1e8` primary, `#9aa0ac` muted, `#565c68` faint
- Racing-line zone colors (the signature): throttle `#14c78c`, lift `#f2ad1f`,
  brake-medium `#fa5110`, brake-hard `#c7071f`
- Display font: **Archivo** (italic 800/900 — the LIFT & COAST wordmark is Archivo
  Black Italic with a red ampersand)
- Body / UI font: **Geist Sans**; data and labels: **Geist Mono**
- Strongest visual element: the color-banded racing line ribbon on the tarmac, plus the
  in-race HUD cluster (red gear block, big KM/H readout, RPM + ERS bars, THR/BRK/STR
  input bars, tyre/aero/assists block) and the timing tower of driver-code chips

## Source material (real product captures)

Gameplay and product frames captured from the running app (1920x1080, WebGL). Every frame
is a real screenshot of the game — its HUD, mirrors, tower and minimap are the actual
rendered UI, not a mock-up.

Final asset set, as used in `composition/`:

| Frame | Content | Scene |
|---|---|---|
| `assets/frames/01-spa-tv-corner.png` | TV broadcast cam, Eau Rouge sunset, line braking teal→amber→crimson | 1 (hook) |
| `assets/frames/08-clean-line.png` | Chase cam, 231 km/h in 7th, line stepping teal→amber→pink into the corner | 2 |
| `assets/frames/09-clean-straight.png` | Chase cam, 199 km/h on the straight, line to the horizon | 3 |
| `assets/frames/10-ops-rain.png` | Race Ops panel open in the rain: grip 70%, pit stop, overtake, replay, stewards | 4a |
| `assets/frames/11-helmet-clean.png` | Helmet camera through the halo | 4b (steward banner) |
| `assets/frames/06-hero.png` | Real home hero: wordmark, tagline, DRIVE, 27/11/22/20, circuit ticker | 5 |

Scene 2 and 3 use frames captured with the in-game tower and key-hint panel removed at
capture time, so the rebuilt broadcast graphics own that space instead of fighting the
game's own.

### Deviation from the first draft of this plan

Scene 4 was originally specced as a rain frame plus a five-chip text strip
(`WEATHER / ERS / TIRES / STRATEGY / STEWARDS`). It shipped as the **real Race Ops
panel** instead — the app's own `H` panel, open, in the rain, showing weather, grip,
tyre temperature, ERS, strategy, fuel, compounds, pit stop, overtake, instant replay,
`REPORT REJOIN` and `NO STEWARD DECISIONS` all at once. Showing the product's own dense
UI beats listing the same five words, so the tag strip was dropped and the `RACE OPS / H`
keycap label kept in its place.


## Share copy (draft)

27 real circuits. Real GPS centerlines. A racing line that tells you where to lift.
The whole thing runs in a browser tab.

## Audio direction

- Role: driving, percussive electronic bed with a lift; the restraint lives in the SFX,
  not the music.
- Music: `happy-beats-business-moves-vol-12-by-ende-dot-app.mp3` (1:58, steady and
  clean — the `polished` pick), started at 0.0s so the beat grid runs under the whole
  edit, volume 0.30, no fade-in, 1.2s fade-out on the tail.
- Music treatment: enter dry on the first beat, hold a steady level, let the last
  scene breathe on the decay after the lights go out.
- Music cue guidance: preset read — tempo 109.96 BPM, strong cues at **8.74s, 10.93s,
  13.11s, 17.47s, 18.56s, 19.66s, 22.37s** within the window. Lock the tower's first
  row to **8.74s**, the STEWARDS tag + track-limits banner to **13.11s**, and the
  start-light sequence to **18.56s** with lights-out on **20.19s**. Smaller entrances
  inside ±0.10s of a beat. Nothing else needs to lock.
- Audio-reactive treatment: subtle; let music RMS breathe the red accent glow behind
  the wordmark and the title's soft edge glow on the two biggest musical moments. No
  waveform, no equalizer, no text scaling.
- SFX posture: sparse and motion-matched (polished = 2-3 very subtle cues). One soft
  low impact on the hook slam, one dry UI tick on the first timing-tower row, a light
  tick cluster as the zone labels land, one dry interface click as each broadcast tag
  drops, one restrained plate/wood accent when the steward banner flashes, and a single
  deep bell on the wordmark at lights-out. Nothing aggressive, nothing stacked.
- Audio-coupled moments: the timing-tower rows (accent only the first and last — a tick
  every row would be noise), the four zone callouts landing in sequence, the five
  broadcast tags dropping one by one, the five start lights (a tick per light, then
  silence on lights-out so the bell carries).
- Restraint rule: no engine-rev loop, no tire squeal, no riser sweep — this is a
  broadcast package, not a game trailer. The audio must never compete with the type.

## Storyboard

### Scene 1 — Hook: it's not slow — 2.73s

Full-bleed `spa-cam-3b.png` (TV broadcast cam at Spa, sunset, kerbs, racing line
braking through the corner). Very slow push-in, 1.04 → 1.00. A dark gradient scrim
lifts from the bottom for type. Gold mono kicker fades up at 0.35s: `2026 REGULATION
ERA · BROWSER FORMULA RACING`. Hook line slams in at 0.56s on the first strong beat, in
Archivo italic, "IT'S NOT SLOW." / "IT'S STRATEGIC." on two lines with the second line
in red — holds fully settled from ~0.9s to the cut.

Sequential/interaction: yes — kicker then hook line, two beats, nothing else.
Audio intent: an engine-cold snap, then the bed; the type lands with weight.
Audio-coupled idea: the hook line's two lines land on consecutive beats (0.56s, 1.09s).
Music: vol-12, in from 0.0.
Transition mood: clean → Scene 2.

### Scene 2 — The line — 4.91s (2.73 → 7.64)

`spa-cam-3.png` — the long straight, the car sitting on the ribbon, the teal line
running to the horizon. Slow drift right across the track. Four zone callouts appear in
sequence at 4.39s / 4.91s / 5.34s / 6.00s, each a swatch + label in the product's exact
zone colors: THROTTLE `#14c78c`, LIFT `#f2ad1f`, BRAKE `#fa5110`, BRAKE HARD `#c7071f`.
The four hold together as a legend from 6.4s. Headline types/slides in beneath at 6.56s:
`27 CIRCUITS FROM REAL GPS CENTERLINES` (mono, gold), settled and readable to the cut.

Sequential/interaction: yes — four callouts one at a time, ~0.4s apart, then the
headline. Each callout is a 1-word label (0.8s floor satisfied for the set, which holds
1.2s+ as a group).
Audio intent: curiosity — the sound of a system revealing itself.
Audio-coupled idea: one light tick per callout, clustered on the beat grid.
Music: vol-12 continues.
Transition mood: clean wipe → Scene 3.

### Scene 3 — The grid — 4.38s (7.64 → 12.02)

Cut to `spa-run-01.png` (chase cam, car on the line, 210 km/h) cropped to the driving
view so the frame's own tower is out of shot and a rebuilt broadcast timing tower can
occupy exactly that space on the left. The tower builds one row at a time from 8.74s:
P1 LEC, P2 VER, P3 NOR, P4 HAM, P5 PIA, P6 RUS, P7 STR, P8 ALO, P9 LAW, P10 ANT, P11
HUL, P12 BOT, P13 BOR, P14 OCO, P15 HAD, P16 BOT/GAS-class rows — real 2026 driver
codes in the app's colored code chips, interval and gap columns filling right after
each row lands. Rows arrive ~0.18s apart, so the full field is standing by ~11.5s and
holds. Headline at 10.93s: `A TWENTY-CAR GRID THAT RACES YOU`.

Sequential/interaction: yes — the timing tower is the sequential reveal; rows appear
one by one with real data.
Audio intent: the field arriving — busy but controlled.
Audio-coupled idea: accent the first row and the last row only, with the rest carried
visually.
Music: vol-12 continues.
Transition mood: hard cut on a beat → Scene 4.

### Scene 4 — The race weekend — 4.91s (12.02 → 16.93)

`10-ops-rain.png` full-bleed — the Race Ops panel open in the rain, grip down to 70%, and
a push toward the panel. At 13.11s a hard cut to `11-helmet-clean.png` (helmet camera
through the halo) with the app's own red `TRACK LIMITS WARNING 2/3` banner flashing
across the top, and a mono label `STEWARDS · PENALTIES · INVALID LAPS` landing bottom-left
at 13.5s. Banner clears at 14.9s, label holds to the cut.

Sequential/interaction: yes — the panel's controls are the reveal; the steward banner
lands as the consequence beat.
Audio intent: weather closing in; consequence.
Audio-coupled idea: one restrained accent on the banner at the cut.
Music: vol-12 continues.
Transition mood: soft → Scene 5.

### Scene 5 — Outro: lights out — 4.35s (16.93 → 21.28)

`home-hero.png` full-bleed: the real wordmark, the real tagline, the real DRIVE
button, the real 27 / 11 / 22 / 20 stat block, the real circuit ticker. The five start
lights from the hero's own markup appear above the wordmark and light up one by one
(17.47, 17.9, 18.3, 18.56 strong cue, 18.9), hold red to 20.19s, then all extinguish on
the beat — and on lights-out the DRIVE button gets one soft red pulse. Mono credit strip
fades up along the bottom at 19.66s: `REACT THREE FIBER · RAPIER PHYSICS · 27
CIRCUITS FROM REAL GPS CENTERLINES`. The wordmark settles with a subtle RMS-driven red
glow. Fade to `#040509` over the last 0.8s.

Sequential/interaction: yes — five lights on, hold, five off.
Audio intent: the start. Anticipation, then release.
Audio-coupled idea: one tick per light, total silence on lights-out so a single deep
bell carries the last beat.
Music: vol-12 to 20.2s, then 1.2s fade-out on the decay.
Transition mood: n/a — end card.

**Music mood for this video:** steady, driving, restrained — a broadcast bed, not a
trailer.
**Audio summary:** one continuous 110 BPM bed from the first frame to lights-out, with
under a dozen quiet, motion-matched accents — a hook slam, four zone ticks, two tower
ticks, five tag clicks, a steward hit, and one bell at the end.
