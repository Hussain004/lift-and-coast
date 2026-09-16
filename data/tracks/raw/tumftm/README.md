# TUMFTM racetrack-database (track widths)

Vendored, unmodified copies of the track-width files from:

- **Source:** https://github.com/TUMFTM/racetrack-database
- **Author:** Chair of Automotive Technology, Technical University of Munich
  (contact: Alexander Heilmeier)
- **License:** LGPL-3.0 (see `LICENSE-LGPL-3.0.txt`)
- **Format:** `x_m,y_m,w_tr_right_m,w_tr_left_m` — a smooth closed centerline
  in a local metric frame, plus the track width to the right and left of it.
  Widths were extracted from satellite imagery by an image-processing
  algorithm; centerlines originate from OpenStreetMap GPS traces.

## Why these files are here

`bacinger/f1-circuits` (the project's centerline source) carries only a single
`altitude` number per circuit and no width. These files supply the missing
**real per-point track width** so `scripts/build-track.mts` can replace the
old flat 13 m placeholder in each track JSON's `width[]` array.

## How they are used

`scripts/build-track.mts` (`loadTumftmWidths` / `fitRigidTo` /
`transferWidths`):

1. Mirror the file's y axis (`z = -y`) — the project's own projection maps
   latitude to `-z`, so the two hand-built frames are mirror images.
2. Rigidly align this file's centerline onto the built circuit's centerline
   with a small deterministic ICP (rotation + translation only), seeded from
   the centroid. Converges to a **1.2–1.8 m** RMS residual on all four
   circuits — i.e. the two independent centerlines describe the same shape.
3. For each built centerline point, take the total width
   (`w_tr_right_m + w_tr_left_m`) of the nearest file point, then smooth the
   result along the lap (wrapping).

Total width is used (not left/right separately) because this file's smoothed
centerline is deliberately *not* the geometric middle of the track, while the
project's `width[]` is applied symmetrically about the project's own
centerline.

## Sanity check

Computed perimeter per file vs. the real circuit length (bacinger `length`):

| Circuit | File perimeter | Real length | Diff |
| :--- | ---: | ---: | ---: |
| Spa | 7000 m | 7004 m | 0.06% |
| Silverstone | 5887 m | 5891 m | 0.07% |
| Monza | 5790 m | 5793 m | 0.05% |
| Suzuka | 5803 m | 5807 m | 0.07% |

Upstream warns accuracy varies by location; treat the absolute values as
good-but-not-surveyed and the along-lap variation as the reliable signal.
