-- Per-account control settings.
--
-- LOCAL FIRST: a player who never signs in keeps their settings in
-- localStorage and the game is fully playable with no account. This table is
-- the optional second copy for players who DO sign in - it is additive, and
-- nothing in the game's critical path reads it.
--
-- What it deliberately does NOT do is make the leaderboard trustworthy. A lap
-- is still submitted by the client; see lap_records' own comment. Identifying
-- the player changes who set a time, not whether the time happened.
--
-- Identity is Supabase Auth's own user id, so there is no profile table to
-- keep in step and no separate "is this really you" question: the row's
-- primary key IS the authenticated user.

create table if not exists public.control_settings (
  -- auth.users.id, so the row can only ever belong to a real account.
  user_id uuid primary key references auth.users (id) on delete cascade,
  -- The whole control set as one blob: bindings plus sensitivity. Small,
  -- written as a unit, and read as a unit, so a row is never half one
  -- person's settings and half another's.
  bindings jsonb not null,
  settings jsonb not null,
  updated_at timestamptz not null default now()
);

comment on table public.control_settings is
  'Optional per-account copy of a player''s control bindings and sensitivity. Local-first: the game is playable and settings are saved without an account.';

-- Row level security. With RLS on and a policy scoped to auth.uid(), each
-- player can see and write exactly their own row and nobody else's - the
-- policy below is the entire surface, and `service_role` bypasses RLS for
-- admin use only.
alter table public.control_settings enable row level security;

-- Read your own settings.
create policy "read your own control settings"
  on public.control_settings
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- Write your own settings, and only your own: WITH CHECK is what stops a
-- client writing a row keyed to somebody else's user id.
create policy "write your own control settings"
  on public.control_settings
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "update your own control settings"
  on public.control_settings
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- No delete policy: a row is cheap and there is no need for a player to be
-- able to remove their own record, and leaving it out means a compromised
-- session cannot destroy it either.
