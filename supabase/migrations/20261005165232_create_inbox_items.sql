-- TRAZA · inbox_items
-- Persistent non-task captures: ideas and notes. Schema only: no personal data is inserted.
--
-- Tasks are NOT stored here. A task captured from the Inbox is a row of public.tasks; the Inbox
-- screen merges both tables for display, so every task has a single source of truth.

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------
create table public.inbox_items (
  id          uuid        primary key default gen_random_uuid(),
  -- Owner. Defaults to the calling user so clients never send it; RLS enforces it.
  user_id     uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  kind        text        not null,
  -- A short heading and/or a free-form body. Either may be missing, never both.
  title       text,
  content     text,
  -- Optional project; must belong to the same user (inbox_items_project_owner_fkey).
  project_id  uuid,
  source      text        not null default 'manual',
  -- Identifier in the originating system, for idempotent imports (source <> manual).
  external_id text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint inbox_items_kind_valid        check (kind in ('idea', 'note')),
  constraint inbox_items_title_length      check (title is null or char_length(btrim(title)) between 1 and 200),
  constraint inbox_items_content_length    check (content is null or char_length(btrim(content)) between 1 and 10000),
  -- Completely empty captures are impossible.
  constraint inbox_items_not_empty         check (title is not null or content is not null),
  constraint inbox_items_source_valid      check (source in ('manual', 'canvas', 'ai')),
  constraint inbox_items_external_id_not_blank check (external_id is null or char_length(btrim(external_id)) > 0),
  -- Same owner as tasks and calendar events: the referenced project must belong to this user.
  constraint inbox_items_project_owner_fkey
    foreign key (project_id, user_id)
    references public.projects (id, user_id)
    on delete set null (project_id)
);

comment on table public.inbox_items is 'Ideas and notes (non-task captures). Owner-only via RLS. Tasks live in public.tasks.';
comment on column public.inbox_items.external_id is 'ID in the source system (source <> manual); unique per user and source.';

create trigger inbox_items_set_updated_at
  before update on public.inbox_items
  for each row
  execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
-- Serves the RLS ownership filter, the user_id foreign key and "my captures, newest first".
create index inbox_items_user_id_created_at_idx on public.inbox_items (user_id, created_at desc);

-- Foreign-key lookups when a project is deleted.
create index inbox_items_project_id_idx on public.inbox_items (project_id);

-- An external item can only be imported once per user and source (future Canvas / AI imports).
create unique index inbox_items_user_source_external_id_key
  on public.inbox_items (user_id, source, external_id)
  where external_id is not null;

-- ---------------------------------------------------------------------------
-- Row Level Security: owner-only access for signed-in users. anon gets nothing.
-- ---------------------------------------------------------------------------
alter table public.inbox_items enable row level security;

create policy "Users can read their own inbox items"
  on public.inbox_items for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can create their own inbox items"
  on public.inbox_items for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update their own inbox items"
  on public.inbox_items for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete their own inbox items"
  on public.inbox_items for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- Data API privileges: explicit and column-scoped (least privilege).
-- ---------------------------------------------------------------------------
-- Clients write capture content only (kind, title, content, project). id, user_id and the
-- timestamps are set by the database; source and external_id are reserved for future server-side
-- imports, so manual captures always get source = 'manual' from the default.
revoke all on table public.inbox_items from anon, authenticated;

grant select on table public.inbox_items to authenticated;
grant insert (kind, title, content, project_id) on table public.inbox_items to authenticated;
grant update (kind, title, content, project_id) on table public.inbox_items to authenticated;
grant delete on table public.inbox_items to authenticated;

grant select, insert, update, delete on table public.inbox_items to service_role;
