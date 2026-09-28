-- Remove the smoke-test row written while bringing the table up.
--
-- Deliberately done as a migration rather than a client DELETE: the RLS
-- policies intentionally grant no update or delete to the anon role, so rows
-- are immutable from the browser. That is the right default for a public
-- board, and it also means a one-off correction like this has to come
-- through the migration path, where it is reviewed and auditable.
--
-- Scoped to the exact placeholder client_id used by the smoke test, so a real
-- player's row can never be caught by it.
delete from public.lap_records
where client_id = '11111111-1111-4111-8111-111111111111'::uuid;
