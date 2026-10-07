-- TRAZA · canvas_sync_state
-- Per-user state of the Canvas assignment sync: when it last ran, how it ended, when an automatic
-- run is next allowed, and a short LEASE so that only one sync per user runs at a time (several
-- tabs, route changes, a manual "Sincronizar Campus" during an automatic run, or several server
-- instances). The database is the only concurrency authority: there is no in-memory mutex.
--
-- Automatic sync in this phase is OPPORTUNISTIC: it runs only inside a request made by the signed-in
-- user while they use TRAZA. Nothing here lets a job act for an offline user: no tokens, cookies or
-- service-role credentials are stored, and both functions act only on auth.uid().
--
-- Stored: timestamps, a fixed-vocabulary result and error code, and counts. NEVER stored: Canvas
-- tokens, raw Canvas errors or response bodies, assignment or course contents, stack traces.
--
-- Policy values (lease length, cooldown, failure backoff) live in the app (lib/canvas/sync-policy.ts)
-- and are passed in; the functions only enforce safe bounds on them.

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------

create table public.canvas_sync_state (
  -- One row per user, created on the first claim.
  user_id              uuid        primary key default auth.uid() references auth.users (id) on delete cascade,

  -- The lease: set by claim_canvas_sync, cleared by finish_canvas_sync, and simply ignored once
  -- lease_until has passed (a crashed request never blocks sync for longer than the lease).
  lease_token          uuid,
  lease_until          timestamptz,

  last_trigger         text,
  last_attempt_at      timestamptz,
  last_finished_at     timestamptz,
  last_success_at      timestamptz,
  -- An automatic run is not started before this instant (manual runs ignore it). Null = due now.
  next_eligible_at     timestamptz,

  last_result          text,
  -- Only a small safe code, never a message.
  last_error_code      text,
  consecutive_failures integer     not null default 0,

  -- Counts of the last finished run.
  last_courses_count   integer     not null default 0,
  last_imported_count  integer     not null default 0,
  last_updated_count   integer     not null default 0,
  last_unchanged_count integer     not null default 0,
  last_ignored_count   integer     not null default 0,
  last_skipped_count   integer     not null default 0,
  last_review_count    integer     not null default 0,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint canvas_sync_state_lease_pair      check ((lease_token is null) = (lease_until is null)),
  constraint canvas_sync_state_trigger_valid   check (last_trigger is null or last_trigger in ('automatic', 'manual')),
  constraint canvas_sync_state_result_valid    check (
    last_result is null or last_result in ('success', 'no_linked_courses', 'temporary_error', 'auth_error')
  ),
  constraint canvas_sync_state_error_valid     check (
    last_error_code is null or last_error_code in (
      'network', 'timeout', 'canvas_401', 'canvas_403', 'canvas_429', 'canvas_5xx',
      'canvas_redirect', 'not_configured', 'database', 'unexpected'
    )
  ),
  constraint canvas_sync_state_failures_range  check (consecutive_failures between 0 and 1000),
  constraint canvas_sync_state_counts_range    check (
    least(last_courses_count, last_imported_count, last_updated_count, last_unchanged_count,
          last_ignored_count, last_skipped_count, last_review_count) >= 0
    and greatest(last_courses_count, last_imported_count, last_updated_count, last_unchanged_count,
                 last_ignored_count, last_skipped_count, last_review_count) <= 100000
  )
);

comment on table public.canvas_sync_state is
  'Per-user Canvas sync state: lease (one run at a time), cooldown for automatic runs, last result and counts. No tokens, raw errors or Canvas contents. Owner read-only; written only by claim_canvas_sync / finish_canvas_sync.';

create trigger canvas_sync_state_set_updated_at
  before update on public.canvas_sync_state
  for each row
  execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security: the owner can read their own row. Nobody writes it directly.
-- ---------------------------------------------------------------------------

alter table public.canvas_sync_state enable row level security;

create policy "Users can read their own Canvas sync state"
  on public.canvas_sync_state for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- Column-scoped read (the lease token is not readable; it is only returned to the claimer).
-- No insert / update / delete for clients: the two functions below are the only write path, so
-- the lease and cooldown cannot be forged through the Data API.
revoke all on table public.canvas_sync_state from anon, authenticated;
grant select (
  user_id, lease_until, last_trigger, last_attempt_at, last_finished_at, last_success_at, next_eligible_at,
  last_result, last_error_code, consecutive_failures,
  last_courses_count, last_imported_count, last_updated_count, last_unchanged_count,
  last_ignored_count, last_skipped_count, last_review_count, created_at, updated_at
) on table public.canvas_sync_state to authenticated;
grant select, insert, update, delete on table public.canvas_sync_state to service_role;

-- ---------------------------------------------------------------------------
-- claim_canvas_sync: atomically take the caller's sync lease
-- ---------------------------------------------------------------------------
-- The caller's row is locked (FOR UPDATE), so two concurrent claims are serialised: exactly one
-- gets the lease, the other sees it and returns 'already_running'. Outcomes:
--   claimed          the caller holds the lease (token returned) and may call Canvas
--   already_running  an unexpired lease exists: do nothing
--   not_due          automatic trigger inside the cooldown / failure backoff: do nothing
-- Manual runs ('manual') skip the cooldown but never an active lease.
-- SECURITY DEFINER because clients have no write privilege on the table; it acts only on
-- auth.uid() (no user parameter) with an empty search_path.

create function public.claim_canvas_sync(
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
  v_user_id uuid := (select auth.uid());
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

comment on function public.claim_canvas_sync(text, integer)
  is 'Takes the calling user''s Canvas sync lease if free (and, for automatic runs, if the cooldown has passed). Returns claimed / already_running / not_due.';

revoke execute on function public.claim_canvas_sync(text, integer) from public, anon;
grant execute on function public.claim_canvas_sync(text, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- finish_canvas_sync: record the result and release the lease
-- ---------------------------------------------------------------------------
-- Only the holder of the current lease token can finish (a request whose lease expired and was
-- taken over by another one changes nothing and gets false). Success resets the failure count;
-- a failure increments it. next_eligible_at = now() + p_next_eligible_seconds (the app's cooldown
-- or backoff, bounded here to 1 minute .. 24 hours).

create function public.finish_canvas_sync(
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
  v_user_id uuid := (select auth.uid());
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

comment on function public.finish_canvas_sync(uuid, text, integer, text, integer, integer, integer, integer, integer, integer, integer)
  is 'Records the result of the calling user''s Canvas sync and releases their lease, if they still hold it.';

revoke execute on function public.finish_canvas_sync(uuid, text, integer, text, integer, integer, integer, integer, integer, integer, integer) from public, anon;
grant execute on function public.finish_canvas_sync(uuid, text, integer, text, integer, integer, integer, integer, integer, integer, integer) to authenticated;
