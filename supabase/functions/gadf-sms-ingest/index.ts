import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { appendSmsToDriveLog } from "../_shared/driveLog.ts";

// Hit directly by a third-party "SMS Forwarder" app on the user's phones —
// an unauthenticated request with no Supabase JWT, and one whose exact
// request shape (JSON body? form body? query params? field names?) isn't
// fully known ahead of time, since forwarder apps vary. So this is
// deliberately defensive: it accepts GET or POST, reads the body as JSON or
// form-urlencoded, falls back to query params, and checks several common
// field names for the sender and message text.
//
// Trust comes from a secret token in the URL path (?token=... would also
// work, but forwarder apps more reliably support a fixed URL than custom
// headers) — not a Supabase session, since the forwarder app has no way to
// hold one.
//
// The user's forwarder app can't filter by sender, so it forwards *every*
// SMS on both phones — personal texts included. isLikelyMobileMoneySms()
// rejects anything that doesn't look like a transaction before it's logged
// or sent to Claude, so a personal message's content never gets persisted
// or leaves this function for an AI call. That filter is a heuristic and
// may need tightening once we see what real MTN messages look like —
// message text for anything it accepts is still logged for now, to make
// that tuning possible; message text for anything it rejects never is.
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

const MTN_SENDER_PATTERNS = ["mtn", "m-money", "mmoney", "mobilemoney"];
// MTN Mobile Money SMS in Uganda consistently include the currency and one
// of these transaction-shaped phrases. Requiring both cuts down on a
// personal message that happens to mention money in passing.
const TRANSACTION_PHRASES = [
  "new balance", "your balance", "transaction id", "txn id", "txnid",
  "you have received", "you have sent", "you have paid", "you have withdrawn",
  "payment of", "withdrawal of", "deposit of", "mobile money",
];

function isLikelyMobileMoneySms(sender: string, text: string): boolean {
  const senderLower = sender.toLowerCase();
  const textLower = text.toLowerCase();
  if (MTN_SENDER_PATTERNS.some((p) => senderLower.includes(p))) return true;
  const hasCurrency = /\bugx\b/i.test(text);
  const hasTransactionPhrase = TRANSACTION_PHRASES.some((p) => textLower.includes(p));
  return hasCurrency && hasTransactionPhrase;
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
  category_name: string | null;
  category_confidence: number | null;
  purpose_type: "personal" | "business" | "mixed" | "unknown";
}

async function resolveAccount(
  supabase: SupabaseClient,
  userId: string,
  sourcePhone: string,
): Promise<string | null> {
  const { data: existing } = await supabase
    .from("financial_accounts")
    .select("id")
    .eq("user_id", userId)
    .eq("source_phone", sourcePhone)
    .maybeSingle();
  if (existing) return existing.id;

  const { data: created, error } = await supabase
    .from("financial_accounts")
    .insert({ user_id: userId, name: `MTN MoMo (${sourcePhone})`, type: "mobile_money", source_phone: sourcePhone })
    .select("id")
    .single();
  if (error) {
    console.error("Could not create financial account:", error);
    return null;
  }
  return created.id;
}

async function resolveCategory(
  supabase: SupabaseClient,
  userId: string,
  categoryName: string | null,
  purposeType: string,
): Promise<string | null> {
  if (!categoryName) return null;

  const { data: existing } = await supabase
    .from("categories")
    .select("id")
    .eq("user_id", userId)
    .ilike("name", categoryName)
    .limit(1)
    .maybeSingle();
  if (existing) return existing.id;

  const kind = purposeType === "business" ? "business" : "personal";
  const { data: created, error } = await supabase
    .from("categories")
    .insert({ user_id: userId, name: categoryName, kind })
    .select("id")
    .single();
  if (error) {
    console.error("Could not create category:", error);
    return null;
  }
  return created.id;
}

async function parseTransaction(
  smsText: string,
  receivedAt: string,
  knownCategoryNames: string[],
): Promise<ParsedTransaction | null> {
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
        "Always call record_transaction, even if some fields are unknown (use null). If this text is not actually a mobile money transaction notification, call record_transaction with transaction_type \"other\" and amount null.\n\n" +
        `The user's existing categories are: ${knownCategoryNames.length ? knownCategoryNames.join(", ") : "(none yet)"}. ` +
        "Prefer reusing an existing category over inventing a similar new one. purpose_type should be \"business\" only if the SMS clearly relates to one of the user's business activities (e.g. paying for materials, receiving a client payment) — default to \"personal\" for everyday spending, or \"unknown\" if genuinely unclear. Set category_confidence between 0 and 1 reflecting how sure you are of the category guess.",
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
              category_name: { type: ["string", "null"], description: "Best-matching category name, existing or new" },
              category_confidence: { type: ["number", "null"], description: "0 to 1" },
              purpose_type: { type: "string", enum: ["personal", "business", "mixed", "unknown"] },
            },
            required: ["transaction_type", "amount", "currency", "purpose_type"],
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

  if (!text) {
    // No content was extracted at all — safe to log the field names (not
    // values weren't found anyway) to help diagnose an unrecognized shape.
    console.log("gadf-sms-ingest: no message text found among fields", Object.keys(params));
    return new Response(JSON.stringify({ error: "No message text found in request" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!isLikelyMobileMoneySms(sender, text)) {
    // Deliberately not logging `text` here — this branch is expected to
    // catch personal messages, since the forwarder app can't filter by
    // sender before forwarding.
    return new Response(JSON.stringify({ status: "ignored, not a mobile money message" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  console.log("gadf-sms-ingest: processing likely mobile money SMS from", sender || "(unknown sender)");

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const receivedAt = new Date().toISOString();

  const [accountId, categoriesRes] = await Promise.all([
    resolveAccount(supabase, GADF_OWNER_USER_ID, sourcePhone),
    supabase.from("categories").select("name").eq("user_id", GADF_OWNER_USER_ID),
  ]);
  const knownCategoryNames = (categoriesRes.data ?? []).map((c) => c.name as string);

  const parsed = await parseTransaction(text, receivedAt, knownCategoryNames);
  const categoryId = parsed
    ? await resolveCategory(supabase, GADF_OWNER_USER_ID, parsed.category_name, parsed.purpose_type)
    : null;

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
    account_id: accountId,
    category_id: categoryId,
    category_confidence: parsed?.category_confidence ?? null,
    purpose_type: parsed?.purpose_type ?? "unknown",
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

  await appendSmsToDriveLog(
    supabase,
    GADF_OWNER_USER_ID,
    `${receivedAt} | ${sourcePhone} | ${sender || "(unknown sender)"} | ${text}`,
  );

  return new Response(JSON.stringify({ status: "ok" }), {
    headers: { "Content-Type": "application/json" },
  });
});
