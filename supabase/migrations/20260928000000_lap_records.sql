-- Lap-time leaderboard.
--
-- One row per submitted lap. The board is public-read and client-submitted:
-- the browser posts a lap, RLS decides whether the row is plausible enough to
-- store, and every read is ordered by lap_ms.
--
-- That design has an honest limitation, recorded here rather than hidden: a
-- client-submitted time cannot be verified server-side, so a determined
-- player can post an impossible lap. Every guard below is a plausibility
-- bound that raises the cost of casual tampering, NOT an anti-cheat. Making
-- the board trustworthy would mean replaying the lap server-side from a
-- recorded input trace, which is a different (much larger) feature.
--
-- Identity is anonymous and per-browser: client_id is a UUID the client
-- generates and keeps in localStorage. There are no accounts, nothing to
-- leak, and no sign-up.

create table if not exists public.lap_records (
  id uuid primary key default gen_random_uuid(),
  -- Which circuit. Constrained to the shipped roster so a typo or a probe
  -- cannot create unbounded junk track ids.
  track_id text not null check (track_id in (
    'silverstone', 'monza', 'spa', 'suzuka', 'monaco', 'spielberg', 'bahrain',
    'cota', 'zandvoort', 'budapest', 'melbourne', 'montreal', 'mexico',
    'shanghai', 'interlagos', 'yasmarina', 'hockenheim', 'sepang', 'sochi',
    'nurburgring', 'miami', 'barcelona', 'madrid', 'baku', 'singapore',
    'lasvegas', 'lusail', 'jeddah', 'imola', 'istanbul'
  )),
  -- Lap time in whole milliseconds. The band is deliberately wide (50s-30min):
  -- the point is to reject garbage, not to police the physics.
  lap_ms integer not null check (lap_ms between 50000 and 1800000),
  -- FIA driver code from the shipped roster, so the board can show a name.
  driver_code text not null check (char_length(driver_code) between 2 and 4),
  team_id text not null check (char_length(team_id) between 2 and 40),
  compound text not null check (compound in ('soft', 'medium', 'hard', 'intermediate', 'wet')),
  -- Anonymous per-browser identity, generated client-side.
  client_id uuid not null,
  created_at timestamptz not null default now()
);

-- The board's only query shape: fastest N for one track. Descending on
-- created_at inside the index is free here and lets a future "recent
-- records" view avoid a second sort.
create index if not exists lap_records_track_time_idx
  on public.lap_records (track_id, lap_ms, created_at desc);

-- Records age out: a lap set years ago on an older physics model is not
-- comparable to today's, so a year is a reasonable shelf life for a game
-- that is still being tuned.
create or replace function public.prune_lap_records()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.lap_records where created_at < now() - interval '365 days';
$$;

comment on table public.lap_records is
  'Client-submitted lap times. Public read, plausibility-checked insert. Not anti-cheat: a lap cannot be verified server-side without replaying it.';

-- Row level security. With RLS on and no policy, the table is invisible to
-- the anon role, which is the safe default; the two policies below are the
-- entire public surface.
alter table public.lap_records enable row level security;

-- Anyone may read the board.
create policy "lap_records are public"
  on public.lap_records
  for select
  to anon, authenticated
  using (true);

-- Anyone may submit, subject to the column checks. Postgres applies the CHECK
-- constraints before the policy, so an out-of-range time is rejected at the
-- table rather than needing a second copy of the rule here.
create policy "anyone may submit a lap"
  on public.lap_records
  for insert
  to anon, authenticated
  with check (true);

-- No update and no delete policy: rows are immutable from the client, so a
-- player cannot erase a rival's time or edit their own into the record.
