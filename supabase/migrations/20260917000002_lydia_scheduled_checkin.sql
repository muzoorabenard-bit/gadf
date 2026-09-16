-- Mon/Fri 5pm Africa/Kampala (14:00 UTC, no DST) trigger for gadf's scheduled
-- Lydia check-in. The secret token is stored in Supabase Vault (inserted
-- separately, not committed here) and referenced by name, so the actual
-- value never lands in git history.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'gadf-lydia-checkin',
  '0 14 * * 1,5',
  $$
  select net.http_post(
    url := 'https://dmjywulepjrwptjsilgl.supabase.co/functions/v1/gadf-scheduled-report?token='
      || (select decrypted_secret from vault.decrypted_secrets where name = 'gadf_scheduled_trigger_secret')
  ) as request_id;
  $$
);
