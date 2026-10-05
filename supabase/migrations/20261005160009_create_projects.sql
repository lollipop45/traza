-- TRAZA · projects
-- Second persisted entity, and the real relationship tasks.project_id -> projects.id.
-- Schema only: no personal data is inserted. Projects are created by each user through the app.
--
--   1. public.projects (owner-only, RLS)
--   2. tasks -> projects foreign key that also enforces "same owner"
--   3. tighter task write privileges (future-sync columns are no longer client-writable)

-- ---------------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------------
create table public.projects (
  id          uuid        primary key default gen_random_uuid(),
  -- Owner. Defaults to the calling user so clients never send it; RLS enforces it.
  user_id     uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  name        text        not null,
  -- Free-text grouping chosen by the user ("Arquitectura", "Universidad", …).
  area        text,
  description text,
  status      text        not null default 'active',
  -- Manual estimate, 0–100. Task counts are derived from public.tasks, never stored here.
  progress    smallint    not null default 0,
  source      text        not null default 'manual',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint projects_name_length        check (char_length(btrim(name)) between 1 and 120),
  constraint projects_area_length        check (area is null or char_length(btrim(area)) between 1 and 60),
  constraint projects_description_length check (description is null or char_length(btrim(description)) between 1 and 2000),
  constraint projects_status_valid       check (status in ('active', 'planned', 'archived')),
  constraint projects_progress_range     check (progress between 0 and 100),
  constraint projects_source_valid       check (source in ('manual', 'canvas', 'ai')),
  -- Target of the composite foreign key from public.tasks (see section 2).
  constraint projects_id_user_id_key     unique (id, user_id)
);

comment on table public.projects is 'Personal projects. One owner per row (user_id); access is owner-only via RLS.';
comment on column public.projects.progress is 'Manual progress estimate, 0–100.';

create trigger projects_set_updated_at
  before update on public.projects
  for each row
  execute function public.set_updated_at();

-- Serves the RLS ownership filter, the user_id foreign key and "my projects in creation order".
create index projects_user_id_created_at_idx on public.projects (user_id, created_at);

-- ---------------------------------------------------------------------------
-- 1b. Row Level Security: owner-only access for signed-in users. anon gets nothing.
-- ---------------------------------------------------------------------------
alter table public.projects enable row level security;

create policy "Users can read their own projects"
  on public.projects for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can create their own projects"
  on public.projects for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update their own projects"
  on public.projects for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete their own projects"
  on public.projects for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- Data API privileges: explicit and column-scoped. Clients write project content only; id,
-- user_id, source and the timestamps are always set by the database.
revoke all on table public.projects from anon, authenticated;

grant select on table public.projects to authenticated;
grant insert (name, area, description, status, progress) on table public.projects to authenticated;
grant update (name, area, description, status, progress) on table public.projects to authenticated;
grant delete on table public.projects to authenticated;

grant select, insert, update, delete on table public.projects to service_role;

-- ---------------------------------------------------------------------------
-- 2. tasks.project_id -> projects.id, with matching owners
-- ---------------------------------------------------------------------------
-- A plain `project_id references projects (id)` would let user A point a task at user B's
-- project if A learnt its id: foreign-key checks run without RLS. Referencing the pair
-- (id, user_id) instead means the referenced project must have the SAME owner as the task.
-- tasks.user_id is fixed by RLS (WITH CHECK) and is not client-writable, so this cannot be
-- bypassed. With MATCH SIMPLE (the default) a null project_id is simply "no project".
--
-- On project deletion only project_id is cleared (Postgres 15+ column list); the task and its
-- owner stay. Projects' id and user_id are not client-writable, so ON UPDATE never applies.
alter table public.tasks
  add constraint tasks_project_owner_fkey
  foreign key (project_id, user_id)
  references public.projects (id, user_id)
  on delete set null (project_id);

-- Foreign-key lookups (project deletion) and per-project task counts.
create index tasks_project_id_idx on public.tasks (project_id);

comment on column public.tasks.project_id is 'Optional project; must belong to the same user (tasks_project_owner_fkey).';

-- ---------------------------------------------------------------------------
-- 3. Tighten task write privileges
-- ---------------------------------------------------------------------------
-- 20261005123716 let clients insert/update `source` and `external_id`, reserved for future
-- Canvas/AI imports. No client feature writes them and they are bookkeeping for idempotent
-- syncs, so a user editing them could only corrupt their own import state. Revoke until a sync
-- feature actually needs them (it should run server-side). Everything the app writes
-- (title, description, status, priority, due_date, completed_at, project_id) stays granted.
revoke insert (source, external_id), update (source, external_id) on table public.tasks from authenticated;
