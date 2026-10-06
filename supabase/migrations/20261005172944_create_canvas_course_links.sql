-- TRAZA · canvas_course_links
-- Integration metadata: which Canvas courses the user tracks, and the TRAZA project each one feeds.
-- Schema only: no personal data is inserted. No Canvas token is ever stored in the database.
--
-- States:
--   linked   course -> project (project_id required)
--   ignored  the user chose not to track it (project_id must be null)
--   (no row) unmapped: not stored, it is simply the absence of a decision.

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------
create table public.canvas_course_links (
  id                 uuid        primary key default gen_random_uuid(),
  -- Owner. Defaults to the calling user so clients never send it; RLS enforces it.
  user_id            uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  -- Stable Canvas course id, as text: Canvas ids are integers that may exceed what JavaScript
  -- represents exactly, and the API is read in string-id mode. Never identified by name.
  canvas_course_id   text        not null,
  project_id         uuid,
  state              text        not null,
  -- Snapshot of the course as Canvas last described it (diagnostics, and courses that later
  -- disappear from the active list). Refreshed when the course is seen again; not an identity.
  canvas_course_name text,
  canvas_course_code text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint canvas_course_links_course_id_format check (canvas_course_id ~ '^[0-9]{1,20}$'),
  constraint canvas_course_links_state_valid      check (state in ('linked', 'ignored')),
  -- linked <=> a project; ignored <=> no project.
  constraint canvas_course_links_state_project    check (
    (state = 'linked' and project_id is not null) or (state = 'ignored' and project_id is null)
  ),
  constraint canvas_course_links_name_length check (canvas_course_name is null or char_length(btrim(canvas_course_name)) between 1 and 300),
  constraint canvas_course_links_code_length check (canvas_course_code is null or char_length(btrim(canvas_course_code)) between 1 and 120),
  -- One decision per Canvas course and user. Several courses may share a project (sections).
  constraint canvas_course_links_user_course_key unique (user_id, canvas_course_id),
  -- Same owner-matching key as tasks, events and inbox items. ON DELETE CASCADE: deleting a
  -- project removes its links, so those courses return to "unmapped". (SET NULL would break the
  -- linked => project invariant and make the project deletion fail.)
  constraint canvas_course_links_project_owner_fkey
    foreign key (project_id, user_id)
    references public.projects (id, user_id)
    on delete cascade
);

comment on table public.canvas_course_links is 'Canvas course -> TRAZA project decisions (linked / ignored). No row = unmapped. Owner-only via RLS.';
comment on column public.canvas_course_links.canvas_course_id is 'Canvas course id (string-id mode). The identity of the course; names are snapshots only.';

create trigger canvas_course_links_set_updated_at
  before update on public.canvas_course_links
  for each row
  execute function public.set_updated_at();

-- The unique (user_id, canvas_course_id) index serves RLS and per-user reads.
-- Foreign-key lookups when a project is deleted, and "is this project linked?".
create index canvas_course_links_project_id_idx on public.canvas_course_links (project_id);

-- ---------------------------------------------------------------------------
-- Row Level Security: owner-only access for signed-in users. anon gets nothing.
-- ---------------------------------------------------------------------------
alter table public.canvas_course_links enable row level security;

create policy "Users can read their own Canvas course links"
  on public.canvas_course_links for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can create their own Canvas course links"
  on public.canvas_course_links for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update their own Canvas course links"
  on public.canvas_course_links for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete their own Canvas course links"
  on public.canvas_course_links for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- Data API privileges: explicit and column-scoped (least privilege).
-- ---------------------------------------------------------------------------
-- id, user_id and timestamps are set by the database. canvas_course_id is written once on insert
-- and never changed (a different course is a different row). The app's Server Actions only write
-- course ids and metadata they have just read from Canvas on the server (see lib/canvas/actions.ts).
revoke all on table public.canvas_course_links from anon, authenticated;

grant select on table public.canvas_course_links to authenticated;
grant insert (canvas_course_id, project_id, state, canvas_course_name, canvas_course_code)
  on table public.canvas_course_links to authenticated;
grant update (project_id, state, canvas_course_name, canvas_course_code)
  on table public.canvas_course_links to authenticated;
grant delete on table public.canvas_course_links to authenticated;

grant select, insert, update, delete on table public.canvas_course_links to service_role;

-- ---------------------------------------------------------------------------
-- Atomic "create project from Canvas course"
-- ---------------------------------------------------------------------------
-- Creates a project and links the course to it in ONE transaction: either both rows exist or
-- neither does. SECURITY INVOKER: it runs with the caller's own privileges, so RLS, the
-- column-scoped grants and every check constraint apply exactly as for direct writes; it grants
-- no extra power. It writes the project's content columns only (source keeps its 'manual'
-- default; the Canvas origin is recorded by the link). An existing decision for the same course
-- (e.g. ignored) is replaced by the new link.
create function public.create_project_from_canvas_course(
  p_canvas_course_id   text,
  p_name               text,
  p_canvas_course_name text default null,
  p_canvas_course_code text default null,
  p_area               text default null,
  p_description        text default null,
  p_status             text default 'active'
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_project_id uuid;
begin
  if (select auth.uid()) is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  insert into public.projects (name, area, description, status)
  values (p_name, p_area, p_description, p_status)
  returning id into v_project_id;

  insert into public.canvas_course_links (canvas_course_id, project_id, state, canvas_course_name, canvas_course_code)
  values (p_canvas_course_id, v_project_id, 'linked', p_canvas_course_name, p_canvas_course_code)
  on conflict (user_id, canvas_course_id) do update
    set project_id         = excluded.project_id,
        state              = 'linked',
        canvas_course_name = excluded.canvas_course_name,
        canvas_course_code = excluded.canvas_course_code;

  return v_project_id;
end;
$$;

comment on function public.create_project_from_canvas_course(text, text, text, text, text, text, text)
  is 'Atomically creates a project and links a Canvas course to it, as the calling user (SECURITY INVOKER).';

revoke execute on function public.create_project_from_canvas_course(text, text, text, text, text, text, text) from public, anon;
grant execute on function public.create_project_from_canvas_course(text, text, text, text, text, text, text) to authenticated;
