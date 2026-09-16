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

async function connect(): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock: WASocket = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
  });

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
    if (type !== "notify") return;

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
      const isSelfChat = m.key.remoteJid === selfJid || (m.key as { remoteJidAlt?: string }).remoteJidAlt === selfJid;
      if (!isSelfChat) continue;

      const text = m.message.conversation ?? m.message.extendedTextMessage?.text ?? "";
      if (!text.trim()) continue;

      console.log("You:", text);
      const reply = await askGadf(text);
      console.log("gadf:", reply);

      const sent = await sock.sendMessage(m.key.remoteJid, { text: reply });
      if (sent?.key?.id) sentByBot.add(sent.key.id);
    }
  });
}

async function main() {
  const { error } = await supabase.auth.signInWithPassword({ email: GADF_EMAIL, password: GADF_PASSWORD });
  if (error) {
    console.error("Sign-in failed:", error.message);
    process.exit(1);
  }
  console.log(`Signed in as ${GADF_EMAIL}. Starting WhatsApp link...`);
  await connect();
}

main();
