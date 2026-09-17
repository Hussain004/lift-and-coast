# Open-Meteo elevation samples (track elevation)

Vendored output of `scripts/fetch-elevation.mts` — the raw elevation samples
the track build bakes into each centerline's `y`.

- **Endpoint:** https://api.open-meteo.com/v1/elevation
- **Elevation model:** Copernicus DEM GLO-90 (roughly 90 m per sample),
  served by [Open-Meteo](https://open-meteo.com/) under CC-BY 4.0
  (attribution: "Elevation data by Open-Meteo.com, based on Copernicus DEM").
- **Format:** `{ "coordinates": [[lon, lat], ...], "elevationMeters": [...] }`
  — one elevation per coordinate, in the same order.

## Why these files are here

`bacinger/f1-circuits` (the project's centerline source) carries only a single
`altitude` number per circuit, so every centerline used to be built flat at
`y = 0`. These files supply a **real elevation profile along the lap** so
`scripts/build-track.mts` can bake `centerline[i][1]`.

## How they were produced

`node --experimental-strip-types scripts/fetch-elevation.mts` walks each raw
circuit polyline at a fixed **25 m** arc-length spacing (not the raw vertices
— those are up to 377 m apart on Spa), batches up to 100 coordinates per
request, and vendors the result here. The script is a one-off: the build reads
these files offline and deterministically, exactly like the TUMFTM width CSVs.

## How they are used

`scripts/build-track.mts` (`loadElevationSource` / `averageElevations`):

1. Project the sample lon/lat with the same `lonLatToMeters` (and circuit
   centre) as the centerline, so both live in one frame.
2. For each built centerline point, take the distance-weighted mean
   (`(1 - d/R)^2`) of every sample within **300 m in the projected plane**,
   falling back to the nearest sample.
3. Subtract the elevation at the start/finish line, so `centerline[0][1] = 0`
   and the start position, spawn and reset all stay independent of the DEM's
   own datum (which disagrees with bacinger's `altitude` by tens of metres).

Averaging in the **plane** rather than along the lap matters: the DEM cannot
see an overpass, so the two arms of a self-crossing (Suzuka) must read the
same hillside or the ground under one of them ends up metres out. See the
comments on `averageElevations` and `lib/tracks/terrain.ts`.

## Accuracy

A 90 m DEM reports the terrain **around** the circuit, not the asphalt's own
grade, so this is deliberately coarse: read the coarse shape of a lap, not a
surveyed surface. Built profiles: Silverstone 10.7 m of relief at a 1.9 %
peak grade, Monza 19.7 m / 3.8 %, Suzuka 44.5 m / 6.4 %, Spa 91.9 m / 11.4 %.
`tests/trackRegistry.test.ts` band-checks those numbers.
