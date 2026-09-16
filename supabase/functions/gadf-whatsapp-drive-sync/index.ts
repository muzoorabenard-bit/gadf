import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getGoogleAccessToken } from "../_shared/gadfCore.ts";
import { getOrCreateWhatsappFolder, appendLinesToContactFile } from "../_shared/whatsappDrive.ts";
import { lookupContactByPhone } from "../_shared/googleContacts.ts";

// Triggered every 6 hours by pg_cron (see the migration for the schedule).
// Public, verify_jwt = false -- no user JWT available since pg_cron has no
// session. Trust comes from a static secret in the URL, same shape as
// gadf-sms-ingest and gadf-scheduled-report.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GADF_OWNER_USER_ID = Deno.env.get("GADF_OWNER_USER_ID")!;
const WHATSAPP_SYNC_SECRET = Deno.env.get("WHATSAPP_SYNC_SECRET")!;

interface UnsyncedMessage {
  id: string;
  contact_id: string;
  direction: "in" | "out";
  text: string;
  occurred_at: string;
}

serve(async (req) => {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  if (token !== WHATSAPP_SYNC_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const googleToken = await getGoogleAccessToken(supabase, GADF_OWNER_USER_ID);
  if (!googleToken) {
    return new Response(JSON.stringify({ status: "skipped, google not connected" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const { data: settings } = await supabase
    .from("financial_settings")
    .select("whatsapp_folder_id")
    .eq("user_id", GADF_OWNER_USER_ID)
    .maybeSingle();
  const folderId = await getOrCreateWhatsappFolder(supabase, GADF_OWNER_USER_ID, googleToken, settings?.whatsapp_folder_id ?? null);

  const { data: unsynced, error } = await supabase
    .from("whatsapp_messages")
    .select("id, contact_id, direction, text, occurred_at")
    .eq("user_id", GADF_OWNER_USER_ID)
    .eq("drive_synced", false)
    .order("occurred_at", { ascending: true })
    .limit(500);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }

  const byContact = new Map<string, UnsyncedMessage[]>();
  for (const msg of (unsynced ?? []) as UnsyncedMessage[]) {
    const list = byContact.get(msg.contact_id) ?? [];
    list.push(msg);
    byContact.set(msg.contact_id, list);
  }

  let contactsSynced = 0;
  for (const [contactId, msgs] of byContact) {
    const { data: contact } = await supabase
      .from("whatsapp_contacts")
      .select("display_name, phone_number, drive_file_id")
      .eq("id", contactId)
      .single();
    if (!contact) continue;

    let displayName = contact.display_name as string | null;
    if (!displayName && contact.phone_number) {
      const found = await lookupContactByPhone(googleToken, contact.phone_number);
      if (found) {
        displayName = found;
        await supabase.from("whatsapp_contacts").update({ display_name: found, updated_at: new Date().toISOString() }).eq("id", contactId);
      }
    }

    const fileName = `${displayName || contact.phone_number || "Unknown"}.txt`;
    const lines = msgs.map((m) => `${m.occurred_at} | ${m.direction === "in" ? "them" : "you"} | ${m.text}`);

    await appendLinesToContactFile(supabase, googleToken, folderId, contactId, contact.drive_file_id, fileName, lines);

    await supabase
      .from("whatsapp_messages")
      .update({ drive_synced: true })
      .in("id", msgs.map((m) => m.id));

    contactsSynced++;
  }

  return new Response(JSON.stringify({ status: "ok", contactsSynced, messagesSynced: unsynced?.length ?? 0 }), {
    headers: { "Content-Type": "application/json" },
  });
});
