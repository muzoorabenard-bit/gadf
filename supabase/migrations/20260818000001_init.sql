-- G.A.D.F core schema: conversations/messages, tiered memory, and the
-- human-approval gate for sensitive actions. Single-user system — every
-- table is scoped to auth.uid() via RLS.

create extension if not exists vector;
create extension if not exists pgcrypto;

-- ── conversations & messages ────────────────────────────────────────────
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text,
  channel text not null default 'web', -- web | whatsapp | sms | watch
  created_at timestamptz not null default now()
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  created_at timestamptz not null default now()
);

create index messages_conversation_created_idx on public.messages (conversation_id, created_at);

-- ── tier 1: identity facts — tiny, static, always in the system prompt ──
create table public.identity_facts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null,
  value text not null,
  created_at timestamptz not null default now(),
  unique (user_id, key)
);

-- ── tier 3: long-term memory — embedded once, retrieved by similarity ──
create table public.memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  content text not null,
  embedding vector(768), -- gemini text-embedding-004 dimension
  source text not null default 'chat', -- chat | compaction | manual
  created_at timestamptz not null default now(),
  last_accessed_at timestamptz
);

create index memories_embedding_idx on public.memories
  using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- top-K similarity search, used by gadf-chat instead of loading all memories
create or replace function public.match_memories(
  query_embedding vector(768),
  match_user_id uuid,
  match_count int default 5
)
returns table (id uuid, content text, similarity float)
language sql stable
as $$
  select id, content, 1 - (embedding <=> query_embedding) as similarity
  from public.memories
  where user_id = match_user_id
  order by embedding <=> query_embedding
  limit match_count;
$$;

-- ── nightly compaction archive — durable copy, mirrored to Drive in Phase 2 ──
create table public.memory_archives (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  archive_date date not null,
  content text not null,
  drive_synced boolean not null default false,
  created_at timestamptz not null default now(),
  unique (user_id, archive_date)
);

-- ── approval gate for sensitive/irreversible tool calls ─────────────────
create table public.pending_actions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  tool_name text not null,
  tool_input jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied', 'executed', 'failed')),
  result jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

-- ── row level security: every row is owned by exactly one user ──────────
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.identity_facts enable row level security;
alter table public.memories enable row level security;
alter table public.memory_archives enable row level security;
alter table public.pending_actions enable row level security;

create policy "own conversations" on public.conversations
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own messages" on public.messages
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own identity facts" on public.identity_facts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own memories" on public.memories
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own memory archives" on public.memory_archives
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own pending actions" on public.pending_actions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
