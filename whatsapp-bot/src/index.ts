import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  type WASocket,
} from "@whiskeysockets/baileys";
import qrcodeTerminal from "qrcode-terminal";
import QRCode from "qrcode";
import pino from "pino";
import { createClient } from "@supabase/supabase-js";

// Links this process as an extra "device" on the owner's own WhatsApp
// account (the same QR-linking flow as WhatsApp Web/Desktop). Once linked,
// it treats the owner's own "Message yourself" chat as gadf's control
// channel: anything typed there from the phone is sent to gadf-chat, and
// her reply is sent back into that same chat. No other chat is touched.
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!;
const GADF_EMAIL = process.env.GADF_EMAIL!;
const GADF_PASSWORD = process.env.GADF_PASSWORD!;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !GADF_EMAIL || !GADF_PASSWORD) {
  console.error("Missing required env vars — copy .env.example to .env and fill it in.");
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = path.join(__dirname, "..", "auth_state");

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Every message this process itself sends comes back through
// messages.upsert (it's still "fromMe" in the self-chat) — tracked here so
// it isn't re-sent to gadf as if the owner had typed it.
const sentByBot = new Set<string>();

let userId = "";
let currentSock: WASocket | null = null;

async function askGadf(message: string): Promise<string> {
  const { data, error } = await supabase.functions.invoke("gadf-chat", {
    body: { message, channel: "whatsapp" },
  });
  if (error) {
    console.error("gadf-chat call failed:", error);
    return "Sorry, something went wrong on my end.";
  }
  return data?.reply || "...";
}

// Baileys represents each message type under a different key -- plain text
// is the easy case, but an image/voice note/sticker/etc. with no caption
// has no `.conversation` or `.extendedTextMessage.text` at all. Missing
// those meant Dero silently dropped non-text messages entirely (not even
// logging that one arrived), which is how a real unread message went
// missing from whatsapp_pending_messages. Falls back to a readable
// placeholder for anything without extractable text.
// deno-lint-ignore no-explicit-any
function extractMessageText(message: any): string {
  return (
    message.conversation ??
    message.extendedTextMessage?.text ??
    message.imageMessage?.caption ??
    message.videoMessage?.caption ??
    message.documentMessage?.caption ??
    (message.imageMessage ? "[image]" : undefined) ??
    (message.videoMessage ? "[video]" : undefined) ??
    (message.audioMessage ? (message.audioMessage.ptt ? "[voice note]" : "[audio]") : undefined) ??
    (message.stickerMessage ? "[sticker]" : undefined) ??
    (message.documentMessage ? `[document: ${message.documentMessage.fileName ?? "file"}]` : undefined) ??
    (message.locationMessage ? "[location]" : undefined) ??
    (message.contactMessage ? `[contact card: ${message.contactMessage.displayName ?? ""}]` : undefined) ??
    ""
  );
}

// Dero: archives every 1:1 conversation (not the self-chat control channel)
// into whatsapp_contacts/whatsapp_messages so gadf has context on anyone
// the user talks to. remoteJidAlt resolves the same @lid-vs-phone-number
// addressing quirk already handled for the self-chat, generalized to any
// contact.
async function upsertContactAndLog(
  remoteJid: string,
  remoteJidAlt: string | undefined,
  pushName: string | undefined,
  direction: "in" | "out",
  text: string,
  waMessageId: string | undefined,
  occurredAt: string,
): Promise<void> {
  const numberJid = remoteJidAlt?.endsWith("@s.whatsapp.net")
    ? remoteJidAlt
    : remoteJid.endsWith("@s.whatsapp.net")
    ? remoteJid
    : null;
  const jid = numberJid ?? remoteJid;
  const phoneNumber = numberJid ? numberJid.split("@")[0] : null;

  const { data: existing } = await supabase.from("whatsapp_contacts").select("id, display_name").eq("jid", jid).maybeSingle();

  let contactId: string;
  if (existing) {
    contactId = existing.id;
    if (pushName && pushName !== existing.display_name) {
      await supabase.from("whatsapp_contacts").update({ display_name: pushName, updated_at: new Date().toISOString() }).eq("id", contactId);
    }
  } else {
    const { data: created, error } = await supabase
      .from("whatsapp_contacts")
      .insert({ user_id: userId, jid, phone_number: phoneNumber, display_name: pushName ?? null })
      .select("id")
      .single();
    if (error) {
      console.error("Could not create whatsapp contact:", error);
      return;
    }
    contactId = created.id;
  }

  // A message can be redelivered on reconnect (see isLive above); the
  // whatsapp_messages_wa_message_id_idx unique index makes a duplicate a
  // harmless 23505 rather than a second archived copy.
  const { error: msgError } = await supabase.from("whatsapp_messages").insert({
    user_id: userId,
    contact_id: contactId,
    direction,
    text,
    wa_message_id: waMessageId ?? null,
    occurred_at: occurredAt,
  });
  if (msgError && msgError.code !== "23505") console.error("Could not log whatsapp message:", msgError);
}

// Polls whatsapp_outbox for messages gadf has been explicitly told to send
// (only ever queued after the user approved the exact text — see
// gadfCore.ts's whatsapp_send_message tool) and actually sends them.
async function pollOutbox(): Promise<void> {
  const { data: pending, error } = await supabase
    .from("whatsapp_outbox")
    .select("id, text, whatsapp_contacts (jid)")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(5);

  if (error) {
    console.error("Failed to poll whatsapp_outbox:", error.message);
    return;
  }

  for (const item of pending ?? []) {
    const sock = currentSock;
    // deno-lint-ignore no-explicit-any
    const jid = (item.whatsapp_contacts as any)?.jid as string | undefined;
    if (!sock || !jid) continue;

    try {
      const sent = await sock.sendMessage(jid, { text: item.text });
      if (sent?.key?.id) sentByBot.add(sent.key.id);
      await supabase.from("whatsapp_outbox").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", item.id);
      await upsertContactAndLog(jid, undefined, undefined, "out", item.text, sent?.key?.id, new Date().toISOString());
    } catch (err) {
      console.error(`Failed to send queued message ${item.id}:`, err);
      await supabase.from("whatsapp_outbox").update({ status: "failed", error: String(err) }).eq("id", item.id);
    }
  }
}

async function connect(): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock: WASocket = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
  });
  currentSock = sock;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\nScan this QR with WhatsApp (Settings > Linked Devices > Link a Device):\n");
      qrcodeTerminal.generate(qr, { small: true });
      const qrPngPath = path.join(__dirname, "..", "qr.png");
      QRCode.toFile(qrPngPath, qr, { width: 400 }).catch((err) => console.error("QR PNG write failed:", err));
      console.log(`QR also saved as an image: ${qrPngPath}`);
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output
        ?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      if (loggedOut) {
        console.log("Logged out on the phone side. Delete the auth_state folder and restart to re-link.");
      } else {
        console.log("Connection closed, reconnecting...");
        connect();
      }
    } else if (connection === "open") {
      console.log("Connected. Message yourself on WhatsApp to talk to gadf.");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    // 'notify' is a live message; anything else (e.g. a reconnect catch-up
    // batch) is still real and gets archived below, just not treated as a
    // live self-chat command -- replaying an old command through gadf on
    // every reconnect would be wrong, but silently losing whatever arrived
    // while the bot was briefly down is worse. upsertContactAndLog dedupes
    // on wa_message_id in case the same message is redelivered later.
    const isLive = type === "notify";

    for (const m of messages) {
      if (!m.message || !m.key.id || !m.key.remoteJid) continue;

      if (sentByBot.has(m.key.id)) {
        sentByBot.delete(m.key.id);
        continue;
      }

      // WhatsApp addresses the "Message yourself" chat either as your plain
      // number JID or, on newer accounts, as an opaque @lid id with the
      // number given separately in remoteJidAlt -- accept either form.
      const rawId = sock.user?.id ?? "";
      const selfJid = `${rawId.split(":")[0]}@s.whatsapp.net`;
      const remoteJidAlt = (m.key as { remoteJidAlt?: string }).remoteJidAlt;
      const isSelfChat = m.key.remoteJid === selfJid || remoteJidAlt === selfJid;

      if (isSelfChat && !isLive) continue;

      if (isSelfChat) {
        const text = m.message.conversation ?? m.message.extendedTextMessage?.text ?? "";
        if (!text.trim()) continue;

        console.log("You:", text);
        const reply = await askGadf(text);
        console.log("gadf:", reply);

        const sent = await sock.sendMessage(m.key.remoteJid, { text: reply });
        if (sent?.key?.id) sentByBot.add(sent.key.id);
        continue;
      }

      // Dero: archive genuine 1:1 chats only. `participant` being set is
      // the reliable signal for "this isn't really a 1:1 message" (groups,
      // broadcast lists, status replies) regardless of what remoteJid looks
      // like -- suffix checks alone let one through once with a fabricated-
      // looking result, so this is belt-and-suspenders on top of them.
      if (
        m.key.remoteJid.endsWith("@g.us") ||
        m.key.remoteJid.endsWith("@newsletter") ||
        m.key.remoteJid.endsWith("@broadcast") ||
        m.key.participant
      ) {
        console.log(
          `[dero] skipped non-1:1 message — remoteJid=${m.key.remoteJid} participant=${m.key.participant ?? "none"} type=${type}`,
        );
        continue;
      }
      const text = extractMessageText(m.message);
      if (!text) continue;
      console.log(`[dero] capturing — remoteJid=${m.key.remoteJid} remoteJidAlt=${remoteJidAlt ?? "none"} fromMe=${m.key.fromMe} type=${type}`);
      const occurredAt = m.messageTimestamp
        ? new Date(Number(m.messageTimestamp) * 1000).toISOString()
        : new Date().toISOString();
      await upsertContactAndLog(
        m.key.remoteJid,
        remoteJidAlt,
        m.pushName ?? undefined,
        m.key.fromMe ? "out" : "in",
        text,
        m.key.id,
        occurredAt,
      );
    }
  });
}

async function main() {
  const { data, error } = await supabase.auth.signInWithPassword({ email: GADF_EMAIL, password: GADF_PASSWORD });
  if (error || !data.user) {
    console.error("Sign-in failed:", error?.message);
    process.exit(1);
  }
  userId = data.user.id;
  console.log(`Signed in as ${GADF_EMAIL}. Starting WhatsApp link...`);
  await connect();

  setInterval(() => {
    pollOutbox().catch((err) => console.error("Outbox poll error:", err));
  }, 10_000);
}

main();
