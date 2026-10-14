-- Shared lap ghosts for Time Trial: race the next-faster rival, or the world
-- record.
--
-- WHAT THIS STORES. One row per submitted lap that came with a ghost: the lap's
-- 10 Hz trace (lib/race/ghostCodec.ts: int16-quantised, gzipped, then base64 so
-- PostgREST can carry it as plain JSON text) plus the few facts the picker
-- needs to label it, copied from the lap so the picker is one indexed read with
-- no join.
--
-- A SEPARATE TABLE, NOT A COLUMN ON lap_records. The leaderboard is the hot
-- query and reads many narrow rows; a 20-40 KB trace on each would make every
-- board read drag the blobs along (or force a column list on every caller).
-- Keeping ghosts apart also lets them be pruned on their own.
--
-- THE LIMIT OF THE GUARDS, stated plainly like the lap_records migration does.
-- A trace is client-supplied and cannot be verified server-side without
-- replaying the lap. The client runs the plausibility checks in
-- lib/race/ghostUploadGuard.ts (duration matches the lap time, travel matches
-- the circuit length) before uploading, and the policy below ties each ghost to
-- a lap row that exists with the same circuit, time and owner. Together they
-- stop casual junk and mismatched uploads. They are not anti-cheat.

create table if not exists public.ghosts (
  -- The lap this ghost belongs to. Deleting the lap (the retention prune)
  -- deletes its ghost with it.
  lap_id uuid primary key references public.lap_records (id) on delete cascade,
  track_id text not null,
  lap_ms integer not null check (lap_ms between 50000 and 1800000),
  driver_code text not null check (char_length(driver_code) between 2 and 4),
  -- Same value as the lap row's client_id (the account id for a signed-in
  -- player, the browser's anonymous id otherwise).
  client_id uuid not null,
  player_name text check (player_name is null or char_length(player_name) between 1 and 20),
  -- base64 of the ghost blob. 200k characters is ~150 KB of blob: several
  -- times the largest real lap (~15-40 KB), and a hard ceiling on abuse.
  trace text not null check (char_length(trace) between 40 and 200000),
  created_at timestamptz not null default now()
);

-- The picker's two queries are both "fastest ghosts on one track".
create index if not exists ghosts_track_time_idx
  on public.ghosts (track_id, lap_ms);

comment on table public.ghosts is
  'Client-submitted lap traces for Time Trial rival and world-record ghosts. Public read, insert only alongside a matching lap_records row. Not anti-cheat.';

alter table public.ghosts enable row level security;

create policy "ghosts are public"
  on public.ghosts
  for select
  to anon, authenticated
  using (true);

-- A ghost may only be added for a lap row that already exists and agrees with
-- it on circuit, time and owner. That stops a ghost being attached to someone
-- else's lap with a different time, or to a lap that was never posted.
create policy "a lap may add its ghost"
  on public.ghosts
  for insert
  to anon, authenticated
  with check (
    exists (
      select 1
      from public.lap_records r
      where r.id = ghosts.lap_id
        and r.track_id = ghosts.track_id
        and r.lap_ms = ghosts.lap_ms
        and r.client_id = ghosts.client_id
    )
  );

-- No update and no delete policy: like the laps themselves, ghosts are
-- immutable from the client.
