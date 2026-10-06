-- TRAZA · canvas_assignment_preferences
-- Durable per-assignment decisions for the Canvas sync. A Canvas assignment is not automatically a
-- task: gradebook columns ("Notas finales") and attendance ("Roll Call Attendance") also come back
-- from the Assignments API. The app classifies each assignment; this table stores what the USER
-- decided about one:
--   ignored   never import it again; its Campus task (if any) is removed when ignoring
--   included  import it even though the classifier marked it "needs review"
--   (no row)  follow the automatic classification
-- Identity is the stable Canvas course id + assignment id, never a title. Schema only: no personal
-- data is inserted, and no Canvas token is ever stored in the database.

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------
create table public.canvas_assignment_preferences (
  id                     uuid        primary key default gen_random_uuid(),
  -- Owner. Defaults to the calling user so clients never send it; RLS enforces it.
  user_id                uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  -- Canvas ids as text (string-id mode), like canvas_course_links. No foreign key to the course
  -- link: the decision survives unlinking/relinking the course.
  canvas_course_id       text        not null,
  canvas_assignment_id   text        not null,
  state                  text        not null,
  -- Snapshot for display in "Ignoradas por ti" (taken from Canvas or the task). Not an identity.
  canvas_assignment_name text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint canvas_assignment_preferences_course_id_format     check (canvas_course_id ~ '^[0-9]{1,20}$'),
  constraint canvas_assignment_preferences_assignment_id_format check (canvas_assignment_id ~ '^[0-9]{1,20}$'),
  constraint canvas_assignment_preferences_state_valid          check (state in ('included', 'ignored')),
  constraint canvas_assignment_preferences_name_length          check (
    canvas_assignment_name is null or char_length(btrim(canvas_assignment_name)) between 1 and 500
  ),
  -- One decision per user, course and assignment. Also serves RLS and per-user reads.
  constraint canvas_assignment_preferences_user_assignment_key unique (user_id, canvas_course_id, canvas_assignment_id)
);

comment on table public.canvas_assignment_preferences is 'Per-user Canvas assignment decisions (ignored / included) for the manual sync. No row = automatic classification. Owner-only via RLS.';

create trigger canvas_assignment_preferences_set_updated_at
  before update on public.canvas_assignment_preferences
  for each row
  execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security: owner-only access for signed-in users. anon gets nothing.
-- ---------------------------------------------------------------------------
alter table public.canvas_assignment_preferences enable row level security;

create policy "Users can read their own Canvas assignment preferences"
  on public.canvas_assignment_preferences for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can create their own Canvas assignment preferences"
  on public.canvas_assignment_preferences for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update their own Canvas assignment preferences"
  on public.canvas_assignment_preferences for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete their own Canvas assignment preferences"
  on public.canvas_assignment_preferences for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- Data API privileges: explicit and column-scoped (least privilege).
-- ---------------------------------------------------------------------------
-- id, user_id and timestamps are set by the database; the Canvas ids are written once on insert.
-- A preference only changes how the caller's own sync treats one of their own assignments, so a
-- row written directly through the Data API cannot affect anyone else.
revoke all on table public.canvas_assignment_preferences from anon, authenticated;

grant select on table public.canvas_assignment_preferences to authenticated;
grant insert (canvas_course_id, canvas_assignment_id, state, canvas_assignment_name)
  on table public.canvas_assignment_preferences to authenticated;
grant update (state, canvas_assignment_name)
  on table public.canvas_assignment_preferences to authenticated;
grant delete on table public.canvas_assignment_preferences to authenticated;

grant select, insert, update, delete on table public.canvas_assignment_preferences to service_role;

-- ---------------------------------------------------------------------------
-- set_canvas_assignment_preference: record a decision (and, for "ignored", remove the task)
-- ---------------------------------------------------------------------------
-- One transaction: the decision is upserted and, when ignoring, the caller's matching Campus task
-- is deleted, so an ignored assignment never lingers as a task and never comes back.
-- SECURITY INVOKER: runs with the caller's own privileges, so RLS and the grants above (and the
-- owner-only delete policy on public.tasks) apply exactly as for direct writes. It can only delete
-- a task with source = 'canvas' whose external_id it builds itself from the two Canvas ids: never a
-- manual task, never an arbitrary task id, never another user's row.
-- Returns the number of tasks removed (0 or 1).
create function public.set_canvas_assignment_preference(
  p_canvas_course_id       text,
  p_canvas_assignment_id   text,
  p_state                  text,
  p_canvas_assignment_name text default null
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_removed integer := 0;
begin
  if (select auth.uid()) is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  -- Ids, state and name are validated by the table's check constraints.
  insert into public.canvas_assignment_preferences as p (canvas_course_id, canvas_assignment_id, state, canvas_assignment_name)
  values (p_canvas_course_id, p_canvas_assignment_id, p_state, nullif(btrim(p_canvas_assignment_name), ''))
  on conflict (user_id, canvas_course_id, canvas_assignment_id) do update
    set state                  = excluded.state,
        canvas_assignment_name = coalesce(excluded.canvas_assignment_name, p.canvas_assignment_name);

  if p_state = 'ignored' then
    delete from public.tasks t
     where t.user_id = (select auth.uid())
       and t.source = 'canvas'
       and t.external_id = 'course:' || p_canvas_course_id || ':assignment:' || p_canvas_assignment_id;
    get diagnostics v_removed = row_count;
  end if;

  return v_removed;
end;
$$;

comment on function public.set_canvas_assignment_preference(text, text, text, text)
  is 'Records a Canvas assignment decision (ignored / included) for the calling user; ignoring also removes their matching Campus task, atomically (SECURITY INVOKER).';

revoke execute on function public.set_canvas_assignment_preference(text, text, text, text) from public, anon;
grant execute on function public.set_canvas_assignment_preference(text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- sync_canvas_course_tasks: never recreate an ignored assignment
-- ---------------------------------------------------------------------------
-- Same function as 20261006070920_sync_canvas_course_tasks.sql (same signature, privileges kept by
-- CREATE OR REPLACE), plus one guarantee enforced in the database itself: an assignment the caller
-- ignored is never written, even if the app sent it (outcome 'ignored'). The app already filters
-- ignored assignments out; this is defence in depth.
create or replace function public.sync_canvas_course_tasks(
  p_canvas_course_id text,
  p_assignments      jsonb
)
returns table (assignment_id text, outcome text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id    uuid := (select auth.uid());
  v_project_id uuid;
  v_item       jsonb;
  v_assignment text;
  v_title      text;
  v_due_text   text;
  v_due_date   date;
  v_submitted  boolean;
  v_inserted   boolean;
begin
  if v_user_id is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  if p_canvas_course_id is null or p_canvas_course_id !~ '^[0-9]{1,20}$' then
    raise exception 'Invalid Canvas course id' using errcode = '22023';
  end if;

  if p_assignments is null or jsonb_typeof(p_assignments) <> 'array' or jsonb_array_length(p_assignments) > 500 then
    raise exception 'Invalid assignments payload' using errcode = '22023';
  end if;

  select l.project_id
    into v_project_id
    from public.canvas_course_links l
   where l.user_id = v_user_id
     and l.canvas_course_id = p_canvas_course_id
     and l.state = 'linked';

  if v_project_id is null then
    raise exception 'Canvas course is not linked' using errcode = 'P0002';
  end if;

  for v_item in select e.value from jsonb_array_elements(p_assignments) as e (value) loop
    if jsonb_typeof(v_item) <> 'object' then
      raise exception 'Invalid assignment' using errcode = '22023';
    end if;

    v_assignment := v_item ->> 'assignment_id';
    if jsonb_typeof(v_item -> 'assignment_id') is distinct from 'string' or v_assignment !~ '^[0-9]{1,20}$' then
      raise exception 'Invalid assignment id' using errcode = '22023';
    end if;

    if jsonb_typeof(v_item -> 'title') is distinct from 'string' then
      raise exception 'Invalid assignment title' using errcode = '22023';
    end if;
    v_title := btrim(v_item ->> 'title');

    if coalesce(jsonb_typeof(v_item -> 'due_date'), 'null') not in ('string', 'null') then
      raise exception 'Invalid due date' using errcode = '22023';
    end if;
    v_due_text := v_item ->> 'due_date';
    if v_due_text is null then
      v_due_date := null;
    elsif v_due_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      raise exception 'Invalid due date' using errcode = '22023';
    else
      v_due_date := v_due_text::date;
      if v_due_date < date '2000-01-01' or v_due_date > date '2100-12-31' then
        raise exception 'Invalid due date' using errcode = '22023';
      end if;
    end if;

    if coalesce(jsonb_typeof(v_item -> 'submitted'), 'null') not in ('boolean', 'null') then
      raise exception 'Invalid submission flag' using errcode = '22023';
    end if;
    v_submitted := coalesce((v_item -> 'submitted') = 'true'::jsonb, false);

    assignment_id := v_assignment;

    -- The caller ignored this assignment: never (re)create or touch its task.
    if exists (
      select 1
        from public.canvas_assignment_preferences pr
       where pr.user_id = v_user_id
         and pr.canvas_course_id = p_canvas_course_id
         and pr.canvas_assignment_id = v_assignment
         and pr.state = 'ignored'
    ) then
      outcome := 'ignored';
      return next;
      continue;
    end if;

    v_inserted := null;
    insert into public.tasks as t (user_id, project_id, title, due_date, priority, status, completed_at, source, external_id)
    values (
      v_user_id,
      v_project_id,
      v_title,
      v_due_date,
      'normal',
      case when v_submitted then 'done' else 'pending' end,
      case when v_submitted then now() end,
      'canvas',
      'course:' || p_canvas_course_id || ':assignment:' || v_assignment
    )
    on conflict (user_id, source, external_id) where external_id is not null do update
      set title        = excluded.title,
          due_date     = excluded.due_date,
          project_id   = excluded.project_id,
          status       = case when t.status = 'pending' and excluded.status = 'done' then 'done' else t.status end,
          completed_at = case when t.status = 'pending' and excluded.status = 'done' then excluded.completed_at else t.completed_at end
      where t.user_id = v_user_id
        and t.source = 'canvas'
        and (
          t.title is distinct from excluded.title
          or t.due_date is distinct from excluded.due_date
          or t.project_id is distinct from excluded.project_id
          or (t.status = 'pending' and excluded.status = 'done')
        )
    returning (t.xmax = 0) into v_inserted;

    outcome := case when v_inserted is null then 'unchanged' when v_inserted then 'created' else 'updated' end;
    return next;
  end loop;
end;
$$;

comment on function public.sync_canvas_course_tasks(text, jsonb)
  is 'Upserts Canvas assignment tasks (source = canvas) of the calling user into the project linked to that Canvas course, skipping assignments the user ignored. The only write path for Canvas tasks.';
