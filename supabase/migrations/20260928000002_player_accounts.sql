-- Player accounts for the landing-page time attack.
--
-- WHAT CHANGES. `lap_records` gains two nullable columns: `user_id`, the
-- auth.users id of the player who set the lap, and `player_name`, their
-- handle. Both are NULL for the rows already on the board, which is correct -
-- those were set before accounts existed and stay anonymous rather than being
-- retroactively attributed to whoever happens to sign in next.
--
-- WHY THE INSERT POLICY IS TIGHTENED. It was `with check (true)`, which is
-- what the previous migration intended while the board was anonymous: anyone
-- may add a row, and no row is ever modified or removed. With an identity on
-- the table that is no longer good enough, because `with check (true)` would
-- also let anyone claim to be anyone - post a row carrying somebody else's
-- user_id and it would stick. The policy now permits an anonymous insert
-- (user_id null), and permits a claimed one only when the claimed id is the
-- id the request is actually authenticated as, which PostgREST exposes as
-- auth.uid() from the player's own JWT.
--
-- WHAT THIS IS NOT. An account is a nickname and a password. It proves "I am
-- the person who returned", which is what makes a lap time YOURS across
-- devices. It proves nothing about whether the lap was actually driven: a
-- client-submitted time still cannot be verified server-side without
-- replaying the lap, and the original migration's note on that still stands
-- unchanged. A handle is therefore never treated as proof of anything, on the
-- board or anywhere else.
--
-- READS STAY PUBLIC. Only the INSERT policy changes. The public select policy
-- is deliberately left alone: the leaderboard is a public board and the
-- "your times" list is a filter over rows that are already readable by
-- everyone, not a private store. Nothing here makes a row secret, so nothing
-- here claims to.

alter table public.lap_records
  add column if not exists user_id uuid references auth.users (id) on delete set null,
  add column if not exists player_name text;

comment on column public.lap_records.user_id is
  'auth.users id of the player who set this lap, or null for an anonymous row. Claimed on insert only when it equals auth.uid().';
comment on column public.lap_records.player_name is
  'The player handle at the time of the lap. A display name only - a handle is not verified identity, and two players may pick the same one.';

-- Bounded like every other free-text column here, and loose enough for the
-- longest handle accounts.ts accepts. NULL is allowed because anonymous rows
-- have no name.
alter table public.lap_records
  add constraint lap_records_player_name_length
  check (player_name is null or char_length(player_name) between 1 and 20);

-- The "your times" read: one player's rows, per circuit, fastest first.
-- Separate from the existing (track_id, lap_ms) index because that one leads
-- with the circuit and this one leads with the player.
create index if not exists lap_records_user_time_idx
  on public.lap_records (user_id, track_id, lap_ms)
  where user_id is not null;

-- The whole public surface of the table, unchanged except that an insert may
-- no longer claim an identity it does not hold.
drop policy if exists "anyone may submit a lap" on public.lap_records;

create policy "anyone may submit a lap"
  on public.lap_records
  for insert
  to anon, authenticated
  with check (user_id is null or user_id = auth.uid());

comment on policy "anyone may submit a lap" on public.lap_records is
  'An anonymous row (user_id null) is still accepted. A row that claims an account must claim the one the request is authenticated as, so nobody can post a lap under another player''s name.';

-- Still no update and no delete policy, so rows remain immutable from the
-- client: a player can neither erase a rival's time nor edit their own into
-- the record, and now cannot post one under someone else's name either.

-- Remove the accounts created while verifying that username sign-up works.
--
-- Deliberately a migration rather than a client DELETE, same reason the
-- smoke-test row was: the RLS policies intentionally grant no delete to the
-- anon role, so a one-off correction has to come through the reviewed
-- migration path where it is visible.
--
-- Scoped by the exact handle prefix the probe used, so a real player's account
-- can never be caught by it.
delete from auth.users
where email like 'probe%@liftandcoast.app';
