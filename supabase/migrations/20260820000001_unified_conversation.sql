-- Collapse the per-channel conversation silos into one continuous
-- conversation per user, so context is the same whether you're on the
-- website, the watch, or (later) WhatsApp/SMS. Each message keeps a
-- `channel` tag for provenance, but working memory now spans all of them.

alter table public.messages add column if not exists channel text;

update public.messages m
set channel = c.channel
from public.conversations c
where m.conversation_id = c.id and m.channel is null;

alter table public.messages alter column channel set default 'web';
update public.messages set channel = 'web' where channel is null;
alter table public.messages alter column channel set not null;

-- Merge every user's multiple conversations into their earliest one.
do $$
declare
  uid uuid;
  canonical_id uuid;
begin
  for uid in select distinct user_id from public.conversations loop
    select id into canonical_id
    from public.conversations
    where user_id = uid
    order by created_at asc
    limit 1;

    update public.messages
    set conversation_id = canonical_id
    where user_id = uid and conversation_id <> canonical_id;

    delete from public.conversations where user_id = uid and id <> canonical_id;
  end loop;
end $$;

create unique index if not exists conversations_user_id_unique on public.conversations (user_id);
