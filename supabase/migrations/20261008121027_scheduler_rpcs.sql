-- Prompt 23 (revised): scheduler-only variants of the database functions the background engines use.
--
-- Interactive requests keep calling the ORIGINAL functions, pinned to auth.uid() (unchanged here).
-- The trusted scheduler (POST /api/internal/scheduler, server-only, SUPABASE_SECRET_KEY) cannot have
-- an auth.uid(): it calls these scheduler_* variants with the target user as p_user_id, chosen only
-- by its own server-side candidate queries — never by a browser or any public endpoint.
--
-- Each variant is the original function's latest body, VERBATIM, except that every
-- "(select auth.uid())" became "traza_private.scheduler_target(p_user_id)". So leases, cooldowns,
-- delivery dedupe, owner checks, input validation and idempotency are exactly the interactive ones;
-- tests/db/scheduler-rpcs.test.ts fails if a body ever drifts from its original.
--
-- Privileges: EXECUTE only for service_role (the secret key). Never anon or authenticated, so a
-- browser session cannot call them even with a forged p_user_id. No RLS policy changes; no table
-- grant changes (service_role already had them). No Auth sessions are involved anywhere.

create schema if not exists traza_private;
revoke all on schema traza_private from public;

-- The scheduler's target user: p_user_id if it is an existing TRAZA (auth) user, else null, which
-- each variant rejects exactly like a missing session ("Not authenticated").
create function traza_private.scheduler_target(p_user_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select u.id from auth.users u where u.id = p_user_id
$$;

revoke all on function traza_private.scheduler_target(uuid) from public, anon, authenticated, service_role;
-- claim_canvas_sync (latest definition: 20261007083209_canvas_sync_state.sql)
create function public.scheduler_claim_canvas_sync(
  p_user_id uuid,
  p_trigger       text,
  p_lease_seconds integer
)
returns table (claimed boolean, reason text, lease_token uuid, consecutive_failures integer)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_user_id uuid := traza_private.scheduler_target(p_user_id);
  v_state   public.canvas_sync_state%rowtype;
  v_token   uuid;
begin
  if v_user_id is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if p_trigger is null or p_trigger not in ('automatic', 'manual') then
    raise exception 'Invalid trigger' using errcode = '22023';
  end if;
  if p_lease_seconds is null or p_lease_seconds not between 30 and 900 then
    raise exception 'Invalid lease' using errcode = '22023';
  end if;

  insert into public.canvas_sync_state (user_id) values (v_user_id) on conflict (user_id) do nothing;

  select s.* into v_state from public.canvas_sync_state s where s.user_id = v_user_id for update;

  if v_state.lease_until is not null and v_state.lease_until > now() then
    return query select false, 'already_running'::text, null::uuid, v_state.consecutive_failures;
    return;
  end if;

  if p_trigger = 'automatic' and v_state.next_eligible_at is not null and v_state.next_eligible_at > now() then
    return query select false, 'not_due'::text, null::uuid, v_state.consecutive_failures;
    return;
  end if;

  v_token := gen_random_uuid();
  update public.canvas_sync_state s
     set lease_token     = v_token,
         lease_until     = now() + make_interval(secs => p_lease_seconds),
         last_trigger    = p_trigger,
         last_attempt_at = now()
   where s.user_id = v_user_id;

  return query select true, 'claimed'::text, v_token, v_state.consecutive_failures;
end;
$$;

revoke all on function public.scheduler_claim_canvas_sync from public, anon, authenticated;
grant execute on function public.scheduler_claim_canvas_sync to service_role;
comment on function public.scheduler_claim_canvas_sync
  is 'Trusted scheduler only (service_role): public.claim_canvas_sync for the user p_user_id. Same body; only the user comes from the parameter instead of auth.uid().';

-- finish_canvas_sync (latest definition: 20261007083209_canvas_sync_state.sql)
create function public.scheduler_finish_canvas_sync(
  p_user_id uuid,
  p_lease_token           uuid,
  p_result                text,
  p_next_eligible_seconds integer,
  p_error_code            text    default null,
  p_courses               integer default 0,
  p_imported              integer default 0,
  p_updated               integer default 0,
  p_unchanged             integer default 0,
  p_ignored               integer default 0,
  p_skipped               integer default 0,
  p_review                integer default 0
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := traza_private.scheduler_target(p_user_id);
  v_success boolean;
begin
  if v_user_id is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if p_lease_token is null then
    raise exception 'Invalid lease' using errcode = '22023';
  end if;
  if p_result is null or p_result not in ('success', 'no_linked_courses', 'temporary_error', 'auth_error') then
    raise exception 'Invalid result' using errcode = '22023';
  end if;
  if p_next_eligible_seconds is null or p_next_eligible_seconds not between 60 and 86400 then
    raise exception 'Invalid next eligible delay' using errcode = '22023';
  end if;
  -- The error code and the counts are validated by the table's check constraints.

  v_success := p_result in ('success', 'no_linked_courses');

  update public.canvas_sync_state s
     set lease_token          = null,
         lease_until          = null,
         last_finished_at     = now(),
         last_result          = p_result,
         last_error_code      = case when v_success then null else p_error_code end,
         last_success_at      = case when v_success then now() else s.last_success_at end,
         consecutive_failures = case when v_success then 0 else least(s.consecutive_failures + 1, 1000) end,
         next_eligible_at     = now() + make_interval(secs => p_next_eligible_seconds),
         last_courses_count   = coalesce(p_courses, 0),
         last_imported_count  = coalesce(p_imported, 0),
         last_updated_count   = coalesce(p_updated, 0),
         last_unchanged_count = coalesce(p_unchanged, 0),
         last_ignored_count   = coalesce(p_ignored, 0),
         last_skipped_count   = coalesce(p_skipped, 0),
         last_review_count    = coalesce(p_review, 0)
   where s.user_id = v_user_id
     and s.lease_token = p_lease_token;

  return found;
end;
$$;

revoke all on function public.scheduler_finish_canvas_sync from public, anon, authenticated;
grant execute on function public.scheduler_finish_canvas_sync to service_role;
comment on function public.scheduler_finish_canvas_sync
  is 'Trusted scheduler only (service_role): public.finish_canvas_sync for the user p_user_id. Same body; only the user comes from the parameter instead of auth.uid().';

-- sync_canvas_course_tasks (latest definition: 20261006082922_canvas_assignment_preferences.sql)
create function public.scheduler_sync_canvas_course_tasks(
  p_user_id uuid,
  p_canvas_course_id text,
  p_assignments      jsonb
)
returns table (assignment_id text, outcome text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id    uuid := traza_private.scheduler_target(p_user_id);
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

revoke all on function public.scheduler_sync_canvas_course_tasks from public, anon, authenticated;
grant execute on function public.scheduler_sync_canvas_course_tasks to service_role;
comment on function public.scheduler_sync_canvas_course_tasks
  is 'Trusted scheduler only (service_role): public.sync_canvas_course_tasks for the user p_user_id. Same body; only the user comes from the parameter instead of auth.uid().';

-- get_google_calendar_credentials (latest definition: 20261006095932_google_calendar_connections.sql)
create function public.scheduler_get_google_calendar_credentials(p_user_id uuid)
returns table (refresh_token_ciphertext text, access_token_ciphertext text, access_token_expires_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if traza_private.scheduler_target(p_user_id) is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  return query
    select c.refresh_token_ciphertext, c.access_token_ciphertext, c.access_token_expires_at
      from public.google_calendar_connections c
     where c.user_id = traza_private.scheduler_target(p_user_id)
       and c.status = 'connected';
end;
$$;

revoke all on function public.scheduler_get_google_calendar_credentials from public, anon, authenticated;
grant execute on function public.scheduler_get_google_calendar_credentials to service_role;
comment on function public.scheduler_get_google_calendar_credentials
  is 'Trusted scheduler only (service_role): public.get_google_calendar_credentials for the user p_user_id. Same body; only the user comes from the parameter instead of auth.uid().';

-- claim_google_calendar_sync (latest definition: 20261007103558_google_calendar_sync_state.sql)
create function public.scheduler_claim_google_calendar_sync(
  p_user_id uuid,
  p_trigger       text,
  p_lease_seconds integer
)
returns table (claimed boolean, reason text, lease_token uuid, consecutive_failures integer)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_user_id      uuid := traza_private.scheduler_target(p_user_id);
  v_state        public.google_calendar_sync_state%rowtype;
  v_connected_at timestamptz;
  v_token        uuid;
begin
  if v_user_id is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if p_trigger is null or p_trigger not in ('automatic', 'manual') then
    raise exception 'Invalid trigger' using errcode = '22023';
  end if;
  if p_lease_seconds is null or p_lease_seconds not between 30 and 900 then
    raise exception 'Invalid lease' using errcode = '22023';
  end if;

  insert into public.google_calendar_sync_state (user_id) values (v_user_id) on conflict (user_id) do nothing;

  select s.* into v_state from public.google_calendar_sync_state s where s.user_id = v_user_id for update;

  if v_state.lease_until is not null and v_state.lease_until > now() then
    return query select false, 'already_running'::text, null::uuid, v_state.consecutive_failures;
    return;
  end if;

  if p_trigger = 'automatic' and v_state.next_eligible_at is not null and v_state.next_eligible_at > now() then
    select c.connected_at into v_connected_at from public.google_calendar_connections c where c.user_id = v_user_id;
    if v_connected_at is null or v_state.last_finished_at is null or v_connected_at <= v_state.last_finished_at then
      return query select false, 'not_due'::text, null::uuid, v_state.consecutive_failures;
      return;
    end if;
  end if;

  v_token := gen_random_uuid();
  update public.google_calendar_sync_state s
     set lease_token     = v_token,
         lease_until     = now() + make_interval(secs => p_lease_seconds),
         last_trigger    = p_trigger,
         last_attempt_at = now()
   where s.user_id = v_user_id;

  return query select true, 'claimed'::text, v_token, v_state.consecutive_failures;
end;
$$;

revoke all on function public.scheduler_claim_google_calendar_sync from public, anon, authenticated;
grant execute on function public.scheduler_claim_google_calendar_sync to service_role;
comment on function public.scheduler_claim_google_calendar_sync
  is 'Trusted scheduler only (service_role): public.claim_google_calendar_sync for the user p_user_id. Same body; only the user comes from the parameter instead of auth.uid().';

-- finish_google_calendar_sync (latest definition: 20261007103558_google_calendar_sync_state.sql)
create function public.scheduler_finish_google_calendar_sync(
  p_user_id uuid,
  p_lease_token           uuid,
  p_result                text,
  p_next_eligible_seconds integer,
  p_created               integer default 0,
  p_updated               integer default 0,
  p_imported              integer default 0,
  p_deleted               integer default 0,
  p_unchanged             integer default 0,
  p_failed                integer default 0
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := traza_private.scheduler_target(p_user_id);
  v_success boolean;
begin
  if v_user_id is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if p_lease_token is null then
    raise exception 'Invalid lease' using errcode = '22023';
  end if;
  if p_next_eligible_seconds is null or p_next_eligible_seconds not between 60 and 86400 then
    raise exception 'Invalid next eligible delay' using errcode = '22023';
  end if;
  -- The result and the counts are validated by the table's check constraints.

  v_success := p_result = 'success';

  update public.google_calendar_sync_state s
     set lease_token          = null,
         lease_until          = null,
         last_finished_at     = now(),
         last_result          = p_result,
         last_success_at      = case when v_success then now() else s.last_success_at end,
         consecutive_failures = case when v_success then 0 else least(s.consecutive_failures + 1, 1000) end,
         next_eligible_at     = now() + make_interval(secs => p_next_eligible_seconds),
         last_created_count   = coalesce(p_created, 0),
         last_updated_count   = coalesce(p_updated, 0),
         last_imported_count  = coalesce(p_imported, 0),
         last_deleted_count   = coalesce(p_deleted, 0),
         last_unchanged_count = coalesce(p_unchanged, 0),
         last_failed_count    = coalesce(p_failed, 0)
   where s.user_id = v_user_id
     and s.lease_token = p_lease_token;

  return found;
end;
$$;

revoke all on function public.scheduler_finish_google_calendar_sync from public, anon, authenticated;
grant execute on function public.scheduler_finish_google_calendar_sync to service_role;
comment on function public.scheduler_finish_google_calendar_sync
  is 'Trusted scheduler only (service_role): public.finish_google_calendar_sync for the user p_user_id. Same body; only the user comes from the parameter instead of auth.uid().';

-- sync_google_calendar_events (latest definition: 20261006122922_google_calendar_sync.sql)
create function public.scheduler_sync_google_calendar_events(
  p_user_id uuid,
  p_calendar_id text,
  p_events      jsonb
)
returns table (event_id text, outcome text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id     uuid := traza_private.scheduler_target(p_user_id);
  v_item        jsonb;
  v_event_id    text;
  v_date_text   text;
  v_date        date;
  v_all_day     boolean;
  v_start       time;
  v_end         time;
  v_description text;
  v_location    text;
  v_inserted    boolean;
begin
  if v_user_id is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  if p_calendar_id is null or not exists (
    select 1
      from public.google_calendar_connections c
     where c.user_id = v_user_id
       and c.status = 'connected'
       and c.selected_calendar_id = p_calendar_id
  ) then
    raise exception 'Google calendar is not selected' using errcode = 'P0002';
  end if;

  if p_events is null or jsonb_typeof(p_events) <> 'array' or jsonb_array_length(p_events) > 1000 then
    raise exception 'Invalid events payload' using errcode = '22023';
  end if;

  for v_item in select e.value from jsonb_array_elements(p_events) as e (value) loop
    if jsonb_typeof(v_item) <> 'object' then
      raise exception 'Invalid event' using errcode = '22023';
    end if;

    v_event_id := v_item ->> 'event_id';
    if jsonb_typeof(v_item -> 'event_id') is distinct from 'string' or v_event_id !~ '^[A-Za-z0-9_-]+$' or char_length(v_event_id) > 1024 then
      raise exception 'Invalid event id' using errcode = '22023';
    end if;

    -- Length is enforced by calendar_events_title_length.
    if jsonb_typeof(v_item -> 'title') is distinct from 'string' then
      raise exception 'Invalid event title' using errcode = '22023';
    end if;

    if coalesce(jsonb_typeof(v_item -> 'description'), 'null') not in ('string', 'null')
       or coalesce(jsonb_typeof(v_item -> 'location'), 'null') not in ('string', 'null') then
      raise exception 'Invalid event text' using errcode = '22023';
    end if;
    v_description := nullif(btrim(v_item ->> 'description'), '');
    v_location    := nullif(btrim(v_item ->> 'location'), '');

    v_date_text := v_item ->> 'event_date';
    if jsonb_typeof(v_item -> 'event_date') is distinct from 'string' or v_date_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      raise exception 'Invalid event date' using errcode = '22023';
    end if;
    v_date := v_date_text::date; -- an impossible date raises here
    if v_date < date '2000-01-01' or v_date > date '2100-12-31' then
      raise exception 'Invalid event date' using errcode = '22023';
    end if;

    if jsonb_typeof(v_item -> 'all_day') is distinct from 'boolean' then
      raise exception 'Invalid all-day flag' using errcode = '22023';
    end if;
    v_all_day := (v_item -> 'all_day') = 'true'::jsonb;

    if coalesce(jsonb_typeof(v_item -> 'start_time'), 'null') not in ('string', 'null')
       or coalesce(jsonb_typeof(v_item -> 'end_time'), 'null') not in ('string', 'null')
       or coalesce(v_item ->> 'start_time', '00:00') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       or coalesce(v_item ->> 'end_time', '00:00') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
      raise exception 'Invalid event time' using errcode = '22023';
    end if;
    -- Consistency (all-day without times, end not before start) is calendar_events_times_consistent.
    v_start := (v_item ->> 'start_time')::time;
    v_end   := (v_item ->> 'end_time')::time;

    event_id := v_event_id;

    -- Defence in depth: one of the caller's own TRAZA mirrors is never imported as Google-origin.
    if exists (
      select 1
        from public.google_calendar_item_links l
       where l.user_id = v_user_id
         and l.google_calendar_id = p_calendar_id
         and l.google_event_id = v_event_id
    ) then
      outcome := 'mirror';
      return next;
      continue;
    end if;

    v_inserted := null;
    insert into public.calendar_events as t (user_id, project_id, title, description, event_date, start_time, end_time, all_day, location, source, external_id)
    values (
      v_user_id,
      null,
      btrim(v_item ->> 'title'),
      v_description,
      v_date,
      v_start,
      v_end,
      v_all_day,
      v_location,
      'google-calendar',
      'calendar:' || p_calendar_id || ':event:' || v_event_id
    )
    on conflict (user_id, source, external_id) where external_id is not null do update
      set title       = excluded.title,
          description = excluded.description,
          event_date  = excluded.event_date,
          start_time  = excluded.start_time,
          end_time    = excluded.end_time,
          all_day     = excluded.all_day,
          location    = excluded.location
      where t.user_id = v_user_id
        and t.source = 'google-calendar'
        and (
          t.title is distinct from excluded.title
          or t.description is distinct from excluded.description
          or t.event_date is distinct from excluded.event_date
          or t.start_time is distinct from excluded.start_time
          or t.end_time is distinct from excluded.end_time
          or t.all_day is distinct from excluded.all_day
          or t.location is distinct from excluded.location
        )
    -- xmax = 0 only for a freshly inserted row version; no row at all means nothing changed.
    returning (t.xmax = 0) into v_inserted;

    outcome := case when v_inserted is null then 'unchanged' when v_inserted then 'created' else 'updated' end;
    return next;
  end loop;
end;
$$;

revoke all on function public.scheduler_sync_google_calendar_events from public, anon, authenticated;
grant execute on function public.scheduler_sync_google_calendar_events to service_role;
comment on function public.scheduler_sync_google_calendar_events
  is 'Trusted scheduler only (service_role): public.sync_google_calendar_events for the user p_user_id. Same body; only the user comes from the parameter instead of auth.uid().';

-- claim_notification_delivery (latest definition: 20261008083736_notifications.sql)
create function public.scheduler_claim_notification_delivery(
  p_user_id uuid,
  p_kind          text,
  p_dedupe_key    text,
  p_scheduled_for timestamptz,
  p_event_id      uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := traza_private.scheduler_target(p_user_id);
  v_row     public.notification_deliveries%rowtype;
  v_id      uuid;
begin
  if v_user_id is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if p_scheduled_for is null then
    raise exception 'Invalid schedule' using errcode = '22023';
  end if;

  insert into public.notification_deliveries (user_id, kind, dedupe_key, scheduled_for, event_id)
  values (v_user_id, p_kind, p_dedupe_key, p_scheduled_for, p_event_id)
  on conflict (user_id, dedupe_key) do nothing
  returning id into v_id;
  if v_id is not null then
    return v_id;
  end if;

  select d.* into v_row
    from public.notification_deliveries d
   where d.user_id = v_user_id and d.dedupe_key = p_dedupe_key
   for update;

  if v_row.attempts < 3 and (
       (v_row.status = 'failed' and v_row.failure_code = 'temporary_error')
       or (v_row.status = 'pending' and v_row.updated_at < now() - interval '10 minutes')
     ) then
    update public.notification_deliveries d
       set status = 'pending', failure_code = null, attempts = d.attempts + 1
     where d.id = v_row.id;
    return v_row.id;
  end if;
  return null;
end;
$$;

revoke all on function public.scheduler_claim_notification_delivery from public, anon, authenticated;
grant execute on function public.scheduler_claim_notification_delivery to service_role;
comment on function public.scheduler_claim_notification_delivery
  is 'Trusted scheduler only (service_role): public.claim_notification_delivery for the user p_user_id. Same body; only the user comes from the parameter instead of auth.uid().';

-- finish_notification_delivery (latest definition: 20261008083736_notifications.sql)
create function public.scheduler_finish_notification_delivery(
  p_user_id uuid,
  p_id           uuid,
  p_status       text,
  p_failure_code text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := traza_private.scheduler_target(p_user_id);
begin
  if v_user_id is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if p_status is null or p_status not in ('sent', 'skipped', 'failed') then
    raise exception 'Invalid status' using errcode = '22023';
  end if;

  update public.notification_deliveries d
     set status       = p_status,
         failure_code = case when p_status = 'sent' then null else p_failure_code end,
         sent_at      = case when p_status = 'sent' then now() else d.sent_at end
   where d.id = p_id
     and d.user_id = v_user_id
     and d.status = 'pending';
  return found;
end;
$$;

revoke all on function public.scheduler_finish_notification_delivery from public, anon, authenticated;
grant execute on function public.scheduler_finish_notification_delivery to service_role;
comment on function public.scheduler_finish_notification_delivery
  is 'Trusted scheduler only (service_role): public.finish_notification_delivery for the user p_user_id. Same body; only the user comes from the parameter instead of auth.uid().';

