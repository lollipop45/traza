-- TRAZA · Canvas assignment -> task synchronisation (manual sync)
-- Canvas assignments become ordinary rows of public.tasks (source = 'canvas'). There is no second
-- "Canvas tasks" table: Home, Calendar, Inbox and Projects already read public.tasks.
-- Schema only: no personal data is inserted, and no Canvas token is ever stored in the database.
--
-- Why a function: 20261005160009_create_projects.sql deliberately revoked client writes to
-- tasks.source and tasks.external_id, so the normal task UI can never create or relabel a
-- "synced" task. That stays true. This function is the ONLY write path for Canvas-sourced tasks,
-- and it can only do one narrow thing: upsert Canvas tasks of the calling user, into the project
-- that the calling user linked to that Canvas course.
--
-- Trust boundary: the Next.js server reads the user's Canvas courses and assignments itself (with
-- the server-only token) and only calls this for courses Canvas returned just now. The database
-- cannot call Canvas, so it does not re-verify the content. A signed-in user who called this RPC
-- directly with invented assignments could only create or retitle Canvas-source tasks in their
-- own account, attached to their own linked project: the same power they already have over their
-- own data. It can never touch another user's rows, a manual task, or a project the caller does
-- not own.
--
-- Field ownership on an existing task:
--   Canvas-managed (rewritten on every sync): title, due_date, project_id (source and external_id
--   are the identity and never change).
--   User-managed (never overwritten): priority, description, and completion, except that a pending
--   task may become done when Canvas reports the assignment as submitted. Canvas never moves a done
--   task back to pending. A task Canvas stops returning is left untouched (never deleted here).

-- ---------------------------------------------------------------------------
-- sync_canvas_course_tasks
-- ---------------------------------------------------------------------------
-- p_canvas_course_id  Canvas course id (string-id mode). Must be linked (state = 'linked') by the
--                     caller in canvas_course_links; its project_id is the tasks' project.
-- p_assignments       JSON array (max 500) of objects:
--                       { "assignment_id": "123",            Canvas assignment id, digits only
--                         "title":         "Panel …",        1–500 characters after trimming
--                         "due_date":      "2026-10-12"|null calendar day in Atlantic/Canary
--                         "submitted":     true|false|null } Canvas proves submission
--                     Any malformed element rejects the whole call (nothing is written): the app
--                     validates before calling, so a bad payload is a bug or a forged request.
-- Returns one row per element: (assignment_id, outcome) with outcome created / updated / unchanged.
--
-- SECURITY DEFINER because `authenticated` has no column privilege on tasks.source/external_id.
-- It therefore bypasses RLS, so EVERY statement below is pinned to auth.uid() explicitly:
--   - user_id is never a parameter; it is always (select auth.uid()), and null is rejected;
--   - the project comes from the caller's own link row, never from the payload, and the
--     owner-matching foreign key tasks_project_owner_fkey still applies (FKs are not bypassed);
--   - the upsert target is (user_id, source, external_id) with user_id = caller and
--     source = 'canvas', so a conflict can only ever hit the caller's own Canvas task;
--   - external_id is built here from the course and assignment ids, never taken from the caller;
--   - every check constraint on public.tasks still applies.
-- search_path is empty, so every object is schema-qualified and cannot be shadowed.
create function public.sync_canvas_course_tasks(
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

  -- Only a course the caller has linked to one of their projects is a sync source. Ignored and
  -- unmapped courses (no row) are rejected.
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

    -- Length is enforced by tasks_title_not_blank.
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
      v_due_date := v_due_text::date; -- an impossible date (2026-02-30) raises here
      if v_due_date < date '2000-01-01' or v_due_date > date '2100-12-31' then
        raise exception 'Invalid due date' using errcode = '22023';
      end if;
    end if;

    if coalesce(jsonb_typeof(v_item -> 'submitted'), 'null') not in ('boolean', 'null') then
      raise exception 'Invalid submission flag' using errcode = '22023';
    end if;
    v_submitted := coalesce((v_item -> 'submitted') = 'true'::jsonb, false);

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
          -- pending -> done only on proven submission; done is never reverted; priority untouched.
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
    -- xmax = 0 only for a freshly inserted row version; no row at all means nothing changed.
    returning (t.xmax = 0) into v_inserted;

    assignment_id := v_assignment;
    outcome := case when v_inserted is null then 'unchanged' when v_inserted then 'created' else 'updated' end;
    return next;
  end loop;
end;
$$;

comment on function public.sync_canvas_course_tasks(text, jsonb)
  is 'Upserts Canvas assignment tasks (source = canvas) of the calling user into the project linked to that Canvas course. The only write path for Canvas tasks.';

-- New functions are executable by PUBLIC by default: only signed-in users may call this one.
revoke execute on function public.sync_canvas_course_tasks(text, jsonb) from public, anon;
grant execute on function public.sync_canvas_course_tasks(text, jsonb) to authenticated;
