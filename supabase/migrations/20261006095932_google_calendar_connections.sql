-- TRAZA · google_calendar_connections
-- One Google Calendar connection per TRAZA user (an external integration of an already signed-in
-- user; NOT a login method). Schema only: no personal data is inserted. This phase stores the
-- connection and the chosen calendar; it makes no change to public.calendar_events.
--
-- Token storage
-- -------------
-- Google refresh/access tokens never reach this table in plain text. The Next.js server encrypts
-- them (AES-256-GCM) with a key that exists only in its server environment
-- (GOOGLE_TOKEN_ENCRYPTION_KEY, never NEXT_PUBLIC_), binding each ciphertext to its user and token
-- kind. The database only ever holds "v1.<keyId>.<iv>.<ciphertext>" strings, and the format check
-- below rejects anything else (a raw Google token cannot be stored by mistake).
--
-- The ciphertext columns are additionally NOT selectable through the Data API: `authenticated` has
-- column-scoped SELECT on the metadata only, so `select *` or a normal query can never return them.
-- The server reads its own user's ciphertexts through get_google_calendar_credentials() below.
-- Supabase Vault was considered and not used: decrypting a Vault secret requires the service role
-- (which TRAZA does not use) or a SECURITY DEFINER function that would hand the PLAINTEXT token to
-- anything holding the user's JWT, including injected browser code. With application-level
-- encryption, whatever the JWT can reach is useless without the server-only key.

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------
create table public.google_calendar_connections (
  id                       uuid        primary key default gen_random_uuid(),
  -- Owner. Defaults to the calling user so clients never send it; RLS enforces it. One per user.
  user_id                  uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  -- The connected Google account, for display ("Cuenta: …"): the id of its primary calendar, which
  -- Google sets to the account's address. Not a secret, not an identity for TRAZA.
  google_account_email     text,
  -- connected: tokens present. revoked: Google rejected the refresh token (or it was lost); the
  -- tokens are wiped and the user must reconnect. The chosen calendar is kept for reconnection.
  status                   text        not null default 'connected',
  -- Encrypted by the server (see above). Never selectable by clients.
  refresh_token_ciphertext text,
  access_token_ciphertext  text,
  access_token_expires_at  timestamptz,
  -- The writable Google calendar the user chose for future TRAZA sync (non-secret metadata).
  selected_calendar_id     text,
  selected_calendar_name   text,
  connected_at             timestamptz not null default now(),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  constraint google_calendar_connections_user_key unique (user_id),
  constraint google_calendar_connections_status_valid check (status in ('connected', 'revoked')),
  -- connected ⇔ a refresh token; revoked ⇒ no tokens at all.
  constraint google_calendar_connections_status_tokens check (
    (status = 'connected' and refresh_token_ciphertext is not null)
    or (status = 'revoked' and refresh_token_ciphertext is null and access_token_ciphertext is null and access_token_expires_at is null)
  ),
  constraint google_calendar_connections_refresh_format check (
    refresh_token_ciphertext is null
    or (refresh_token_ciphertext ~ '^v1\.[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,}$' and char_length(refresh_token_ciphertext) <= 8192)
  ),
  constraint google_calendar_connections_access_format check (
    access_token_ciphertext is null
    or (access_token_ciphertext ~ '^v1\.[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,}$' and char_length(access_token_ciphertext) <= 8192)
  ),
  -- An access token always comes with its expiry.
  constraint google_calendar_connections_access_expiry check ((access_token_ciphertext is null) = (access_token_expires_at is null)),
  constraint google_calendar_connections_email_length check (google_account_email is null or char_length(google_account_email) between 3 and 320),
  -- Both or neither: a chosen calendar always has its display name.
  constraint google_calendar_connections_calendar_pair check ((selected_calendar_id is null) = (selected_calendar_name is null)),
  constraint google_calendar_connections_calendar_id_length check (selected_calendar_id is null or char_length(selected_calendar_id) between 1 and 1024),
  constraint google_calendar_connections_calendar_name_length check (selected_calendar_name is null or char_length(btrim(selected_calendar_name)) between 1 and 300)
);

comment on table public.google_calendar_connections is 'Google Calendar integration of a TRAZA user (one per user). Tokens are stored only as server-encrypted ciphertext and are not selectable by clients.';
comment on column public.google_calendar_connections.refresh_token_ciphertext is 'AES-256-GCM ciphertext produced by the Next.js server; the key never leaves the server environment. Not selectable via the Data API.';

create trigger google_calendar_connections_set_updated_at
  before update on public.google_calendar_connections
  for each row
  execute function public.set_updated_at();

-- The unique (user_id) index serves RLS and every lookup (one row per user).

-- ---------------------------------------------------------------------------
-- Row Level Security: owner-only access for signed-in users. anon gets nothing.
-- ---------------------------------------------------------------------------
alter table public.google_calendar_connections enable row level security;

create policy "Users can read their own Google Calendar connection"
  on public.google_calendar_connections for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can create their own Google Calendar connection"
  on public.google_calendar_connections for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update their own Google Calendar connection"
  on public.google_calendar_connections for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete their own Google Calendar connection"
  on public.google_calendar_connections for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- Data API privileges: explicit and column-scoped (least privilege).
-- ---------------------------------------------------------------------------
-- SELECT: metadata only, never the ciphertext columns. INSERT/UPDATE may write ciphertext (the
-- server stores what it encrypted; a client writing its own row can only break its own connection,
-- and the format check refuses plain tokens). id, user_id and timestamps are set by the database.
revoke all on table public.google_calendar_connections from anon, authenticated;

grant select (
  id, user_id, google_account_email, status, access_token_expires_at,
  selected_calendar_id, selected_calendar_name, connected_at, created_at, updated_at
) on table public.google_calendar_connections to authenticated;

grant insert (
  google_account_email, status, refresh_token_ciphertext, access_token_ciphertext, access_token_expires_at,
  selected_calendar_id, selected_calendar_name, connected_at
) on table public.google_calendar_connections to authenticated;

grant update (
  google_account_email, status, refresh_token_ciphertext, access_token_ciphertext, access_token_expires_at,
  selected_calendar_id, selected_calendar_name, connected_at
) on table public.google_calendar_connections to authenticated;

grant delete on table public.google_calendar_connections to authenticated;

grant select, insert, update, delete on table public.google_calendar_connections to service_role;

-- ---------------------------------------------------------------------------
-- get_google_calendar_credentials: the caller's own ciphertexts, for the Next.js server
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER only because `authenticated` has no column privilege on the ciphertext columns.
-- It is pinned to auth.uid() (null rejected), takes no parameters, returns at most one row, and
-- returns ciphertext only: without the server-only key it reveals nothing usable.
create function public.get_google_calendar_credentials()
returns table (refresh_token_ciphertext text, access_token_ciphertext text, access_token_expires_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  return query
    select c.refresh_token_ciphertext, c.access_token_ciphertext, c.access_token_expires_at
      from public.google_calendar_connections c
     where c.user_id = (select auth.uid())
       and c.status = 'connected';
end;
$$;

comment on function public.get_google_calendar_credentials()
  is 'Returns the calling user''s encrypted Google tokens (ciphertext only) for the TRAZA server. Owner-only.';

revoke execute on function public.get_google_calendar_credentials() from public, anon;
grant execute on function public.get_google_calendar_credentials() to authenticated;
