-- TRAZA · assistant (conversation history + confirmation-based proposed actions)
-- Schema only: no personal data is inserted, no AI provider key or token is stored here.
--
-- The language model NEVER writes to the database. It returns text and structured proposals; the
-- Next.js server validates them and stores them here as `proposed`. Only when the user confirms a
-- proposal does TRAZA create the task / event / note, through execute_assistant_action(), with
-- source = 'ai'. Nothing else in this file can create domain records.
--
--   1. public.assistant_conversations
--   2. public.assistant_messages      (user-visible text only; never model reasoning)
--   3. public.assistant_actions       (one row per proposal; its id is the idempotency key)
--   4. add_assistant_reply()          (assistant message + its proposals, atomically; INVOKER)
--   5. execute_assistant_action()     (confirmation: validate, create with source = 'ai', mark executed; DEFINER)
--   6. dismiss_assistant_action()     (proposed → dismissed; DEFINER)

-- (id, user_id) key on inbox_items, for the owner-safe result link below (tasks and calendar_events
-- got theirs in 20261006122922).
alter table public.inbox_items add constraint inbox_items_id_user_id_key unique (id, user_id);

-- ---------------------------------------------------------------------------
-- 1. assistant_conversations
-- ---------------------------------------------------------------------------
create table public.assistant_conversations (
  id         uuid        primary key default gen_random_uuid(),
  -- Owner. Defaults to the calling user so clients never send it; RLS enforces it.
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  -- Short label taken from the first message (display only).
  title      text,
  created_at timestamptz not null default now(),
  -- Bumped whenever a message is added (assistant_messages_touch_conversation).
  updated_at timestamptz not null default now(),

  constraint assistant_conversations_title_length check (title is null or char_length(btrim(title)) between 1 and 120),
  constraint assistant_conversations_id_user_id_key unique (id, user_id)
);

comment on table public.assistant_conversations is 'TRAZA assistant conversations. Owner-only via RLS.';

create trigger assistant_conversations_set_updated_at
  before update on public.assistant_conversations
  for each row
  execute function public.set_updated_at();

-- "My latest conversation".
create index assistant_conversations_user_id_updated_at_idx on public.assistant_conversations (user_id, updated_at desc);

-- ---------------------------------------------------------------------------
-- 2. assistant_messages
-- ---------------------------------------------------------------------------
-- Only what the user sees: their own text and the assistant's visible answer. No hidden model
-- reasoning, no prompts, no provider internals are ever stored.
create table public.assistant_messages (
  id              uuid        primary key default gen_random_uuid(),
  user_id         uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  conversation_id uuid        not null,
  role            text        not null,
  content         text        not null,
  created_at      timestamptz not null default now(),

  constraint assistant_messages_role_valid check (role in ('user', 'assistant')),
  constraint assistant_messages_content_length check (char_length(btrim(content)) between 1 and 8000),
  constraint assistant_messages_id_user_id_key unique (id, user_id),
  -- Same owner as the conversation: user A can never write into user B's conversation.
  constraint assistant_messages_conversation_owner_fkey
    foreign key (conversation_id, user_id)
    references public.assistant_conversations (id, user_id)
    on delete cascade
);

comment on table public.assistant_messages is 'User-visible assistant conversation messages (no model reasoning). Owner-only via RLS.';

create index assistant_messages_conversation_id_created_at_idx on public.assistant_messages (conversation_id, created_at);
create index assistant_messages_user_id_idx on public.assistant_messages (user_id);

-- Keeps the conversation's updated_at current. SECURITY DEFINER only to touch that one timestamp
-- (clients have no UPDATE privilege on it); limited to the new message's own conversation and owner.
create function public.assistant_messages_touch_conversation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.assistant_conversations c
     set updated_at = now()
   where c.id = new.conversation_id
     and c.user_id = new.user_id;
  return new;
end;
$$;

comment on function public.assistant_messages_touch_conversation() is 'Trigger: bumps the conversation''s updated_at when a message is added.';
revoke execute on function public.assistant_messages_touch_conversation() from public, anon, authenticated;

create trigger assistant_messages_touch_conversation
  after insert on public.assistant_messages
  for each row
  execute function public.assistant_messages_touch_conversation();

-- ---------------------------------------------------------------------------
-- 3. assistant_actions
-- ---------------------------------------------------------------------------
-- One proposal = one row. Its database-generated id is the ONLY authority for confirming it (never
-- an id from the model). `payload` holds the fields the server validated, named like the target
-- table's columns; project references are already resolved to the caller's own project ids.
--   proposed  shown with "Confirmar" / "Descartar"; nothing exists yet
--   executed  the record was created (result_* points at it); confirming again creates nothing
--   dismissed the user discarded it; it can no longer be executed
create table public.assistant_actions (
  id                   uuid        primary key default gen_random_uuid(),
  user_id              uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  message_id           uuid        not null,
  position             smallint    not null,
  action_type          text        not null,
  payload              jsonb       not null,
  state                text        not null default 'proposed',
  -- The record created on confirmation. If the user later deletes it, only the link is cleared:
  -- the proposal stays executed and is never executed again.
  result_task_id       uuid,
  result_event_id      uuid,
  result_inbox_item_id uuid,
  executed_at          timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint assistant_actions_type_valid check (action_type in ('create_task', 'create_event', 'create_note', 'create_idea')),
  constraint assistant_actions_state_valid check (state in ('proposed', 'executed', 'dismissed')),
  constraint assistant_actions_position_range check (position between 1 and 20),
  constraint assistant_actions_payload_object check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 16384),
  -- executed ⇔ executed_at; a result only on an executed action.
  constraint assistant_actions_executed_consistent check (
    (state = 'executed') = (executed_at is not null)
    and (state = 'executed' or (result_task_id is null and result_event_id is null and result_inbox_item_id is null))
  ),
  -- Includes user_id so another user's insert can never collide with (and so probe) these rows:
  -- it fails on the owner-matching foreign key instead.
  constraint assistant_actions_message_position_key unique (user_id, message_id, position),
  constraint assistant_actions_message_owner_fkey
    foreign key (message_id, user_id)
    references public.assistant_messages (id, user_id)
    on delete cascade,
  constraint assistant_actions_result_task_owner_fkey
    foreign key (result_task_id, user_id)
    references public.tasks (id, user_id)
    on delete set null (result_task_id),
  constraint assistant_actions_result_event_owner_fkey
    foreign key (result_event_id, user_id)
    references public.calendar_events (id, user_id)
    on delete set null (result_event_id),
  constraint assistant_actions_result_inbox_owner_fkey
    foreign key (result_inbox_item_id, user_id)
    references public.inbox_items (id, user_id)
    on delete set null (result_inbox_item_id)
);

comment on table public.assistant_actions is 'Assistant proposals (proposed / executed / dismissed). Executed only through execute_assistant_action(). Owner-only via RLS.';

create trigger assistant_actions_set_updated_at
  before update on public.assistant_actions
  for each row
  execute function public.set_updated_at();

create index assistant_actions_user_id_idx on public.assistant_actions (user_id);
create index assistant_actions_result_task_id_idx on public.assistant_actions (result_task_id);
create index assistant_actions_result_event_id_idx on public.assistant_actions (result_event_id);
create index assistant_actions_result_inbox_item_id_idx on public.assistant_actions (result_inbox_item_id);

-- ---------------------------------------------------------------------------
-- Row Level Security (owner-only; anon gets nothing) and column-scoped privileges
-- ---------------------------------------------------------------------------
alter table public.assistant_conversations enable row level security;
alter table public.assistant_messages enable row level security;
alter table public.assistant_actions enable row level security;

create policy "Users can read their own assistant conversations" on public.assistant_conversations for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users can create their own assistant conversations" on public.assistant_conversations for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Users can update their own assistant conversations" on public.assistant_conversations for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Users can delete their own assistant conversations" on public.assistant_conversations for delete to authenticated using ((select auth.uid()) = user_id);

create policy "Users can read their own assistant messages" on public.assistant_messages for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users can create their own assistant messages" on public.assistant_messages for insert to authenticated with check ((select auth.uid()) = user_id);

create policy "Users can read their own assistant actions" on public.assistant_actions for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users can create their own assistant actions" on public.assistant_actions for insert to authenticated with check ((select auth.uid()) = user_id);

-- Messages are append-only for clients (deleting the conversation removes them). Proposals are
-- inserted as `proposed` (state and results are not client-writable) and change state ONLY through
-- execute_assistant_action() / dismiss_assistant_action(). id, user_id and timestamps are set by
-- the database. A user writing these rows directly can only affect their own assistant history.
revoke all on table public.assistant_conversations from anon, authenticated;
revoke all on table public.assistant_messages from anon, authenticated;
revoke all on table public.assistant_actions from anon, authenticated;

grant select on table public.assistant_conversations to authenticated;
grant insert (title) on table public.assistant_conversations to authenticated;
grant update (title) on table public.assistant_conversations to authenticated;
grant delete on table public.assistant_conversations to authenticated;

grant select on table public.assistant_messages to authenticated;
grant insert (conversation_id, role, content) on table public.assistant_messages to authenticated;

grant select on table public.assistant_actions to authenticated;
grant insert (message_id, position, action_type, payload) on table public.assistant_actions to authenticated;

grant select, insert, update, delete on table public.assistant_conversations to service_role;
grant select, insert, update, delete on table public.assistant_messages to service_role;
grant select, insert, update, delete on table public.assistant_actions to service_role;

-- ---------------------------------------------------------------------------
-- 4. add_assistant_reply: the assistant's visible answer and its proposals, in one transaction
-- ---------------------------------------------------------------------------
-- SECURITY INVOKER: runs with the caller's own privileges (RLS, grants, owner-safe FKs and every
-- check apply exactly as for direct inserts). It grants no extra power; it only makes the message
-- and its proposals all-or-nothing. p_actions: JSON array (max 10) of
--   { "action_type": "create_task" | "create_event" | "create_note" | "create_idea", "payload": { … } }
create function public.add_assistant_reply(
  p_conversation_id uuid,
  p_content         text,
  p_actions         jsonb default '[]'::jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_message_id uuid;
  v_item       jsonb;
  v_position   integer;
begin
  if (select auth.uid()) is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if p_actions is null or jsonb_typeof(p_actions) <> 'array' or jsonb_array_length(p_actions) > 10 then
    raise exception 'Invalid actions payload' using errcode = '22023';
  end if;

  insert into public.assistant_messages (conversation_id, role, content)
  values (p_conversation_id, 'assistant', btrim(p_content))
  returning id into v_message_id;

  for v_item, v_position in select e.value, e.ordinality from jsonb_array_elements(p_actions) with ordinality as e (value, ordinality) loop
    if jsonb_typeof(v_item) <> 'object' or jsonb_typeof(v_item -> 'action_type') is distinct from 'string' then
      raise exception 'Invalid action' using errcode = '22023';
    end if;
    insert into public.assistant_actions (message_id, position, action_type, payload)
    values (v_message_id, v_position, v_item ->> 'action_type', coalesce(v_item -> 'payload', 'null'::jsonb));
  end loop;

  return v_message_id;
end;
$$;

comment on function public.add_assistant_reply(uuid, text, jsonb) is 'Stores an assistant reply and its proposals (state proposed) atomically, as the calling user (SECURITY INVOKER).';
revoke execute on function public.add_assistant_reply(uuid, text, jsonb) from public, anon;
grant execute on function public.add_assistant_reply(uuid, text, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Payload readers for execute_assistant_action (internal: not callable through the Data API)
-- ---------------------------------------------------------------------------
-- Optional trimmed text; null/absent/blank → null; anything but a string is rejected.
create function public.assistant_payload_text(p_payload jsonb, p_key text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
begin
  if coalesce(jsonb_typeof(p_payload -> p_key), 'null') not in ('string', 'null') then
    raise exception 'Invalid % in proposal', p_key using errcode = '22023';
  end if;
  return nullif(btrim(p_payload ->> p_key), '');
end;
$$;

-- Optional calendar date "YYYY-MM-DD" within 2000–2100; impossible dates are rejected.
create function public.assistant_payload_date(p_payload jsonb, p_key text)
returns date
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_text text := public.assistant_payload_text(p_payload, p_key);
  v_date date;
begin
  if v_text is null then
    return null;
  end if;
  if v_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    raise exception 'Invalid % in proposal', p_key using errcode = '22023';
  end if;
  v_date := v_text::date; -- 2026-02-30 raises here
  if v_date < date '2000-01-01' or v_date > date '2100-12-31' then
    raise exception 'Invalid % in proposal', p_key using errcode = '22023';
  end if;
  return v_date;
end;
$$;

-- Optional 24h "HH:MM".
create function public.assistant_payload_time(p_payload jsonb, p_key text)
returns time
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_text text := public.assistant_payload_text(p_payload, p_key);
begin
  if v_text is null then
    return null;
  end if;
  if v_text !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
    raise exception 'Invalid % in proposal', p_key using errcode = '22023';
  end if;
  return v_text::time;
end;
$$;

revoke execute on function public.assistant_payload_text(jsonb, text) from public, anon, authenticated;
revoke execute on function public.assistant_payload_date(jsonb, text) from public, anon, authenticated;
revoke execute on function public.assistant_payload_time(jsonb, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. execute_assistant_action: the confirmation path
-- ---------------------------------------------------------------------------
-- Called only when the user presses "Confirmar" (the server has re-validated the proposal first).
-- SECURITY DEFINER because `authenticated` cannot write source = 'ai' on tasks / calendar_events /
-- inbox_items (column-scoped grants stay exactly as they are). Pinned to auth.uid():
--   - the proposal is read by its database id AND the caller's user id, and locked (FOR UPDATE), so
--     a double click, a refresh or two tabs can never create the record twice;
--   - executed → returns the existing result ("already-executed"), creating nothing;
--     dismissed → refused;
--   - the record is created with user_id = caller and source = 'ai'; the project in the payload must
--     be the caller's own (the owner-matching composite foreign keys reject anything else, and they
--     apply to SECURITY DEFINER code too); every check constraint of the target table applies;
--   - the payload is re-validated here (types, real dates, times); one invalid field rejects the
--     whole confirmation and the proposal stays `proposed`.
-- The model never reaches this function: it only ever produced the payload the server validated.
create function public.execute_assistant_action(p_action_id uuid)
returns table (outcome text, item_type text, item_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_action  public.assistant_actions%rowtype;
  v_payload jsonb;
  v_project uuid;
  v_title   text;
  v_all_day boolean;
  v_id      uuid;
begin
  if v_user_id is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select a.* into v_action
    from public.assistant_actions a
   where a.id = p_action_id
     and a.user_id = v_user_id
   for update;

  if not found then
    raise exception 'Assistant action not found' using errcode = 'P0002';
  end if;

  if v_action.state = 'executed' then
    outcome   := 'already-executed';
    item_type := case when v_action.action_type = 'create_task' then 'task' when v_action.action_type = 'create_event' then 'event' else 'inbox_item' end;
    item_id   := coalesce(v_action.result_task_id, v_action.result_event_id, v_action.result_inbox_item_id);
    return next;
    return;
  end if;
  if v_action.state <> 'proposed' then
    raise exception 'Assistant action was dismissed' using errcode = '55000';
  end if;

  v_payload := v_action.payload;
  if coalesce(jsonb_typeof(v_payload -> 'project_id'), 'null') not in ('string', 'null') then
    raise exception 'Invalid project in proposal' using errcode = '22023';
  end if;
  v_project := (v_payload ->> 'project_id')::uuid; -- not a uuid → raises
  v_title := public.assistant_payload_text(v_payload, 'title');

  if v_action.action_type = 'create_task' then
    insert into public.tasks (user_id, project_id, title, description, due_date, priority, status, source)
    values (
      v_user_id,
      v_project,
      v_title,
      public.assistant_payload_text(v_payload, 'description'),
      public.assistant_payload_date(v_payload, 'due_date'),
      coalesce(public.assistant_payload_text(v_payload, 'priority'), 'normal'),
      'pending',
      'ai'
    )
    returning id into v_id;
    update public.assistant_actions set state = 'executed', executed_at = now(), result_task_id = v_id where id = v_action.id;
    item_type := 'task';

  elsif v_action.action_type = 'create_event' then
    if jsonb_typeof(v_payload -> 'all_day') is distinct from 'boolean' then
      raise exception 'Invalid all_day in proposal' using errcode = '22023';
    end if;
    v_all_day := (v_payload -> 'all_day') = 'true'::jsonb;
    insert into public.calendar_events (user_id, project_id, title, description, event_date, start_time, end_time, all_day, location, source)
    values (
      v_user_id,
      v_project,
      v_title,
      public.assistant_payload_text(v_payload, 'description'),
      public.assistant_payload_date(v_payload, 'event_date'),
      public.assistant_payload_time(v_payload, 'start_time'),
      public.assistant_payload_time(v_payload, 'end_time'),
      v_all_day,
      public.assistant_payload_text(v_payload, 'location'),
      'ai'
    )
    returning id into v_id;
    update public.assistant_actions set state = 'executed', executed_at = now(), result_event_id = v_id where id = v_action.id;
    item_type := 'event';

  elsif v_action.action_type in ('create_note', 'create_idea') then
    -- The kind comes from the action type, never from the payload.
    insert into public.inbox_items (user_id, kind, title, content, project_id, source)
    values (
      v_user_id,
      case when v_action.action_type = 'create_note' then 'note' else 'idea' end,
      v_title,
      public.assistant_payload_text(v_payload, 'content'),
      v_project,
      'ai'
    )
    returning id into v_id;
    update public.assistant_actions set state = 'executed', executed_at = now(), result_inbox_item_id = v_id where id = v_action.id;
    item_type := 'inbox_item';

  else
    raise exception 'Unsupported assistant action' using errcode = '22023';
  end if;

  outcome := 'executed';
  item_id := v_id;
  return next;
end;
$$;

comment on function public.execute_assistant_action(uuid)
  is 'Confirms one of the caller''s proposed assistant actions: creates the task/event/note with source = ai and marks it executed, idempotently. The only write path for AI-created records.';

revoke execute on function public.execute_assistant_action(uuid) from public, anon;
grant execute on function public.execute_assistant_action(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. dismiss_assistant_action: proposed → dismissed (executed proposals stay executed)
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER because clients have no UPDATE privilege on assistant_actions.state. Pinned to
-- auth.uid(); can only move the caller's own proposal from proposed to dismissed. Returns the
-- proposal's state afterwards.
create function public.dismiss_assistant_action(p_action_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_state   text;
begin
  if v_user_id is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  update public.assistant_actions a
     set state = 'dismissed'
   where a.id = p_action_id
     and a.user_id = v_user_id
     and a.state = 'proposed'
  returning a.state into v_state;

  if v_state is null then
    select a.state into v_state from public.assistant_actions a where a.id = p_action_id and a.user_id = v_user_id;
    if v_state is null then
      raise exception 'Assistant action not found' using errcode = 'P0002';
    end if;
  end if;
  return v_state;
end;
$$;

comment on function public.dismiss_assistant_action(uuid) is 'Discards one of the caller''s proposed assistant actions. Executed proposals are not changed.';
revoke execute on function public.dismiss_assistant_action(uuid) from public, anon;
grant execute on function public.dismiss_assistant_action(uuid) to authenticated;
