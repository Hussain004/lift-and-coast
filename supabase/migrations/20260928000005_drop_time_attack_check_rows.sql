-- Remove the rows and accounts written by the time-attack save-path check.
--
-- Same reasoning as the two cleanups above: the RLS policies intentionally
-- grant no delete to the anon role, so a one-off correction has to come
-- through the migration path where it is reviewable.
--
-- Scoped by the exact driver code the check used, by the exact placeholder
-- client_id it used for the anonymous lap, and by the exact handle prefixes the
-- check signed up with - so a real player's row can never match any of them.
delete from public.lap_records
where driver_code = 'TAC'
   or client_id = '77777777-7777-4777-8777-777777777777'::uuid;

delete from auth.users
where email like 'tacheck%@liftandcoast.app';
