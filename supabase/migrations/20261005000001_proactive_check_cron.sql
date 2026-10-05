-- Every 3 hours, gadf reviews what's going on (pending WhatsApp replies,
-- active objectives, anything notable) and decides for herself whether it's
-- worth surfacing unprompted -- see gadf-proactive-check. Same pg_cron/
-- pg_net + Vault pattern as the Lydia check-in and WhatsApp Drive sync.
select cron.schedule(
  'gadf-proactive-check',
  '0 */3 * * *',
  $$
  select net.http_post(
    url := 'https://dmjywulepjrwptjsilgl.supabase.co/functions/v1/gadf-proactive-check?token='
      || (select decrypted_secret from vault.decrypted_secrets where name = 'gadf_proactive_check_secret')
  ) as request_id;
  $$
);
