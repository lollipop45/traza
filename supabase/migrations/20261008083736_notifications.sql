-- TRAZA · notifications (Web Push)
-- Three owner-only tables:
--   push_subscriptions        one row per device/browser that enabled notifications (Web Push
--                             endpoint + its public encryption keys). Several devices per user.
--   notification_preferences  one row per user: which reminders, how early, and whether lock-screen
--                             notifications may show titles.
--   notification_deliveries   durable bookkeeping of planned reminders, unique per (user, dedupe key),
--                             so repeated planner runs (now while the app is open, later from the
--                             trusted scheduler) never send the same reminder twice.
-- Writes go through narrow functions pinned to auth.uid(); clients never send a user id. No secrets
-- are stored: the VAPID private key lives only in the server environment. Subscription endpoints
-- and keys are sensitive application data (never logged, never shown).

-- ---------------------------------------------------------------------------
-- push_subscriptions
-- ---------------------------------------------------------------------------

create table public.push_subscriptions (
  id              uuid        primary key default gen_random_uuid(),
  user_id         uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  -- The push service URL (https, issued by the browser vendor). Unique per user: a browser that
  -- subscribes again updates its row instead of adding a duplicate.
  endpoint        text        not null,
  -- PushSubscription keys (base64url): the device's P-256 public key and its auth secret.
  p256dh          text        not null,
  auth            text        not null,
  expiration_time timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),

  constraint push_subscriptions_endpoint_format check (char_length(endpoint) between 20 and 2048 and endpoint ~ '^https://[^[:space:]]+$'),
  constraint push_subscriptions_p256dh_format   check (char_length(p256dh) between 80 and 100 and p256dh ~ '^[A-Za-z0-9_-]+=*$'),
  constraint push_subscriptions_auth_format     check (char_length(auth) between 16 and 44 and auth ~ '^[A-Za-z0-9_-]+=*$'),
  constraint push_subscriptions_user_endpoint_key unique (user_id, endpoint)
);

comment on table public.push_subscriptions is 'Web Push subscriptions, one per device/browser of a user. Owner-only; written by save_push_subscription.';

create trigger push_subscriptions_set_updated_at
  before update on public.push_subscriptions
  for each row
  execute function public.set_updated_at();

alter table public.push_subscriptions enable row level security;

create policy "Users can read their own push subscriptions"
  on public.push_subscriptions for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- Removing one device (or an expired subscription) is a plain owner-only delete.
create policy "Users can delete their own push subscriptions"
  on public.push_subscriptions for delete
  to authenticated
  using ((select auth.uid()) = user_id);

revoke all on table public.push_subscriptions from anon, authenticated;
grant select, delete on table public.push_subscriptions to authenticated;
grant select, insert, update, delete on table public.push_subscriptions to service_role;

-- save_push_subscription: add this device, or refresh it if the same endpoint subscribed before.
-- SECURITY DEFINER (clients cannot insert/update the table directly), pinned to auth.uid(), empty
-- search_path. The table's checks validate every value. Returns the subscription id.
create function public.save_push_subscription(
  p_endpoint        text,
  p_p256dh          text,
  p_auth            text,
  p_expiration_time timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_id      uuid;
begin
  if v_user_id is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  insert into public.push_subscriptions as s (user_id, endpoint, p256dh, auth, expiration_time)
  values (v_user_id, p_endpoint, p_p256dh, p_auth, p_expiration_time)
  on conflict (user_id, endpoint) do update
    set p256dh          = p_p256dh,
        auth            = p_auth,
        expiration_time = p_expiration_time,
        last_seen_at    = now()
  returning s.id into v_id;

  return v_id;
end;
$$;

comment on function public.save_push_subscription(text, text, text, timestamptz)
  is 'Adds or refreshes a Web Push subscription of the calling user (unique per user and endpoint).';

revoke execute on function public.save_push_subscription(text, text, text, timestamptz) from public, anon;
grant execute on function public.save_push_subscription(text, text, text, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- notification_preferences
-- ---------------------------------------------------------------------------

create table public.notification_preferences (
  user_id            uuid        primary key default auth.uid() references auth.users (id) on delete cascade,
  -- Master switch for every device of the user (devices keep their subscriptions).
  push_enabled       boolean     not null default true,
  -- The evening before (20:00 Atlantic/Canary): tasks due tomorrow.
  tomorrow_tasks     boolean     not null default true,
  -- In the morning (08:00 Atlantic/Canary): tasks due today and overdue.
  morning_summary    boolean     not null default false,
  -- Before timed calendar events (never for tasks, which have no time).
  event_reminders    boolean     not null default true,
  event_lead_minutes integer     not null default 60,
  -- Lock-screen privacy: false = counts only ("Tienes 2 tareas para mañana."), true = titles too.
  show_details       boolean     not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint notification_preferences_lead_valid check (event_lead_minutes in (10, 15, 30, 60, 120))
);

comment on table public.notification_preferences is 'Per-user notification preferences (no row = defaults). Owner-only; written by save_notification_preferences.';

create trigger notification_preferences_set_updated_at
  before update on public.notification_preferences
  for each row
  execute function public.set_updated_at();

alter table public.notification_preferences enable row level security;

create policy "Users can read their own notification preferences"
  on public.notification_preferences for select
  to authenticated
  using ((select auth.uid()) = user_id);

revoke all on table public.notification_preferences from anon, authenticated;
grant select on table public.notification_preferences to authenticated;
grant select, insert, update, delete on table public.notification_preferences to service_role;

create function public.save_notification_preferences(
  p_push_enabled       boolean,
  p_tomorrow_tasks     boolean,
  p_morning_summary    boolean,
  p_event_reminders    boolean,
  p_event_lead_minutes integer,
  p_show_details       boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
begin
  if v_user_id is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if p_push_enabled is null or p_tomorrow_tasks is null or p_morning_summary is null or p_event_reminders is null or p_show_details is null then
    raise exception 'Invalid preferences' using errcode = '22023';
  end if;

  -- Parameters (not EXCLUDED) in the update: nothing depends on column-level SELECT privileges.
  insert into public.notification_preferences (user_id, push_enabled, tomorrow_tasks, morning_summary, event_reminders, event_lead_minutes, show_details)
  values (v_user_id, p_push_enabled, p_tomorrow_tasks, p_morning_summary, p_event_reminders, p_event_lead_minutes, p_show_details)
  on conflict (user_id) do update
    set push_enabled       = p_push_enabled,
        tomorrow_tasks     = p_tomorrow_tasks,
        morning_summary    = p_morning_summary,
        event_reminders    = p_event_reminders,
        event_lead_minutes = p_event_lead_minutes,
        show_details       = p_show_details;
end;
$$;

comment on function public.save_notification_preferences(boolean, boolean, boolean, boolean, integer, boolean)
  is 'Saves the calling user''s notification preferences (lead time validated by the table check).';

revoke execute on function public.save_notification_preferences(boolean, boolean, boolean, boolean, integer, boolean) from public, anon;
grant execute on function public.save_notification_preferences(boolean, boolean, boolean, boolean, integer, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- notification_deliveries
-- ---------------------------------------------------------------------------

create table public.notification_deliveries (
  id            uuid        primary key default gen_random_uuid(),
  user_id       uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  kind          text        not null,
  -- Stable identity of one reminder, never a title: "tomorrow_tasks:2026-10-08",
  -- "morning_summary:2026-10-08", "event:<event id>:60m:<start instant>".
  dedupe_key    text        not null,
  scheduled_for timestamptz not null,
  -- The event a reminder is about (owner-safe: the composite key cannot point at another user's
  -- event). Kept as a tombstone (null) if the event is deleted.
  event_id      uuid,
  status        text        not null default 'pending',
  failure_code  text,
  attempts      integer     not null default 1,
  sent_at       timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint notification_deliveries_kind_valid    check (kind in ('tomorrow_tasks', 'morning_summary', 'event_reminder')),
  constraint notification_deliveries_key_format    check (char_length(dedupe_key) between 3 and 200 and dedupe_key ~ '^[a-z_]+:[A-Za-z0-9:_.+-]+$'),
  constraint notification_deliveries_status_valid  check (status in ('pending', 'sent', 'skipped', 'failed')),
  constraint notification_deliveries_failure_valid check (
    failure_code is null or failure_code in (
      'no_subscriptions', 'expired_subscription', 'push_rejected', 'temporary_error', 'permission_gone', 'not_configured', 'unexpected'
    )
  ),
  constraint notification_deliveries_event_kind    check (event_id is null or kind = 'event_reminder'),
  constraint notification_deliveries_attempts      check (attempts between 1 and 20),
  constraint notification_deliveries_user_key      unique (user_id, dedupe_key),
  constraint notification_deliveries_event_owner_fkey
    foreign key (event_id, user_id) references public.calendar_events (id, user_id) on delete set null (event_id)
);

comment on table public.notification_deliveries is 'Durable dedupe of planned notifications (one row per user and reminder key). Owner read-only; written by claim/finish_notification_delivery.';

create trigger notification_deliveries_set_updated_at
  before update on public.notification_deliveries
  for each row
  execute function public.set_updated_at();

create index notification_deliveries_event_idx on public.notification_deliveries (event_id) where event_id is not null;

alter table public.notification_deliveries enable row level security;

create policy "Users can read their own notification deliveries"
  on public.notification_deliveries for select
  to authenticated
  using ((select auth.uid()) = user_id);

revoke all on table public.notification_deliveries from anon, authenticated;
grant select on table public.notification_deliveries to authenticated;
grant select, insert, update, delete on table public.notification_deliveries to service_role;

-- claim_notification_delivery: reserve one reminder before sending it. Returns the delivery id when
-- the caller may send it now, or null when it was already sent, skipped, is being sent, or failed
-- for good. Re-claimable: a temporary failure (up to 3 attempts) and a pending row older than 10
-- minutes (a crashed sender). The row is locked, so two concurrent runs never both send.
create function public.claim_notification_delivery(
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
  v_user_id uuid := (select auth.uid());
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

comment on function public.claim_notification_delivery(text, text, timestamptz, uuid)
  is 'Reserves one notification of the calling user by its dedupe key; null when it must not be sent (again).';

revoke execute on function public.claim_notification_delivery(text, text, timestamptz, uuid) from public, anon;
grant execute on function public.claim_notification_delivery(text, text, timestamptz, uuid) to authenticated;

-- finish_notification_delivery: record how a claimed (pending) delivery ended.
create function public.finish_notification_delivery(
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
  v_user_id uuid := (select auth.uid());
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

comment on function public.finish_notification_delivery(uuid, text, text)
  is 'Records the outcome (sent / skipped / failed + safe code) of the calling user''s pending notification delivery.';

revoke execute on function public.finish_notification_delivery(uuid, text, text) from public, anon;
grant execute on function public.finish_notification_delivery(uuid, text, text) to authenticated;
