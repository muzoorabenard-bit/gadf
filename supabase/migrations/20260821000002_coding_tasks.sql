-- Queue for real coding work G.A.D.F delegates to a local coding-agent
-- process running on the user's PC. She only inserts a row here once she's
-- confident she understands the request (see gadf-chat's system prompt);
-- the local bridge does the actual work and posts the result back as a
-- message once done.

create table public.coding_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  repo text not null,
  instructions text not null,
  status text not null default 'pending' check (status in ('pending', 'running', 'completed', 'failed')),
  result_summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index coding_tasks_pending_idx on public.coding_tasks (created_at) where status = 'pending';

alter table public.coding_tasks enable row level security;

create policy "own coding tasks" on public.coding_tasks
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
