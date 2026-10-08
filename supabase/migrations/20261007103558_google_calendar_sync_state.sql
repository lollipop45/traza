-- TRAZA · google_calendar_sync_state
-- Per-user state of the Google Calendar sync: when it last ran, how it ended, when an automatic run
-- is next allowed, and a short LEASE so that only one Google sync per user runs at a time (several
-- tabs, route changes, a manual "Sincronizar Google Calendar" during an automatic run, or several
-- server instances). The database is the only concurrency authority: there is no in-memory mutex.
--
-- Automatic sync in this phase is OPPORTUNISTIC: it runs only inside a request made by the signed-in
-- user while they use TRAZA. Nothing here lets a job act for an offline user: no tokens, cookies or
-- service-role credentials are stored here, and both functions act only on auth.uid().
--
-- Stored: timestamps, a fixed-vocabulary result, and counts. NEVER stored: Google tokens, raw
-- Google errors or response bodies, event contents, e-mail addresses, calendar ids, stack traces.
--
-- Policy values (lease length, cooldown, backoff) live in the app
-- (lib/google-calendar/sync-policy.ts) and are passed in; the functions only bound them. Same
-- design as public.canvas_sync_state (20261007083209).

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------

create table public.google_calendar_sync_state (
  user_id              uuid        primary key default auth.uid() references auth.users (id) on delete cascade,

  -- The lease: set by claim_google_calendar_sync, cleared by finish_google_calendar_sync, ignored
  -- once lease_until has passed (a crashed request never blocks sync for longer than the lease).
  lease_token          uuid,
  lease_until          timestamptz,

  last_trigger         text,
  last_attempt_at      timestamptz,
  last_finished_at     timestamptz,
  last_success_at      timestamptz,
  -- An automatic run is not started before this instant (manual runs ignore it; so does a
  -- reconnection made after the last run). Null = due now.
  next_eligible_at     timestamptz,

  last_result          text,
  consecutive_failures integer     not null default 0,

  -- Counts of the last finished run.
  last_created_count   integer     not null default 0,
  last_updated_count   integer     not null default 0,
  last_imported_count  integer     not null default 0,
  last_deleted_count   integer     not null default 0,
  last_unchanged_count integer     not null default 0,
  last_failed_count    integer     not null default 0,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint google_calendar_sync_state_lease_pair     check ((lease_token is null) = (lease_until is null)),
  constraint google_calendar_sync_state_trigger_valid  check (last_trigger is null or last_trigger in ('automatic', 'manual')),
  constraint google_calendar_sync_state_result_valid   check (
    last_result is null or last_result in (
      'success', 'not_connected', 'no_calendar', 'reconnect_required', 'rate_limited', 'temporary_error', 'unexpected'
    )
  ),
  constraint google_calendar_sync_state_failures_range check (consecutive_failures between 0 and 1000),
  constraint google_calendar_sync_state_counts_range   check (
    least(last_created_count, last_updated_count, last_imported_count, last_deleted_count, last_unchanged_count, last_failed_count) >= 0
    and greatest(last_created_count, last_updated_count, last_imported_count, last_deleted_count, last_unchanged_count, last_failed_count) <= 100000
  )
);

comment on table public.google_calendar_sync_state is
  'Per-user Google Calendar sync state: lease (one run at a time), cooldown for automatic runs, last result and counts. No tokens, raw errors or event contents. Owner read-only; written only by claim_google_calendar_sync / finish_google_calendar_sync.';

create trigger google_calendar_sync_state_set_updated_at
  before update on public.google_calendar_sync_state
  for each row
  execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security: the owner can read their own row. Nobody writes it directly.
-- ---------------------------------------------------------------------------

alter table public.google_calendar_sync_state enable row level security;

create policy "Users can read their own Google Calendar sync state"
  on public.google_calendar_sync_state for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- Column-scoped read (the lease token is not readable; it is only returned to the claimer).
-- No insert / update / delete for clients: the two functions below are the only write path.
revoke all on table public.google_calendar_sync_state from anon, authenticated;
grant select (
  user_id, lease_until, last_trigger, last_attempt_at, last_finished_at, last_success_at, next_eligible_at,
  last_result, consecutive_failures,
  last_created_count, last_updated_count, last_imported_count, last_deleted_count, last_unchanged_count, last_failed_count,
  created_at, updated_at
) on table public.google_calendar_sync_state to authenticated;
grant select, insert, update, delete on table public.google_calendar_sync_state to service_role;

-- ---------------------------------------------------------------------------
-- claim_google_calendar_sync: atomically take the caller's Google sync lease
-- ---------------------------------------------------------------------------
-- The caller's row is locked (FOR UPDATE): two concurrent claims are serialised, exactly one gets
-- the lease and the other sees it ('already_running'). Outcomes:
--   claimed          the caller holds the lease (token returned) and may call Google
--   already_running  an unexpired lease exists: do nothing
--   not_due          automatic trigger inside the cooldown / backoff: do nothing
-- Manual runs skip the cooldown, never an active lease. A connection (re)established after the last
-- finished run makes an automatic run due at once, so a long "reconnect" backoff never outlives
-- the reconnection. SECURITY DEFINER because clients cannot write the table; acts only on
-- auth.uid() (no user parameter) with an empty search_path. Reads no token column.

create function public.claim_google_calendar_sync(
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
  v_user_id      uuid := (select auth.uid());
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

comment on function public.claim_google_calendar_sync(text, integer)
  is 'Takes the calling user''s Google Calendar sync lease if free (and, for automatic runs, if the cooldown has passed or the connection was re-established). Returns claimed / already_running / not_due.';

revoke execute on function public.claim_google_calendar_sync(text, integer) from public, anon;
grant execute on function public.claim_google_calendar_sync(text, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- finish_google_calendar_sync: record the result and release the lease
-- ---------------------------------------------------------------------------
-- Only the holder of the current lease token can finish. Success resets the failure count; any
-- other result increments it. next_eligible_at = now() + p_next_eligible_seconds (the app's
-- cooldown or backoff, bounded here to 1 minute .. 24 hours).

create function public.finish_google_calendar_sync(
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
  v_user_id uuid := (select auth.uid());
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

comment on function public.finish_google_calendar_sync(uuid, text, integer, integer, integer, integer, integer, integer, integer)
  is 'Records the result of the calling user''s Google Calendar sync and releases their lease, if they still hold it.';

revoke execute on function public.finish_google_calendar_sync(uuid, text, integer, integer, integer, integer, integer, integer, integer) from public, anon;
grant execute on function public.finish_google_calendar_sync(uuid, text, integer, integer, integer, integer, integer, integer, integer) to authenticated;
