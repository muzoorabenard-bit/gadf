-- Tracks the Drive folder id of "GADF Memories", where gadf-created Drive
-- files (like the SMS log) are filed, cached to avoid a search-by-name on
-- every write.
alter table financial_settings
  add column if not exists gadf_memories_folder_id text;
