-- Prompt 23: wake-up of TRAZA's trusted background scheduler.
--
--   Supabase Cron (pg_cron), every 5 minutes
--     → traza_private.invoke_scheduler()
--     → pg_net HTTPS POST to the production endpoint (Vercel) with Authorization: Bearer <secret>
--     → POST /api/internal/scheduler runs the EXISTING reminder / Canvas / Google engines.
--
-- Postgres only wakes the app up: no reminder, Canvas or Google logic lives here. Whether anything
-- is due is still decided by the app and by the existing leases, cooldowns and delivery dedupe.
--
-- NO secret or URL is stored in this file. The two values live in Supabase Vault, under fixed names
-- added by hand after the first deployment:
--   traza_scheduler_url     https://<production-domain>/api/internal/scheduler
--   traza_scheduler_secret  the same value as SCHEDULER_SECRET in Vercel (production)
-- Until BOTH exist (and look valid), the job is a quiet no-op: no HTTP request, no error.

-- Extensions (no-ops where already enabled). Vault is enabled on every Supabase project.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
create extension if not exists supabase_vault;

-- A schema the Data API does not expose; nobody but the database owner may use it.
create schema if not exists traza_private;
revoke all on schema traza_private from public;
comment on schema traza_private is 'TRAZA internals not reachable through the Data API (scheduler wake-up).';

-- ---------------------------------------------------------------------------------------------
-- invoke_scheduler: one POST to the scheduler endpoint, or nothing when not configured.
-- SECURITY INVOKER: it runs as the cron job's owner (the database owner, who may read Vault). No
-- client role can execute it (revoked below), and it takes no arguments: the target and the secret
-- come ONLY from the two fixed Vault names, never from a caller. The URL must be https and end in
-- the scheduler path, so a mistyped value never sends the secret anywhere else on that host.
-- Returns the pg_net request id, or null when it did nothing. The decrypted values are never
-- returned, raised or logged.
create function traza_private.invoke_scheduler()
returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_url    text;
  v_secret text;
begin
  select s.decrypted_secret into v_url from vault.decrypted_secrets s where s.name = 'traza_scheduler_url';
  select s.decrypted_secret into v_secret from vault.decrypted_secrets s where s.name = 'traza_scheduler_secret';

  if v_url is null or v_secret is null
     or v_url !~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/api/internal/scheduler$'
     or length(v_secret) not between 32 and 512
     or v_secret !~ '^[!-~]+$' then
    return null;
  end if;

  return net.http_post(
    url                  := v_url,
    body                 := jsonb_build_object('source', 'supabase-cron', 'version', 1),
    headers              := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret),
    -- The endpoint may run up to 300 s (Vercel maxDuration); waiting keeps its summary in
    -- net._http_response (aggregate counts only) for inspection.
    timeout_milliseconds := 290000
  );
end;
$$;

comment on function traza_private.invoke_scheduler()
  is 'Supabase Cron wake-up: POSTs to the TRAZA scheduler endpoint using the Vault secrets traza_scheduler_url / traza_scheduler_secret. No-op until both exist.';

revoke all on function traza_private.invoke_scheduler() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- The jobs (cron.schedule replaces a job with the same name, so this is idempotent).
-- Every 5 minutes. That is only the wake-up rate: Canvas still syncs at most every 30 min and
-- Google every 15 min (their own cooldowns); reminders are decided by the planner + dedupe.
select cron.schedule('traza-scheduler', '*/5 * * * *', 'select traza_private.invoke_scheduler()');

-- Housekeeping: keep a week of run history for these two jobs only.
select cron.schedule(
  'traza-scheduler-cleanup',
  '17 3 * * *',
  $cmd$delete from cron.job_run_details
        where jobid in (select j.jobid from cron.job j where j.jobname in ('traza-scheduler', 'traza-scheduler-cleanup'))
          and end_time < now() - interval '7 days'$cmd$
);
