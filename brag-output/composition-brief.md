# Hyperframes Composition Brief: LIFT & COAST

## Objective

Create a short launch-style brag video for LIFT & COAST, a browser-based 2026-regulation
formula racing game.

## Output

- Composition directory: `brag-output/composition/`
- Rendered video: `brag-output/brag.mp4`
- Format: landscape — 1920x1080
- Duration: 21.3s

## Source Material

- Project root: `/home/hussain/lift_and_coast`
- Primary files read: `README.md`, `app/page.tsx`, `app/Hero.tsx`, `app/globals.css`,
  `app/page.module.css`, `app/layout.tsx`, `app/race/page.tsx`, `app/race/Track.tsx`,
  `app/race/RaceOpsPanel.tsx`, `app/SessionSetup.tsx`, `app/Multiplayer.tsx`,
  `app/Championship.tsx`, `app/TopBar.tsx`, `app/footer` (in `app/page.tsx`),
  `lib/tracks/registry.ts`, `lib/tracks/racingLine.ts`, `lib/race/rosterData.ts`,
  `lib/race/sessionSetup.ts`, `data/teams.json`
- Product name: **LIFT & COAST**
- Tagline / strongest claim: **"Save the juice. Send the apex."** and the footer line
  **"Lift & coast: it's not slow, it's strategic."**
- Key UI / visual moments to recreate:
  1. **The racing line ribbon** — a thick broadcast-style band painted on the tarmac
     that recolors by zone: teal `#14c78c` (throttle), amber `#f2ad1f` (lift),
     orange `#fa5110` (brake-medium), crimson `#c7071f` (brake-hard). This is the
     product's signature visual and the centerpiece of the video.
  2. **The broadcast timing tower** — `CIRCUIT DE SPA-FRANCORCHAMPS` header, `POS /
     DRIVER / INT / GAP` columns, driver-code chips in team colors (LEC, HAD, BOT, …),
     interval and gap values.
  3. **The in-race HUD cluster** — red `GEAR` block, oversized `KM/H` readout, `RPM /
     POWER UNIT` bar, `ERS / DEPLOYMENT` bar, `THR / BRK / STR` input bars,
     `TYRE MEDIUM 100%`, `AERO HIGH DOWFOR…`, `ASSISTS TC ON ABS ON GEARS AUTO PAD OFF`,
     and the top strip `LAP 1  0:04.383  BEST --:--.---`, `P20`, `S1 / S2 / S3` sectors.
  4. **The red steward banner** — `TRACK LIMITS WARNING 2/3` in `#e10600` on a dark chip.
  5. **The hero's five start lights** — five circles above the wordmark that light up
     in sequence, the way an F1 grid works.
- Copy that must appear verbatim:
  - `2026 regulation era · browser formula racing`
  - `IT'S NOT SLOW.` / `IT'S STRATEGIC.`
  - `THROTTLE` / `LIFT` / `BRAKE` / `BRAKE HARD`
  - `27 CIRCUITS FROM REAL GPS CENTERLINES`
  - `A TWENTY-CAR GRID THAT RACES YOU`
  - `WEATHER` / `ERS` / `TIRES` / `STRATEGY` / `STEWARDS`
  - `TRACK LIMITS WARNING 2/3`
  - `REACT THREE FIBER · RAPIER PHYSICS · 27 CIRCUITS FROM REAL GPS CENTERLINES`
  - The hero frame itself already carries `LIFT & COAST`, `Save the juice. Send the
    apex.`, `DRIVE`, `SCOUT THE CIRCUITS`, and the `27 / 11 / 22 / 20` stat block
    (CIRCUITS / TEAMS / DRIVERS / GRID) — these must stay legible, so do not cover
    the center of `06-hero.png`.

## Real product captures (already in `assets/frames/`)

These are real 1920x1080 screenshots of the running game (Three.js + Rapier, WebGL) —
the game's own HUD is baked into each frame. Use them full-bleed and let them carry
the "show the thing" law. Treat their existing HUD/tower pixels as part of the artwork.

| File | Content | Scene |
|---|---|---|
| `assets/frames/01-spa-tv-corner.png` | TV broadcast camera, Eau Rouge at sunset, kerbs, the line braking teal → amber → crimson | 1 (hook) |
| `assets/frames/02-spa-trackside.png` | Trackside straight, the car on the ribbon, teal line running to the horizon | 2 |
| `assets/frames/03-chase-line.png` | Chase cam, car on the line at ~210 km/h, full HUD + tower | 3 |
| `assets/frames/03b-chase-line.png` | Chase cam variant, higher speed | 3 (alt) |
| `assets/frames/04-rain.png` | Rain at Spa, cold desaturated scene, line + car + live mirrors | 4 |
| `assets/frames/05-helmet.png` | Helmet camera through the halo | 4 (steward banner) |
| `assets/frames/05b-cockpit.png` | Cockpit camera | 4 (alt) |
| `assets/frames/06-hero.png` | The real home hero: wordmark, tagline, DRIVE, 27/11/22/20, circuit ticker | 5 |
| `assets/frames/07-map.png` | The real circuit planner: world map, region filters, track cards | texture reference |

**Scene 3 note:** the chase-cam frames have the game's own timing tower baked in on the
left. Crop/frame the driving view so that baked tower is out of shot, then place the
rebuilt animated timing tower in that same left position, styled to match the app's
`race.module.css` tower (dark translucent panel, red top rule, mono type, colored code
chips).

## Creative Direction

- Tone preset: `polished`
- Creative direction: *F1 TV broadcast graphics package — timing tower, sector strip,
  red accent, gold kicker, mono data, confident restraint.*
- Interpretation: the product is genuinely impressive, so play it straight. Few scenes,
  long holds, one claim per scene. Type that lands and stays. Confidence comes from the
  real footage, not from cuts, speed ramps, or shouted copy. Slow crossfades and clean
  wipes, not zooms or flashes.
- Angle: the game is named after a real driving technique — lifting off the throttle
  mid-corner to rotate the car and save fuel. The whole product argues that
  going-slower-looking is faster. The video is that contradiction, presented as a
  broadcast feed: the racing line that tells you where to lift, a 20-car grid that
  races you, and a whole race weekend inside one browser tab.
- Hook: real in-game TV broadcast shot of a sunset corner at Spa with the racing line
  visibly braking (teal → amber → crimson) under the line `IT'S NOT SLOW. / IT'S
  STRATEGIC.`
- Outro / punchline: the real hero, five start lights on, hold, lights out, and the
  tech credit strip.
- Avoid:
  - Generic SaaS language
  - Abstract filler visuals, color washes, particle backgrounds
  - Unrelated visual redesign — the palette, type, and UI language are the product's
  - Covering the readable center of `06-hero.png` (wordmark, tagline, DRIVE, stats)

## Visual Identity

- Background: `#040509` (page) / `#0a0c12` (panel)
- Text: `#f4f1e8` primary · `#9aa0ac` muted · `#565c68` faint
- Accent: `#e10600` (F1 red) · secondary `#d3ab63` (gold)
- Racing-line zone colors: `#14c78c` · `#f2ad1f` · `#fa5110` · `#c7071f`
- Display font: **Archivo** (600/700/800/900, normal + italic). The wordmark is
  Archivo Black Italic with a red `&`. Use local/embedded fonts or a local fallback —
  do not depend on a network font at render time.
- Body / UI font: **Geist Sans**; data, labels, kickers: **Geist Mono** with wide
  letter-spacing (2–3px), uppercase — this is the app's broadcast-label voice.
- Visual references from the project: the hero wordmark lockup, the five start lights,
  the eyebrow labels (`01 GARAGE`, `02 CIRCUIT` — gold mono with a numbered chip), the
  circuit ticker (`MONACO /// SPIELBERG /// BAHRAIN ///` with red `///`), the timing
  tower, the HUD cluster, and the red DRIVE button with its glow.

## Storyboard

Use `brag-output/brag-plan.md` as the creative contract. Scene summary with exact
boundaries and the text that must be readable in each:

1. **Hook: it's not slow** — `0.00 → 2.73` (2.73s) — `01-spa-tv-corner.png` full-bleed,
   very slow push-in. Gold mono kicker `2026 REGULATION ERA · BROWSER FORMULA RACING`
   at 0.35s. Hook line `IT'S NOT SLOW.` / `IT'S STRATEGIC.` slams in at 0.56s, second
   line in red, settled ~0.9s → cut. Bottom scrim for type legibility.
2. **The line** — `2.73 → 7.64` (4.91s) — `02-spa-trackside.png` full-bleed, slow drift.
   Four zone callouts appear one at a time (swatch + label) at 4.39 / 4.91 / 5.34 /
   6.00s in the product's zone colors, holding as a group. Mono gold headline
   `27 CIRCUITS FROM REAL GPS CENTERLINES` lands at 6.56s and holds to the cut.
3. **The grid** — `7.64 → 12.02` (4.38s) — `03-chase-line.png` cropped to the driving
   view; broadcast timing tower builds one row at a time from 8.74s with real 2026
   driver codes and team color chips, interval + gap columns filling in, full field
   standing by ~11.5s. Headline `A TWENTY-CAR GRID THAT RACES YOU` at 10.93s.
4. **The race weekend** — `12.02 → 16.93` (4.91s) — `04-rain.png` full-bleed, slow push.
   Five broadcast tag chips drop one at a time from 12.55s (`WEATHER`, `ERS`, `TIRES`,
   `STRATEGY`, `STEWARDS`), holding as a row. On 13.11s, cut to `05-helmet.png` with
   the app's red `TRACK LIMITS WARNING 2/3` banner flashing across the top. Banner
   clears, tag strip holds to the cut.
5. **Outro: lights out** — `16.93 → 21.28` (4.35s) — `06-hero.png` full-bleed. Five
   start lights above the wordmark light up one by one (17.47 / 17.9 / 18.3 / 18.56 /
   18.9), hold red to 20.19s, all extinguish on that beat, and the red DRIVE button
   gets one soft pulse. Mono credit strip fades up at 19.66s. Fade to `#040509` over
   the last 0.8s.

Beat-locked moments (from the bundled preset, 109.96 BPM): **8.74s** first tower row,
**13.11s** steward banner + STEWARDS tag, **18.56s** start-light sequence, **20.19s**
lights out. Everything else may align to the beat grid within ±0.10s.

## Audio

- Audio role: driving, percussive bed; the restraint lives in the SFX, not the music.
- Audio arc: enter dry on the first beat and hold one steady level for the whole edit;
  after lights-out let the music ring and fade over 1.2s while one deep bell carries
  the last beat.
- Music: `assets/music/happy-beats-business-moves-vol-12-by-ende-dot-app.mp3`
  (1:58, steady and clean — the `polished` pick), already copied into the composition.
- Music treatment: start 0.0s, volume 0.30, no fade-in, 1.2s fade-out on the tail,
  ending around 20.2s.
- Music cue guidance: bundled preset already copied to
  `assets/music/happy-beats-business-moves-vol-12-by-ende-dot-app.music-cues.json`
  (tempo 109.96 BPM). Strong cues in the window: 8.74, 10.93, 13.11, 17.47, 18.56,
  19.66, 22.37, 22.93s. Use as optional timing hints only — the planned scene
  boundaries are the contract, and readability wins over beat alignment.
- Audio-reactive treatment: subtle; let music RMS breathe the red accent glow behind
  the wordmark in Scene 5 and add a soft edge glow to the Scene 1 hook line on the two
  biggest musical moments. No waveform, no equalizer, no text scaling, no strobing.
- Audio-coupled moments:
  - Scene 1 — the two hook lines land on consecutive beats (0.56s, 1.09s)
  - Scene 2 — four zone callouts in sequence, one light tick each
  - Scene 3 — the timing tower's sequential row build (accent the first and last row
    only; a tick on every row would be noise)
  - Scene 4 — five broadcast tags dropping one by one; one restrained accent on the
    steward banner
  - Scene 5 — one tick per start light, then total silence on lights-out so the bell
    carries
- SFX selection guidance: polished means sparse and motion-matched — a soft low impact
  on the hook slam, quiet UI ticks on the zone callouts, a dry interface click per
  broadcast tag, a restrained plate/wood accent on the steward banner, and one deep
  resonant bell on the wordmark at lights-out. Read
  `/home/hussain/.agents/skills/brag/assets/sfx/sfx-analysis.md` for per-file
  high-frequency risk and prefer low-risk files for these repeated quiet moments.
- Exact SFX choice: Hyperframes should choose filenames, timestamps, density, and
  volume based on the implemented animation.
- Audio files: copy the chosen SFX into `assets/sfx/{interface,impact,ui}/`.

## Hyperframes Instructions

Load the composition-building Hyperframes domain skills — `hyperframes-core`,
`hyperframes-animation`, `hyperframes-creative`, `hyperframes-keyframes`, and
`hyperframes-cli`. /brag is its own workflow: do not enter the `hyperframes`
entry-point intent interview and do not route into its generic promo / launch-video
workflow.

Requirements:

- Show at least one real UI, copy, or visual element from the source project. The
  gameplay captures and the hero frame are the primary material.
- Keep all text readable in the final render. WCAG contrast failures gate as errors in
  `check` — use the suggested compliant colors, and never cover the readable center of
  the hero frame.
- Keep the video within 15-25 seconds (21.3s planned).
- Include the planned music/SFX layer.
- The baked-in HUD in the gameplay frames is low-contrast by nature; keep any new type
  on scrims or clear areas of the frame so it stays legible.
- Use local assets for audio, fonts, and frames; no network dependencies at render time.
- Run `hyperframes check` before render — that is brag's single gate.
