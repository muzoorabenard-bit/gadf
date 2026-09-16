-- Dero now accepts reconnect catch-up events (not just live 'notify'
-- events) so a message that arrived during a brief bot restart isn't lost.
-- Those can be redelivered on the next reconnect, so dedupe on the
-- WhatsApp message id.
create unique index whatsapp_messages_wa_message_id_idx
  on whatsapp_messages (wa_message_id)
  where wa_message_id is not null;
