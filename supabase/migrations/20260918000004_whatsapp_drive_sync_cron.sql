-- Every 6 hours, mirror newly-captured WhatsApp messages into per-contact
-- Drive files (see gadf-whatsapp-drive-sync). Same pg_cron/pg_net + Vault
-- pattern as the Lydia check-in (20260917000002_lydia_scheduled_checkin.sql)
-- -- the secret is inserted separately into Vault, not committed here.

select cron.schedule(
  'gadf-whatsapp-drive-sync',
  '0 */6 * * *',
  $$
  select net.http_post(
    url := 'https://dmjywulepjrwptjsilgl.supabase.co/functions/v1/gadf-whatsapp-drive-sync?token='
      || (select decrypted_secret from vault.decrypted_secrets where name = 'gadf_whatsapp_sync_secret')
  ) as request_id;
  $$
);
