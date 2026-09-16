-- Dero: WhatsApp contact archive, triage, approved sending, and
-- conversation-objective tracking. See jolly-petting-tiger.md for the full
-- design and the approval-gating rationale.

create table public.whatsapp_contacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  jid text not null,
  phone_number text,
  display_name text,
  drive_file_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, jid)
);

create table public.whatsapp_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  contact_id uuid not null references public.whatsapp_contacts(id) on delete cascade,
  direction text not null check (direction in ('in', 'out')),
  text text not null,
  wa_message_id text,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  drive_synced boolean not null default false
);

create index whatsapp_messages_contact_idx on public.whatsapp_messages (contact_id, occurred_at desc);
create index whatsapp_messages_unsynced_idx on public.whatsapp_messages (created_at) where drive_synced = false;

create table public.whatsapp_outbox (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  contact_id uuid not null references public.whatsapp_contacts(id) on delete cascade,
  text text not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create index whatsapp_outbox_pending_idx on public.whatsapp_outbox (created_at) where status = 'pending';

create table public.conversation_objectives (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  contact_id uuid not null references public.whatsapp_contacts(id) on delete cascade,
  objective text not null,
  status text not null default 'active' check (status in ('active', 'completed', 'abandoned')),
  stop_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index conversation_objectives_active_idx on public.conversation_objectives (contact_id) where status = 'active';

alter table public.financial_settings add column if not exists whatsapp_folder_id text;

alter table public.whatsapp_contacts enable row level security;
alter table public.whatsapp_messages enable row level security;
alter table public.whatsapp_outbox enable row level security;
alter table public.conversation_objectives enable row level security;

create policy "own whatsapp contacts" on public.whatsapp_contacts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own whatsapp messages" on public.whatsapp_messages
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own whatsapp outbox" on public.whatsapp_outbox
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own conversation objectives" on public.conversation_objectives
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
