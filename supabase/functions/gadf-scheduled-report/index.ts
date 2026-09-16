import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleGadfMessage } from "../_shared/gadfCore.ts";

// Triggered by pg_cron (see the lydia_financial_foundation migration) at
// Mon/Fri 5pm Africa/Kampala — no user JWT available since nothing but the
// scheduler calls this, so trust comes from a static secret in the URL,
// same pattern as gadf-sms-ingest.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GADF_OWNER_USER_ID = Deno.env.get("GADF_OWNER_USER_ID")!;
const SCHEDULED_TRIGGER_SECRET = Deno.env.get("SCHEDULED_TRIGGER_SECRET")!;

serve(async (req) => {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  if (token !== SCHEDULED_TRIGGER_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const result = await handleGadfMessage(
    supabase,
    GADF_OWNER_USER_ID,
    "[Scheduled Mon/Fri check-in] Consult Lydia for my current financial state and share your thoughts.",
    "system",
  );

  if ("error" in result) {
    console.error("Scheduled report failed:", result.error);
    return new Response(JSON.stringify({ error: result.error }), {
      status: result.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ status: "ok" }), {
    headers: { "Content-Type": "application/json" },
  });
});
