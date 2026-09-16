-- Foundation for Lydia, gadf's financial-intelligence sub-agent: multi-account
-- model, categories, business/project allocation, commitments/receivables,
-- and per-user financial settings (reserve, essential expenses) used by the
-- safe-to-spend calculation. Deliberately minimal for now — recurring
-- detection, forecasting, and anomaly detection are later phases once there's
-- enough real transaction history to validate them against.

create table public.financial_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  type text not null check (type in ('mobile_money', 'bank', 'cash', 'business', 'other')),
  source_phone text, -- links an SMS-forwarded account back to gadf-sms-ingest's source_phone
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  unique (user_id, source_phone)
);

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  parent_id uuid references public.categories(id) on delete set null,
  kind text not null check (kind in ('personal', 'business')),
  created_at timestamptz not null default now(),
  unique (user_id, parent_id, name)
);

create table public.businesses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid references public.businesses(id) on delete set null,
  name text not null,
  status text not null default 'active' check (status in ('active', 'completed', 'on_hold')),
  created_at timestamptz not null default now()
);

create table public.commitments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  description text not null,
  amount numeric not null,
  due_date date,
  status text not null default 'pending' check (status in ('pending', 'paid', 'cancelled')),
  created_at timestamptz not null default now()
);

create table public.receivables (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  description text not null,
  amount numeric not null,
  counterparty text,
  expected_date date,
  status text not null default 'pending' check (status in ('pending', 'received', 'written_off')),
  created_at timestamptz not null default now()
);

-- One row per user. Both fields start unset — calculations that use them
-- must say so explicitly rather than silently treating null as zero.
create table public.financial_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  protected_reserve numeric,
  essential_monthly_expenses numeric,
  updated_at timestamptz not null default now()
);

alter table public.transactions
  add column account_id uuid references public.financial_accounts(id) on delete set null,
  add column category_id uuid references public.categories(id) on delete set null,
  add column category_confidence numeric,
  add column purpose_type text not null default 'unknown' check (purpose_type in ('personal', 'business', 'mixed', 'unknown')),
  add column business_id uuid references public.businesses(id) on delete set null,
  add column project_id uuid references public.projects(id) on delete set null,
  add column is_transfer boolean not null default false,
  add column linked_transaction_id uuid references public.transactions(id) on delete set null,
  add column normalized_merchant text;

create index transactions_account_idx on public.transactions (account_id);
create index transactions_category_idx on public.transactions (category_id);

alter table public.financial_accounts enable row level security;
alter table public.categories enable row level security;
alter table public.businesses enable row level security;
alter table public.projects enable row level security;
alter table public.commitments enable row level security;
alter table public.receivables enable row level security;
alter table public.financial_settings enable row level security;

create policy "own financial accounts" on public.financial_accounts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own categories" on public.categories
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own businesses" on public.businesses
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own projects" on public.projects
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own commitments" on public.commitments
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own receivables" on public.receivables
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own financial settings" on public.financial_settings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Seed the generic personal category tree for the single known user. Business
-- categories are intentionally not seeded — the user's actual businesses
-- aren't known yet, and get created via finance_create_business/project.
do $$
declare
  owner_id uuid := 'bc3ffe72-f73b-4207-a40a-b160ff303385';
  food_id uuid;
  transport_id uuid;
begin
  insert into public.categories (user_id, name, kind) values (owner_id, 'Food', 'personal') returning id into food_id;
  insert into public.categories (user_id, name, parent_id, kind) values
    (owner_id, 'Groceries', food_id, 'personal'),
    (owner_id, 'Restaurants', food_id, 'personal'),
    (owner_id, 'Takeaway', food_id, 'personal');

  insert into public.categories (user_id, name, kind) values (owner_id, 'Transport', 'personal') returning id into transport_id;
  insert into public.categories (user_id, name, parent_id, kind) values
    (owner_id, 'Fuel', transport_id, 'personal'),
    (owner_id, 'Taxi', transport_id, 'personal'),
    (owner_id, 'Ride-hailing', transport_id, 'personal');

  insert into public.categories (user_id, name, kind) values
    (owner_id, 'Housing', 'personal'),
    (owner_id, 'Utilities', 'personal'),
    (owner_id, 'Family', 'personal'),
    (owner_id, 'Health', 'personal'),
    (owner_id, 'Education', 'personal'),
    (owner_id, 'Entertainment', 'personal'),
    (owner_id, 'Shopping', 'personal'),
    (owner_id, 'Other', 'personal');
end $$;
