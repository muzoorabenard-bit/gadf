-- Mobile money transactions, captured from SMS forwarded off the user's
-- phones by a third-party forwarder app (gadf-sms-ingest), then parsed into
-- structured fields by Claude. raw_sms is always kept so a bad parse can be
-- re-parsed or fixed by hand later without having lost the source text.

create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_phone text not null default 'unknown', -- which of the user's phones forwarded this
  raw_sms text not null,
  sender text, -- SMS sender id, e.g. "MTNMoney"
  transaction_type text check (transaction_type in ('receive', 'send', 'payment', 'withdraw', 'deposit', 'airtime', 'other')),
  amount numeric,
  currency text default 'UGX',
  counterparty text,
  counterparty_number text,
  fee numeric,
  balance_after numeric,
  transaction_ref text, -- mobile money's own transaction id, for de-duplication
  occurred_at timestamptz, -- parsed from the SMS itself, when present
  parse_status text not null default 'pending' check (parse_status in ('pending', 'parsed', 'failed')),
  parse_error text,
  created_at timestamptz not null default now()
);

create index transactions_user_occurred_idx on public.transactions (user_id, occurred_at desc);
-- Avoid double-counting if the forwarder app retries a delivery.
create unique index transactions_dedup_idx on public.transactions (user_id, transaction_ref) where transaction_ref is not null;

alter table public.transactions enable row level security;

create policy "own transactions" on public.transactions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
