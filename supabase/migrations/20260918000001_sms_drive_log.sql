-- Tracks the Drive file id of the running SMS log text file gadf maintains
-- in the user's own Drive (created lazily on first successful Drive write).
alter table financial_settings
  add column if not exists sms_log_drive_file_id text;
