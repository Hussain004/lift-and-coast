-- Remove the rows written while verifying the accounts RLS policy.
--
-- The RLS policies intentionally grant no delete to the anon role, so this has
-- to come through the migration path - the same reasoning as the smoke-test
-- row removal above, and the reason a one-off correction belongs somewhere
-- reviewable.
--
-- Scoped to the exact placeholder client_ids the checks used, which is why
-- they were chosen as fixed literals rather than generated: a real player's
-- row can never carry one of these.
delete from public.lap_records
where client_id in (
  '22222222-2222-4222-8222-222222222222'::uuid,
  '892f4e18-8605-4287-9f6d-34098811b901'::uuid
);

-- And the account the policy check signed up as. The handle prefix is the
-- exact one the check used.
delete from auth.users
where email like 'rlscheck%@liftandcoast.app';
