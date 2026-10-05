-- TRAZA · calendar_events
-- Persistent calendar events. Schema only: no personal data is inserted.
--
-- Task deadlines are NOT stored here: the calendar reads them from public.tasks.due_date, so a
-- deadline has a single source of truth (important for future Canvas assignments imported as tasks).

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------
-- Date/time semantics: an event is a local calendar entry in the app time zone (Atlantic/Canary).
-- `event_date` (date) + `start_time` / `end_time` (time without time zone) store the wall-clock
-- values exactly as entered, so no UTC conversion can move an event to another day or hour,
-- including across daylight-saving changes. Imports from timestamp-based sources (e.g. Google
-- Calendar) must convert to Atlantic/Canary wall time when they are written.
create table public.calendar_events (
  id          uuid        primary key default gen_random_uuid(),
  -- Owner. Defaults to the calling user so clients never send it; RLS enforces it.
  user_id     uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  -- Optional project; must belong to the same user (calendar_events_project_owner_fkey).
  project_id  uuid,
  title       text        not null,
  description text,
  event_date  date        not null,
  start_time  time,
  end_time    time,
  all_day     boolean     not null default false,
  location    text,
  source      text        not null default 'manual',
  -- Identifier in the originating system, for idempotent imports (source <> manual).
  external_id text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint calendar_events_title_length       check (char_length(btrim(title)) between 1 and 200),
  constraint calendar_events_description_length check (description is null or char_length(btrim(description)) between 1 and 2000),
  constraint calendar_events_location_length    check (location is null or char_length(btrim(location)) between 1 and 200),
  constraint calendar_events_source_valid       check (source in ('manual', 'canvas', 'google-calendar', 'ai')),
  constraint calendar_events_external_id_not_blank check (external_id is null or char_length(btrim(external_id)) > 0),
  -- All-day events have no times; timed events have a start and an optional end on the same day.
  constraint calendar_events_times_consistent check (
    (all_day and start_time is null and end_time is null)
    or (not all_day and start_time is not null and (end_time is null or end_time >= start_time))
  ),
  -- Same owner as the task -> project link: the referenced project must belong to this event's user.
  constraint calendar_events_project_owner_fkey
    foreign key (project_id, user_id)
    references public.projects (id, user_id)
    on delete set null (project_id)
);

comment on table public.calendar_events is 'Personal calendar events (local date + wall-clock times, Atlantic/Canary). Owner-only via RLS. Task deadlines live in public.tasks.';
comment on column public.calendar_events.start_time is 'Local wall-clock time (Atlantic/Canary); null for all-day events.';
comment on column public.calendar_events.external_id is 'ID in the source system (source <> manual); unique per user and source.';

create trigger calendar_events_set_updated_at
  before update on public.calendar_events
  for each row
  execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
-- Serves the RLS ownership filter, the user_id foreign key and "my events in a date range".
create index calendar_events_user_id_event_date_idx on public.calendar_events (user_id, event_date);

-- Foreign-key lookups when a project is deleted.
create index calendar_events_project_id_idx on public.calendar_events (project_id);

-- An external item can only be imported once per user and source (future Canvas / Google Calendar).
create unique index calendar_events_user_source_external_id_key
  on public.calendar_events (user_id, source, external_id)
  where external_id is not null;

-- ---------------------------------------------------------------------------
-- Row Level Security: owner-only access for signed-in users. anon gets nothing.
-- ---------------------------------------------------------------------------
alter table public.calendar_events enable row level security;

create policy "Users can read their own calendar events"
  on public.calendar_events for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can create their own calendar events"
  on public.calendar_events for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update their own calendar events"
  on public.calendar_events for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete their own calendar events"
  on public.calendar_events for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- Data API privileges: explicit and column-scoped (least privilege).
-- ---------------------------------------------------------------------------
-- Clients write event content only. id, user_id and the timestamps are always set by the
-- database. `source` and `external_id` are not client-writable either: manual events get
-- source = 'manual' from the default, and imports (Canvas, Google Calendar) will run server-side
-- with their own privileges, so a browser can never forge or corrupt import bookkeeping.
revoke all on table public.calendar_events from anon, authenticated;

grant select on table public.calendar_events to authenticated;
grant insert (project_id, title, description, event_date, start_time, end_time, all_day, location)
  on table public.calendar_events to authenticated;
grant update (project_id, title, description, event_date, start_time, end_time, all_day, location)
  on table public.calendar_events to authenticated;
grant delete on table public.calendar_events to authenticated;

grant select, insert, update, delete on table public.calendar_events to service_role;
