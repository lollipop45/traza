-- TRAZA · manual Google Calendar synchronisation
-- Schema only: no personal data is inserted, no token is stored here (tokens stay encrypted in
-- public.google_calendar_connections).
--
-- Ownership model (origin-based, never "last write wins"):
--   TRAZA-origin  calendar events not imported from Google, and tasks with a due date. TRAZA owns
--                 their content; Google receives a mirror that every sync rewrites. Each mirror is
--                 one row of public.google_calendar_item_links (below).
--   Google-origin events that exist independently in the selected Google calendar. Google owns
--                 their synced fields; TRAZA keeps a real public.calendar_events row with
--                 source = 'google-calendar' and external_id = 'calendar:<calendar id>:event:<event id>'.
--                 That (user_id, source, external_id) unique index is their identity, so they need
--                 no link row: a link always means "TRAZA-origin mirror" (the origin is derived).
--
--   1. same-owner keys on tasks and calendar_events (targets for the links' composite FKs)
--   2. public.google_calendar_item_links: TRAZA item -> Google event, with deletion tombstones
--   3. sync_google_calendar_events(): the only write path for Google-origin calendar events

-- ---------------------------------------------------------------------------
-- 1. (id, user_id) keys
-- ---------------------------------------------------------------------------
-- Same principle as projects_id_user_id_key: a composite foreign key to (id, user_id) makes the
-- database itself refuse a link from user A to user B's task or event (FK checks bypass RLS).
alter table public.tasks add constraint tasks_id_user_id_key unique (id, user_id);
alter table public.calendar_events add constraint calendar_events_id_user_id_key unique (id, user_id);

-- ---------------------------------------------------------------------------
-- 2. google_calendar_item_links
-- ---------------------------------------------------------------------------
-- One row per TRAZA item mirrored into one Google calendar. Written only by the Next.js server
-- during a manual sync, with the user's own session (RLS); never by the browser UI.
--
-- Deletion tombstones: deleting the TRAZA task or event (any path: the UI, "Ignorar en TRAZA", a
-- cascade) sets the link's foreign key to NULL instead of deleting the link. A link whose item is
-- gone is a durable "pending Google deletion": the next manual sync deletes that Google event and
-- then the link. So no TRAZA delete path needs to know about Google, and no mirror is orphaned
-- silently. A new link must always name its item (google_calendar_item_links_require_item).
create table public.google_calendar_item_links (
  id                 uuid        primary key default gen_random_uuid(),
  -- Owner. Defaults to the calling user so clients never send it; RLS enforces it.
  user_id            uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  -- The Google calendar holding the mirror (the selected one when it was created). Links to a
  -- calendar that is no longer selected are kept as they are and never matched against the new one.
  google_calendar_id text        not null,
  -- TRAZA chooses mirror ids itself (deterministic, base32hex), so a repeated or concurrent create
  -- of the same item collides at Google instead of producing a duplicate.
  google_event_id    text        not null,
  item_type          text        not null,
  task_id            uuid,
  calendar_event_id  uuid,
  -- sha256 of the event content TRAZA last wrote; tells whether an item outside the sync window
  -- changed since, without asking Google.
  content_hash       text        not null,
  last_synced_at     timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint google_calendar_item_links_type_valid check (item_type in ('task', 'calendar_event')),
  -- Exactly the foreign key of its type; the other one is always null. (Both null = tombstone.)
  constraint google_calendar_item_links_type_key check (
    (item_type = 'task' and calendar_event_id is null)
    or (item_type = 'calendar_event' and task_id is null)
  ),
  constraint google_calendar_item_links_calendar_id_length check (char_length(google_calendar_id) between 1 and 1024),
  -- (Postgres regex repetition counts stop at 255, hence the separate length bound.)
  constraint google_calendar_item_links_event_id_format check (google_event_id ~ '^[a-v0-9]{5,}$' and char_length(google_event_id) <= 1024),
  constraint google_calendar_item_links_hash_format check (content_hash ~ '^[0-9a-f]{64}$'),
  -- One mirror per item and calendar; one item per Google event and calendar.
  constraint google_calendar_item_links_event_key unique (user_id, google_calendar_id, google_event_id),
  constraint google_calendar_item_links_task_key unique (user_id, google_calendar_id, task_id),
  constraint google_calendar_item_links_calendar_event_key unique (user_id, google_calendar_id, calendar_event_id),
  -- Same owner as the item; on item deletion only the item column is cleared (tombstone).
  constraint google_calendar_item_links_task_owner_fkey
    foreign key (task_id, user_id)
    references public.tasks (id, user_id)
    on delete set null (task_id),
  constraint google_calendar_item_links_event_owner_fkey
    foreign key (calendar_event_id, user_id)
    references public.calendar_events (id, user_id)
    on delete set null (calendar_event_id)
);

comment on table public.google_calendar_item_links is 'TRAZA task/event -> Google event mirrors for the manual Google Calendar sync. A row whose item column is null is a tombstone: its Google event is deleted by the next sync. Owner-only via RLS.';
comment on column public.google_calendar_item_links.content_hash is 'sha256 (hex) of the Google event content TRAZA last wrote.';

create trigger google_calendar_item_links_set_updated_at
  before update on public.google_calendar_item_links
  for each row
  execute function public.set_updated_at();

-- Foreign-key lookups when a task or event is deleted (the unique keys lead with user_id).
create index google_calendar_item_links_task_id_idx on public.google_calendar_item_links (task_id);
create index google_calendar_item_links_calendar_event_id_idx on public.google_calendar_item_links (calendar_event_id);

-- A new link must name its item, and a Google-origin event is never mirrored back into Google.
-- SECURITY INVOKER: reads the event with the caller's own privileges (RLS).
create function public.google_calendar_item_links_require_item()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if (new.item_type = 'task' and new.task_id is null) or (new.item_type = 'calendar_event' and new.calendar_event_id is null) then
    raise exception 'A Google Calendar link needs its TRAZA item' using errcode = '23514';
  end if;
  if new.item_type = 'calendar_event' and exists (
    select 1 from public.calendar_events e where e.id = new.calendar_event_id and e.source = 'google-calendar'
  ) then
    raise exception 'Google-origin events are not mirrored' using errcode = '23514';
  end if;
  return new;
end;
$$;

comment on function public.google_calendar_item_links_require_item() is 'Trigger: a new Google Calendar link names its TRAZA item, which is never a Google-origin event.';
revoke execute on function public.google_calendar_item_links_require_item() from public, anon, authenticated;

create trigger google_calendar_item_links_require_item
  before insert on public.google_calendar_item_links
  for each row
  execute function public.google_calendar_item_links_require_item();

-- Row Level Security: owner-only access for signed-in users. anon gets nothing.
alter table public.google_calendar_item_links enable row level security;

create policy "Users can read their own Google Calendar links"
  on public.google_calendar_item_links for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can create their own Google Calendar links"
  on public.google_calendar_item_links for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update their own Google Calendar links"
  on public.google_calendar_item_links for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete their own Google Calendar links"
  on public.google_calendar_item_links for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- Data API privileges: explicit and column-scoped. Nothing here is secret (ids and a hash), so
-- SELECT is whole-row. The item columns are written once, on insert (an item never moves to
-- another link; the database clears them on deletion). id, user_id and timestamps are set by the
-- database. A user writing their own links directly can only confuse their own sync: the composite
-- foreign keys keep every link inside its owner's data.
revoke all on table public.google_calendar_item_links from anon, authenticated;

grant select on table public.google_calendar_item_links to authenticated;
grant insert (google_calendar_id, google_event_id, item_type, task_id, calendar_event_id, content_hash, last_synced_at)
  on table public.google_calendar_item_links to authenticated;
grant update (google_event_id, content_hash, last_synced_at)
  on table public.google_calendar_item_links to authenticated;
grant delete on table public.google_calendar_item_links to authenticated;

grant select, insert, update, delete on table public.google_calendar_item_links to service_role;

-- ---------------------------------------------------------------------------
-- 3. sync_google_calendar_events
-- ---------------------------------------------------------------------------
-- Creates or updates the caller's Google-origin calendar events (source = 'google-calendar').
-- `authenticated` has no column privilege on calendar_events.source/external_id (manual events can
-- never be relabelled), so this SECURITY DEFINER function is the only way such rows are written.
--
-- p_calendar_id  must be the caller's currently selected calendar of a connected Google account.
-- p_events       JSON array (max 1000) of objects:
--                  { "event_id":    "abc123_20261012T080000Z",   Google event id
--                    "title":       "Revisión",                  1–200 characters after trimming
--                    "description": "…" | null,                  plain text (the app strips HTML)
--                    "location":    "…" | null,
--                    "event_date":  "2026-10-12",                Atlantic/Canary calendar day
--                    "all_day":     true | false,
--                    "start_time":  "09:00" | null,             Atlantic/Canary wall clock
--                    "end_time":    "10:30" | null }
--                Any malformed element rejects the whole call (nothing is written).
-- Returns one row per element: (event_id, outcome) with outcome created / updated / unchanged /
-- mirror (the id is one of the caller's TRAZA mirrors in that calendar: never imported).
--
-- Field ownership: Google owns title, description, location, date, times and all-day; the user's
-- project_id is never written here (imports start without a project and keep the one chosen in
-- TRAZA). Nothing is ever deleted here.
--
-- Trust boundary: the Next.js server lists the selected calendar itself and only sends events
-- Google returned just now. The database cannot call Google, so it does not re-verify content. A
-- signed-in user calling this directly with invented events could only create or rewrite
-- Google-origin events in their own account: never another user's rows, never a manual, Canvas or
-- AI event, never a task, never a project. Pinned to auth.uid() exactly like
-- sync_canvas_course_tasks: user_id is never a parameter, external_id is built here, the conflict
-- target is (caller, 'google-calendar', external_id), and every check constraint still applies.
create function public.sync_google_calendar_events(
  p_calendar_id text,
  p_events      jsonb
)
returns table (event_id text, outcome text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id     uuid := (select auth.uid());
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

comment on function public.sync_google_calendar_events(text, jsonb)
  is 'Creates/updates the calling user''s Google-origin calendar events (source = google-calendar) from their selected Google calendar. Never deletes, never touches other sources, tasks or project_id.';

revoke execute on function public.sync_google_calendar_events(text, jsonb) from public, anon;
grant execute on function public.sync_google_calendar_events(text, jsonb) to authenticated;
