-- Google OAuth tokens for Drive access. One row per user, refreshed in place
-- by gadf-chat before each Drive tool call.

create table public.google_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  access_token text not null,
  refresh_token text not null,
  expires_at timestamptz not null,
  scope text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id)
);

alter table public.google_tokens enable row level security;

create policy "own google tokens" on public.google_tokens
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
