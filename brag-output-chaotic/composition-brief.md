# Hyperframes Composition Brief: LIFT & COAST — Chaotic Cut

## Objective

Create a fast, loud, over-caffeinated launch video for LIFT & COAST — the aggressive
sibling to the polished broadcast cut in `../brag-output/`.

## Output

- Composition directory: `brag-output-chaotic/composition/`
- Rendered video: `brag-output-chaotic/brag.mp4`
- Format: landscape — 2560x1440
- Duration: 16.93s

## Source Material

- Project root: `/home/hussain/lift_and_coast`
- Primary files read: same as the polished cut — `README.md`, `app/Hero.tsx`,
  `app/globals.css`, `app/page.module.css`, `app/race/page.tsx`, `app/race/Track.tsx`,
  `app/race/RaceOpsPanel.tsx`, `lib/tracks/registry.ts`, `lib/tracks/racingLine.ts`,
  `lib/race/rosterData.ts`, `data/teams.json`
- Product name: **LIFT & COAST**
- Tagline / strongest claim: **"Save the juice. Send the apex."** and the README's own
  *"not on a flat plane with a pretty texture"*
- Key UI to recreate: the four racing-line zone colors as chips, a broadcast timing tower,
  the red `TRACK LIMITS WARNING 2/3` steward banner, and the circuit ticker voice
  (`NAME /// N CORNERS`)
- Copy that must appear verbatim:
  - `27 CIRCUITS.`
  - `REAL GPS CENTERLINES.`
  - `NOT A FLAT PLANE.`
  - `SO WHERE DO I LIFT?`
  - `THROTTLE` / `LIFT` / `BRAKE` / `BRAKE HARD`
  - `20 CARS.` / `ONE LINE.`
  - `CHANGE THE WEATHER` / `MID-LAP.`
  - `TRACK LIMITS WARNING 2/3`
  - `STEWARDS SEE EVERYTHING.`
  - `IT RUNS IN A TAB.`
  - `LIFT & COAST` / `SAVE THE JUICE. SEND THE APEX.`
  - `NO SERVER.` / `NO INSTALL.` / `NO EXCUSES.`
  - `REACT THREE FIBER · RAPIER PHYSICS · 27 CIRCUITS FROM REAL GPS CENTERLINES`
  - Circuit tags, using real names and real corner counts from `lib/tracks/registry.ts`:
    `CIRCUIT DE SPA-FRANCORCHAMPS /// 19 CORNERS`,
    `AUTODROMO NAZIONALE MONZA /// 11 CORNERS`,
    `BAKU CITY CIRCUIT /// 20 CORNERS`,
    `MARINA BAY STREET CIRCUIT /// 19 CORNERS`,
    `CIRCUITO DE MADRING /// 22 CORNERS`

## Real product captures (already in `assets/frames/`)

All natively 2560x1440 — a real 2K WebGL framebuffer, not an upscale — captured with the
in-game timing tower and key-hint panel removed so the chaotic graphics own that space.
Every frame is the game's actual rendered output, HUD, mirrors, minimap and all.

| File | Content | Circuit |
|---|---|---|
| `01-pack-rain.png` | 20-car pack stacked on a crimson braking zone, Eau Rouge, in the rain | Spa |
| `02-monza.png` | Sunset, grandstands, pack ahead on the line | Monza |
| `03-baku.png` | Steep gradient between the arms of the course, low sun | Baku |
| `04-spa-tv.png` | Broadcast camera, sunset corner, the whole pack on the colour-banded line | Spa |
| `05-pack-chase.png` | Chase cam, car in frame, pack ahead | Spa |
| `06-ops-rain.png` | Race Ops open in the rain — grip 70%, pit stop, overtake, replay, stewards | Spa |
| `07-cockpit.png` | Cockpit camera, 191 km/h, car ahead | Spa |
| `08-singapore.png` | A wall of cars ahead at 90 km/h in traffic | Singapore |
| `09-madrid.png` | The banked corner at sunset | Madring |
| `10-hero.png` | The real home hero | — |

## Creative Direction

- Tone preset: `chaotic`
- Creative direction: *overproduced mobile game ad — ALL CAPS, tilted words, red flash
  frames, one claim per cut, no restraint whatsoever.*
- Interpretation: pacing comes from hard cuts and zoom cuts, never from yanking text off
  screen. Every line is 1–5 words and holds past its read floor. Loud, but still readable.
- Angle: the product's absurd-but-true facts fired one at a time over the most crowded,
  fastest frame from each circuit. The "27 circuits" claim is never just a number — each
  cut carries a real circuit name and a real corner count.
- Hook: flash in on a 20-car pack stacked onto a crimson braking zone in the rain and
  slam `27 CIRCUITS.` at 200px.
- Outro: `LIFT & COAST` slams at 176px over Madring, the tagline lands, then three
  one-beat hits — `NO SERVER.` / `NO INSTALL.` / `NO EXCUSES.` — and a hard cut to black.
- Avoid:
  - Generic SaaS language
  - Abstract filler visuals
  - Unrelated visual redesign — palette, faces and zone colors are still the product's
  - Any claim that is not in the README or the code

## Visual Identity

- Background `#040509` · text `#f4f1e8` · accent `#e10600` (type-safe red `#ff3b2f`) ·
  gold `#d3ab63` · zone colors `#14c78c / #f2ad1f / #fa5110 / #c7071f`
- Display font **Archivo** 900 italic (local `woff2`), data/UI **Geist Mono**
- The chaotic register changes scale and rhythm, not the brand

## Storyboard

Use `brag-output-chaotic/brag-plan.md` as the creative contract. Scene boundaries are
snapped to the 110 BPM beat grid; nothing may be cut early.

1. **27 CIRCUITS** — `0.00 → 1.37` — pack in the rain, zoom cut in, 200px slam
2. **REAL GPS CENTERLINES** — `1.37 → 2.46` — Monza, 116px
3. **NOT A FLAT PLANE** — `2.46 → 3.55` — Baku, 140px
4. **SO WHERE DO I LIFT?** — `3.55 → 5.19` — Spa broadcast cam; the only beat that
   breathes (slow drift); four zone chips cascade 3.95/4.07/4.19/4.31 and hold as a set
5. **20 CARS. / ONE LINE.** — `5.19 → 6.82` — chase-cam pack, 168px + 76px, 8-row tower
6. **CHANGE THE WEATHER / MID-LAP.** — `6.82 → 8.22` — punch from 1.8 to 1.45 onto the
   Race Ops panel, anchored on the panel's own centre
7. **STEWARDS SEE EVERYTHING.** — `8.22 → 9.83` — cockpit cam, red banner flashes at 8.24
8. **IT RUNS IN A TAB.** — `9.83 → 11.47` — Singapore traffic, 176px
9. **LIFT & COAST** — `11.47 → 14.20` — Madring, 176px + tagline at 12.56
10. **NO SERVER. / NO INSTALL. / NO EXCUSES.** — `14.20 → 16.93` — the real hero, three
    stacked hits on 14.73 / 15.28 / 15.82, hard cut to black at 16.38

## Audio

- Audio role: dense rhythmic layer — the one tone that earns a loud mix
- Audio arc: hard in on the first beat, a heavy hit on every cut, one bell on the name,
  silence on the final cut to black
- Music: `assets/music/happy-beats-business-moves-vol-10-by-ende-dot-app.mp3`
  (1:00, compact punchy loop — the `chaotic` pick), volume 0.38, full 16.93s
- Music treatment: hard in at 0.0, no fade-in, cut to silence with the last flash
- Music cue guidance: bundled preset copied to
  `assets/music/happy-beats-business-moves-vol-10-by-ende-dot-app.music-cues.json`
  (109.96 BPM). Every scene boundary sits on the grid (1.37, 2.46, 3.55, 5.19, 6.82,
  8.22, 9.83, 11.47). Strong cues at 8.73 / 15.82 / 18.01 / 18.55 / 20.19 — the Race Ops
  push locks to 6.82 and the `LIFT & COAST` slam to 11.47. The three `NO …` beats snap to
  14.73 / 15.28 / 15.82.
- Audio-reactive treatment: expressive but not literal — music RMS drives a red glow
  behind the giant type, and a 3–6% breath on the `LIFT & COAST` wordmark only. No
  waveform, no equalizer, no strobing type.
- Audio-coupled moments: every scene cut, the four zone chips (3.95–4.31), the tower row
  stack, the three `NO …` beats, the final cut to black
- SFX selection guidance: one heavy hit per cut, a glitch on the question, a plate hit on
  the steward banner, a deep bell on the wordmark. Read
  `/home/hussain/.agents/skills/brag/assets/sfx/sfx-analysis.md`; the glitch files are
  bright, so keep them to tiny isolated accents.
- Exact SFX choice: Hyperframes picks filenames, timestamps, density and volume from the
  implemented animation.
- Audio files: SFX already copied into `assets/sfx/{impact,interface,ui}/`

## Hyperframes Instructions

Load the Hyperframes domain skills — `hyperframes-core`, `hyperframes-animation`,
`hyperframes-creative`, `hyperframes-keyframes`, `hyperframes-cli`. /brag is its own
workflow: do not enter the `hyperframes` entry-point intent interview and do not route
into its generic promo / launch-video workflow.

Requirements:

- Show at least one real UI, copy, or visual element from the source project — this cut
  shows five.
- Keep all text readable. 200px display type on a hard scrim; WCAG contrast failures gate
  as errors in `check`, and the circuit-tag `///` needs a lighter red than `#ff3b2f` to
  clear 4.5:1 against a bright sky.
- Keep the video within 15–25 seconds (16.93s planned).
- Overlay chrome is authored in 1920x1080 design units inside a `.stage` wrapper using
  `zoom` (never `transform: scale`) so type re-rasterises at 2K instead of being
  composited up. Frame pans on the 2560px images are in 2560 space.
- Run `hyperframes check` before render — that is brag's single gate.
