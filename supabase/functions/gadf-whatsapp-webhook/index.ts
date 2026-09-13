import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleGadfMessage } from "../_shared/gadfCore.ts";

// Hit directly by Twilio's webhook — an unauthenticated POST, so there's no
// Supabase session JWT to check. Trust is established two other ways instead:
// (1) verifying Twilio's request signature, so only real Twilio traffic gets
// through, and (2) checking the sender's WhatsApp number against the one
// known owner number, so a stranger who finds this URL can't get gadf to act
// on their behalf (delete calendar events, push code, etc).
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID")!;
const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN")!;
const TWILIO_WHATSAPP_FROM = Deno.env.get("TWILIO_WHATSAPP_FROM")!; // e.g. "whatsapp:+14155238886"
const GADF_OWNER_USER_ID = Deno.env.get("GADF_OWNER_USER_ID")!;
const GADF_OWNER_WHATSAPP_NUMBER = Deno.env.get("GADF_OWNER_WHATSAPP_NUMBER")!; // e.g. "whatsapp:+2567xxxxxxx"
const WEBHOOK_URL = `${SUPABASE_URL}/functions/v1/gadf-whatsapp-webhook`;

const EMPTY_TWIML = new Response("<Response></Response>", {
  headers: { "Content-Type": "text/xml" },
});

async function isValidTwilioSignature(params: Record<string, string>, signature: string | null): Promise<boolean> {
  if (!signature) return false;
  let data = WEBHOOK_URL;
  for (const key of Object.keys(params).sort()) {
    data += key + params[key];
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(TWILIO_AUTH_TOKEN),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  const computed = btoa(String.fromCharCode(...new Uint8Array(sigBuffer)));
  return computed === signature;
}

async function sendWhatsAppMessage(to: string, body: string): Promise<void> {
  const creds = btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${creds}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ From: TWILIO_WHATSAPP_FROM, To: to, Body: body.slice(0, 1500) }),
  });
  if (!res.ok) {
    console.error("Twilio send failed:", await res.text());
  }
}

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const formData = await req.formData();
  const params: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    params[key] = String(value);
  }

  const validSignature = await isValidTwilioSignature(params, req.headers.get("X-Twilio-Signature"));
  if (!validSignature) {
    console.error("Rejected WhatsApp webhook call with invalid Twilio signature");
    return new Response("Forbidden", { status: 403 });
  }

  const from = params["From"] ?? "";
  const body = (params["Body"] ?? "").trim();

  if (from !== GADF_OWNER_WHATSAPP_NUMBER) {
    console.error("Rejected WhatsApp message from unrecognized number:", from);
    return EMPTY_TWIML;
  }
  if (!body) {
    return EMPTY_TWIML;
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  try {
    const result = await handleGadfMessage(supabase, GADF_OWNER_USER_ID, body, "whatsapp");
    const replyText = "reply" in result ? (result.reply || "…") : `Something went wrong: ${result.error}`;
    await sendWhatsAppMessage(from, replyText);
  } catch (err) {
    console.error("gadf-whatsapp-webhook error:", err);
    await sendWhatsAppMessage(from, "Sorry, something went wrong on my end.").catch(() => {});
  }

  return EMPTY_TWIML;
});
