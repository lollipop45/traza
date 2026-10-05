-- TRAZA · tasks
-- First persisted entity. Every task belongs to exactly one Supabase Auth user and is only
-- reachable by that user through the Data API. No application writes are enabled yet.

-- ---------------------------------------------------------------------------
-- Shared trigger function: keep updated_at correct regardless of the client.
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function public.set_updated_at() is 'Trigger: stamps updated_at on every UPDATE.';

-- Trigger functions are never meant to be called directly (e.g. via /rpc).
revoke execute on function public.set_updated_at() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------
create table public.tasks (
  id           uuid        primary key default gen_random_uuid(),
  -- Owner. Defaults to the calling user so clients never send it; RLS enforces it.
  user_id      uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  -- Future link to public.projects; the foreign key is added together with that table.
  project_id   uuid,
  title        text        not null,
  description  text,
  status       text        not null default 'pending',
  priority     text        not null default 'normal',
  -- A calendar day, not an instant: "due on 7 Oct" must not shift with time zones.
  due_date     date,
  completed_at timestamptz,
  source       text        not null default 'manual',
  -- Identifier in the originating system (e.g. a Canvas assignment), for idempotent syncs.
  external_id  text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint tasks_title_not_blank      check (char_length(btrim(title)) between 1 and 500),
  constraint tasks_status_valid         check (status in ('pending', 'done')),
  constraint tasks_priority_valid       check (priority in ('low', 'normal', 'high')),
  constraint tasks_source_valid         check (source in ('manual', 'canvas', 'ai')),
  constraint tasks_completed_when_done  check (completed_at is null or status = 'done'),
  constraint tasks_external_id_not_blank check (external_id is null or char_length(btrim(external_id)) > 0)
);

comment on table public.tasks is 'Personal tasks. One owner per row (user_id); access is owner-only via RLS.';
comment on column public.tasks.project_id is 'Future FK to public.projects(id).';
comment on column public.tasks.external_id is 'ID in the source system (source <> manual); unique per user and source.';

create trigger tasks_set_updated_at
  before update on public.tasks
  for each row
  execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
-- Serves the RLS ownership filter, the user_id foreign key, and "my tasks by due date".
create index tasks_user_id_due_date_idx on public.tasks (user_id, due_date);

-- An external item can only be imported once per user and source.
create unique index tasks_user_source_external_id_key
  on public.tasks (user_id, source, external_id)
  where external_id is not null;

-- ---------------------------------------------------------------------------
-- Row Level Security: owner-only access for signed-in users. anon gets nothing.
-- ---------------------------------------------------------------------------
alter table public.tasks enable row level security;

create policy "Users can read their own tasks"
  on public.tasks for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can create their own tasks"
  on public.tasks for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update their own tasks"
  on public.tasks for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete their own tasks"
  on public.tasks for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- Data API privileges (explicit; do not rely on project default privileges).
-- ---------------------------------------------------------------------------
-- Existing projects may still auto-grant new public tables to anon/authenticated; start from zero.
revoke all on table public.tasks from anon, authenticated;

-- Read-only for signed-in users until the authentication phase. The write policies above are
-- already in place; that phase only needs:
--   grant insert, update, delete on table public.tasks to authenticated;
grant select on table public.tasks to authenticated;

-- Server-side administration only (bypasses RLS; its key must never reach the browser).
grant select, insert, update, delete on table public.tasks to service_role;
