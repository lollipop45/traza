-- TRAZA · tasks: enable writes for signed-in users now that authentication exists.
--
-- The owner-only RLS policies (select / insert / update / delete) were created in
-- 20261005114557_create_tasks.sql. This migration only adds the table privileges they need.
--
-- Privileges are column-scoped: clients may write task content, but never the identity or
-- bookkeeping columns. `id`, `user_id` (default auth.uid()), `created_at` and `updated_at`
-- (trigger) are always set by the database. Row ownership remains enforced by RLS.
-- `anon` keeps no privileges at all.

grant insert (title, description, status, priority, due_date, completed_at, project_id, source, external_id)
  on table public.tasks to authenticated;

grant update (title, description, status, priority, due_date, completed_at, project_id, source, external_id)
  on table public.tasks to authenticated;

grant delete on table public.tasks to authenticated;
