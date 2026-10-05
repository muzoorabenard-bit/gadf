-- Tracks the last time a proactive check-in actually posted something (not
-- a NOOP), so gadf-proactive-check can skip the next several hours of
-- checks entirely rather than re-flagging the same unresolved issue every
-- 3 hours -- a cooldown read is cheap; an LLM call to re-generate the same
-- point is not.
alter table financial_settings add column if not exists last_proactive_post_at timestamptz;
