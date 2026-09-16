# G.A.D.F Memory System — Investigation Notes

Investigation-only writeup of `supabase/functions/gadf-memory-compact/index.ts`
(a Supabase Edge Function) and how it fits into the rest of the G.A.D.F
assistant. No code was changed to produce this document — see "Wiring status"
below for the main finding: **this function is not currently invoked by
anything else in the repo.**

## Where it lives

- `supabase/functions/gadf-memory-compact/index.ts` — the only file in that
  function's folder (a Deno Edge Function; there's no `package.json`, no
  separate types file — everything is in the one `index.ts`).
- It's a sibling of three other edge functions: `gadf-chat`,
  `gadf-approve-action`, `gadf-whatsapp-webhook`, `gadf-google-auth-callback`,
  plus a `_shared/gadfCore.ts` module used by the others.

## What "memory compaction" means here

G.A.D.F stores conversation history as raw rows in a `messages` table
(Postgres, via Supabase). That's fine for recent context but grows
unbounded and isn't useful as long-term "knowledge about the user."
Compaction is the nightly process that turns yesterday's raw chat
transcript into two things:

1. **A durable, human-readable archive** — the full transcript text for
   that user/day, saved verbatim (not summarized) into `memory_archives`.
2. **A small number of distilled "facts"** — an LLM (Claude, via the
   Anthropic Messages API) reads the transcript and extracts durable facts
   worth remembering long-term (preferences, plans, relationships, ongoing
   commitments; explicitly told to skip small talk). Each fact is embedded
   (Gemini `text-embedding-004`) and inserted as its own row into the
   `memories` table for later semantic retrieval.

This matches the "tiered memory" design documented in the schema migration
(`supabase/migrations/20260818000001_init.sql`):
- **Tier 1 — `identity_facts`**: small, static key/value facts always
  injected into the system prompt.
- **Tier 2 — recent `messages`**: the last ~20 messages of the current
  conversation, used as normal chat working memory.
- **Tier 3 — `memories`**: long-tail facts, embedded once and retrieved by
  vector similarity search (top-K, not the whole store) at chat time.

`gadf-memory-compact` is the *writer* for Tier 3 (and for the archive). It
does not touch Tier 1 or Tier 2.

## What triggers it

The function is an HTTP-triggered Deno `serve()` handler — it runs when
something sends it an HTTP request, not on a timer by itself. A code
comment at the top says:

> Nightly job (triggered by Supabase cron — see Supabase dashboard >
> Database > Cron once this project's ref exists)

So the intended trigger is a **Supabase pg_cron schedule configured in the
Supabase dashboard**, not something declared in this repo. Searching the
repo (migrations, `supabase/config.toml`, GitHub Actions workflows) turns
up **no cron schedule, no pg_cron SQL, and no other code path that calls
this function** — see "Wiring status" below.

The handler itself gates on a shared secret before doing any work:
- It reads an `x-cron-secret` request header and compares it to the
  `GADF_CRON_SECRET` environment variable; anything else gets a 401.
- This implies whatever calls it (dashboard cron job, or a manual `curl`)
  must be configured to send that header — that configuration isn't in
  this repo either.

## What data it reads and writes

For each user who has sent at least one message in the last 24 hours
(computed once up front by querying `messages` since `now - 1 day` and
de-duplicating `user_id`s):

**Reads:**
- `messages` — `role`, `content`, `created_at` for that user, over the last
  24 hours, ordered oldest-first. This is turned into a single plain-text
  transcript (`[timestamp] role: content` per line, newline-joined).

**Writes:**
- `memory_archives` — one row per `(user_id, archive_date)` (upserted, so a
  re-run for the same day overwrites rather than duplicates), containing
  the full transcript text for that day. `archive_date` is `today - 1 day`
  in `YYYY-MM-DD` form.
- `memories` — zero or more new rows, one per extracted fact, each with:
  `user_id`, `content` (the fact text), `embedding` (768-dim vector from
  Gemini), and `source: "compaction"` (distinguishing these from facts
  written directly during chat, which use `source: "chat"`, per the schema
  comment in the migration).

**External calls made along the way:**
- Anthropic Messages API (`https://api.anthropic.com/v1/messages`,
  model `claude-sonnet-5`) — given the full transcript, asked to return a
  JSON array of short, self-contained "durable fact" strings (or `[]` if
  nothing is worth keeping). The response is parsed as JSON; if parsing
  fails, that user is skipped (logged, not thrown) and processing moves on
  to the next user.
- Google Generative Language API (`text-embedding-004`) — one call per
  extracted fact, to turn the fact text into a 768-dimension embedding
  vector (matching the `vector(768)` column type on `memories` and the
  `ivfflat` cosine-similarity index defined in the migration).

If embedding or insert fails for an individual fact, that failure is
caught and logged, and the loop continues with the next fact — a bad fact
doesn't abort the whole user's compaction, and one user's failure doesn't
abort the whole run (errors during transcript fetch/extraction are also
caught per-user with `continue`).

## Where memory is stored

Everything is in the same Supabase/Postgres database used by the rest of
G.A.D.F (`messages`, `memories`, `memory_archives` tables, all under the
`public` schema, all with Row Level Security policies scoping rows to
`auth.uid()`). This function connects with the **service role key**
(bypassing RLS) rather than a per-user JWT, because — per its own comment —
it's a system job that needs to span all users, not one authenticated
session.

There is **no Google Drive and no local file storage yet** despite the
folder/table naming suggesting it. The `memory_archives` table has a
`drive_synced boolean not null default false` column, and the code comment
says "archives the full transcript for later Google Drive sync (Phase 2
adds the actual Drive upload)." The current code never sets `drive_synced`
to `true` and never calls any Drive API — the Drive sync is planned but not
implemented. (A separate function, `gadf-google-auth-callback`, and Drive
tool support exist elsewhere in `_shared/gadfCore.ts` for the assistant's
own Drive *tool calls* during chat, but nothing connects that to
`memory_archives`.)

## How the *read* side works (for context — not part of this function)

`_shared/gadfCore.ts` (used by `gadf-chat`) is where `memories` written by
this compaction job actually get used:
- On each incoming chat message, it embeds the user's message text, then
  calls a Postgres function `match_memories(query_embedding, user_id,
  match_count=5)` (defined in the same migration) to pull the 5 most
  similar `memories` rows by cosine similarity, and injects them into the
  system prompt as "Relevant memories."
- It separately loads all `identity_facts` (Tier 1) and the last 20
  `messages` in the current conversation (Tier 2).

So the retrieval path is real and wired up end-to-end for whatever rows
already exist in `memories` — it's specifically the *production* of new
`memories` rows via nightly compaction that appears disconnected (see
next section). Memory rows created some other way (e.g. directly during
chat, per the `source: "chat"` option seen in the schema) would still be
retrieved normally.

## Wiring status — is this actually running?

**No evidence it's currently being invoked by anything in this repo:**

- `supabase/config.toml` only declares `verify_jwt = false` overrides for
  `gadf-google-auth-callback` and `gadf-whatsapp-webhook`. It says nothing
  about `gadf-memory-compact`, and contains no `[functions.gadf-memory-compact]`
  entry, no cron/schedule section at all.
- No migration file contains a `pg_cron` / `cron.schedule` call or any SQL
  that would invoke this function on a timer.
- No other function or file in the repo references
  `gadf-memory-compact` by name/URL, and nothing sets or reads
  `GADF_CRON_SECRET` except this file itself.
- `.github/workflows/deploy-supabase.yml` deploys all edge functions
  (`supabase functions deploy`) and pushes migrations on every push to
  `main` that touches `supabase/**` — so the function *is* deployed and
  live at its URL — but deploying it is not the same as scheduling it.
  There is no workflow step or migration that sets up the actual cron
  trigger.

**Conclusion:** the function is written, deployed, and would work if
called (it validates a shared secret, then does real reads/writes), but
the "nightly" part of "nightly job" depends on a Supabase Dashboard cron
schedule (Database > Cron) that — per the code's own comment — was still
pending creation ("once this project's ref exists") and is not represented
anywhere in this repository. Unless someone has since configured that cron
job directly in the Supabase dashboard (outside of what's checked into
git), **this job is not currently running on any schedule**, and the
`memories` table is presumably only being populated (if at all) through
whatever `source: "chat"` path exists in `gadf-chat`/`gadfCore.ts`, not
through nightly compaction.

## Summary

| Question | Answer |
|---|---|
| What triggers it | Meant to be a nightly Supabase pg_cron schedule (dashboard-configured); guarded by an `x-cron-secret` header check |
| Is it wired in today | No — no cron config, no caller, found anywhere in the repo |
| Reads | `messages` (last 24h, per user) |
| Writes | `memory_archives` (raw daily transcript, upsert by user+date); `memories` (LLM-extracted facts + embeddings) |
| Storage backend | Supabase/Postgres (`public` schema), service-role access, RLS bypassed by design |
| Google Drive involvement | Planned ("Phase 2"), not implemented — `drive_synced` column exists but is never set |
| LLM(s) used | Anthropic Claude (`claude-sonnet-5`) for fact extraction; Google Gemini `text-embedding-004` for embeddings |
| Consumed by | `gadf-chat` via `_shared/gadfCore.ts`, which queries `memories` through the `match_memories` similarity-search RPC at chat time |
