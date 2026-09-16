import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Hit directly by a third-party "SMS Forwarder" app on the user's phones —
// an unauthenticated request with no Supabase JWT, and one whose exact
// request shape (JSON body? form body? query params? field names?) isn't
// fully known ahead of time, since forwarder apps vary. So this is
// deliberately defensive: it accepts GET or POST, reads the body as JSON or
// form-urlencoded, falls back to query params, and checks several common
// field names for the sender and message text. It logs whatever it
// receives either way, so a real payload can be inspected and the parsing
// tightened later if a message doesn't match any of the guessed fields.
//
// Trust comes from a secret token in the URL path (?token=... would also
// work, but forwarder apps more reliably support a fixed URL than custom
// headers) — not a Supabase session, since the forwarder app has no way to
// hold one.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const GADF_OWNER_USER_ID = Deno.env.get("GADF_OWNER_USER_ID")!;
const SMS_INGEST_SECRET = Deno.env.get("SMS_INGEST_SECRET")!;

const SENDER_FIELDS = ["from", "sender", "originatingAddress", "number", "source"];
const TEXT_FIELDS = ["text", "message", "msg", "body", "content", "sms"];
const PHONE_FIELDS = ["phone", "device", "sim", "source_phone"];

function firstOf(obj: Record<string, string>, keys: string[]): string {
  for (const key of keys) {
    const value = obj[key] ?? obj[key.toLowerCase()] ?? obj[key.toUpperCase()];
    if (value) return value;
  }
  return "";
}

async function extractParams(req: Request): Promise<Record<string, string>> {
  const url = new URL(req.url);
  const params: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) params[key] = value;

  if (req.method === "POST") {
    const contentType = req.headers.get("content-type") ?? "";
    try {
      if (contentType.includes("application/json")) {
        const json = await req.json();
        for (const [key, value] of Object.entries(json)) params[key] = String(value);
      } else {
        const form = await req.formData();
        for (const [key, value] of form.entries()) params[key] = String(value);
      }
    } catch {
      // Some forwarder apps send a plain-text body — nothing more to extract.
    }
  }
  return params;
}

interface ParsedTransaction {
  transaction_type: "receive" | "send" | "payment" | "withdraw" | "deposit" | "airtime" | "other";
  amount: number | null;
  currency: string;
  counterparty: string | null;
  counterparty_number: string | null;
  fee: number | null;
  balance_after: number | null;
  transaction_ref: string | null;
  occurred_at: string | null;
}

async function parseTransaction(smsText: string, receivedAt: string): Promise<ParsedTransaction | null> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 512,
      system:
        `Extract structured data from an MTN Mobile Money SMS. The message was received at ${receivedAt} (use this to resolve relative/partial dates in the SMS, e.g. a time with no date). ` +
        "Always call record_transaction, even if some fields are unknown (use null). If this text is not actually a mobile money transaction notification, call record_transaction with transaction_type \"other\" and amount null.",
      messages: [{ role: "user", content: smsText }],
      tools: [
        {
          name: "record_transaction",
          description: "Record the structured fields extracted from the SMS.",
          input_schema: {
            type: "object",
            properties: {
              transaction_type: { type: "string", enum: ["receive", "send", "payment", "withdraw", "deposit", "airtime", "other"] },
              amount: { type: ["number", "null"] },
              currency: { type: "string", description: "e.g. UGX" },
              counterparty: { type: ["string", "null"], description: "Name of the other party, if present" },
              counterparty_number: { type: ["string", "null"] },
              fee: { type: ["number", "null"] },
              balance_after: { type: ["number", "null"] },
              transaction_ref: { type: ["string", "null"], description: "MTN's own transaction/reference id" },
              occurred_at: { type: ["string", "null"], description: "ISO 8601 datetime if determinable from the SMS, else null" },
            },
            required: ["transaction_type", "amount", "currency"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "record_transaction" },
    }),
  });

  if (!res.ok) {
    console.error("Anthropic parse call failed:", await res.text());
    return null;
  }
  const data = await res.json();
  const toolUse = (data.content ?? []).find((b: { type: string }) => b.type === "tool_use");
  if (!toolUse) return null;
  return toolUse.input as ParsedTransaction;
}

serve(async (req) => {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? url.pathname.split("/").pop();
  if (token !== SMS_INGEST_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }

  const params = await extractParams(req);
  const sender = firstOf(params, SENDER_FIELDS);
  const text = firstOf(params, TEXT_FIELDS);
  const sourcePhone = firstOf(params, PHONE_FIELDS) || "unknown";

  console.log("gadf-sms-ingest received:", JSON.stringify(params));

  if (!text) {
    return new Response(JSON.stringify({ error: "No message text found in request", received: params }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const receivedAt = new Date().toISOString();
  const parsed = await parseTransaction(text, receivedAt);

  const { error } = await supabase.from("transactions").insert({
    user_id: GADF_OWNER_USER_ID,
    source_phone: sourcePhone,
    raw_sms: text,
    sender: sender || null,
    transaction_type: parsed?.transaction_type ?? null,
    amount: parsed?.amount ?? null,
    currency: parsed?.currency ?? "UGX",
    counterparty: parsed?.counterparty ?? null,
    counterparty_number: parsed?.counterparty_number ?? null,
    fee: parsed?.fee ?? null,
    balance_after: parsed?.balance_after ?? null,
    transaction_ref: parsed?.transaction_ref ?? null,
    occurred_at: parsed?.occurred_at ?? receivedAt,
    parse_status: parsed ? "parsed" : "failed",
    parse_error: parsed ? null : "Could not extract structured fields",
  });

  if (error) {
    // A duplicate transaction_ref (the forwarder app retried a delivery) is
    // not a real failure — everything else is.
    if (error.code === "23505") {
      return new Response(JSON.stringify({ status: "duplicate, ignored" }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    console.error("Failed to insert transaction:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ status: "ok" }), {
    headers: { "Content-Type": "application/json" },
  });
});
