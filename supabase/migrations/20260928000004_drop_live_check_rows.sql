-- Remove the rows and account written by the end-to-end accounts check.
--
-- Same reasoning as the RLS policy check above: the policies intentionally
-- grant no delete to the anon role, so a one-off correction has to come
-- through the migration path where it is visible.
--
-- Scoped by the exact handle prefix the check used and by the exact placeholder
-- client_id it used for the anonymous lap, so a real player's row can never
-- match either.
delete from public.lap_records
where player_name like 'live%'
   or client_id = '88888888-8888-4888-8888-888888888888'::uuid;

delete from auth.users
where email like 'live%@liftandcoast.app';
