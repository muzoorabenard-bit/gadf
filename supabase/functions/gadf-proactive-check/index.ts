import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleGadfMessage } from "../_shared/gadfCore.ts";

// Triggered by pg_cron every 3 hours (see the proactive_check_cron
// migration) — no user JWT available since nothing but the scheduler calls
// this, so trust comes from a static secret in the URL, same pattern as
// gadf-sms-ingest and gadf-scheduled-report.
//
// Unlike the Mon/Fri Lydia report (which always posts), most check-ins here
// should find nothing worth surfacing -- the "proactive" channel's system
// prompt instructs gadf to reply with exactly "NOOP" when that's the case.
// handleGadfMessage always inserts the reply before returning, so a NOOP is
// deleted again right after rather than left sitting in the conversation.
//
// After a real post, a cooldown skips the next COOLDOWN_HOURS of checks
// entirely (no model call at all) so an unresolved issue doesn't get
// re-flagged -- and re-billed -- every 3 hours.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GADF_OWNER_USER_ID = Deno.env.get("GADF_OWNER_USER_ID")!;
const PROACTIVE_CHECK_SECRET = Deno.env.get("PROACTIVE_CHECK_SECRET")!;
const COOLDOWN_HOURS = 12;

serve(async (req) => {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  if (token !== PROACTIVE_CHECK_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // Cooldown check happens BEFORE calling the model at all -- skipping here
  // costs nothing (one cheap read), unlike a NOOP check-in which still
  // spends real tokens reviewing state and generating a response.
  const { data: settings } = await supabase
    .from("financial_settings")
    .select("last_proactive_post_at")
    .eq("user_id", GADF_OWNER_USER_ID)
    .maybeSingle();
  if (settings?.last_proactive_post_at) {
    const hoursSincePost = (Date.now() - new Date(settings.last_proactive_post_at).getTime()) / 3_600_000;
    if (hoursSincePost < COOLDOWN_HOURS) {
      return new Response(JSON.stringify({ status: "ok", posted: false, skipped: "cooldown" }), {
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  const result = await handleGadfMessage(
    supabase,
    GADF_OWNER_USER_ID,
    "[Proactive check-in] Anything worth flagging unprompted right now?",
    "proactive",
  );

  if ("error" in result) {
    console.error("Proactive check failed:", result.error);
    return new Response(JSON.stringify({ error: result.error }), {
      status: result.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  const isNoop = result.reply.trim() === "NOOP";
  if (isNoop && result.messageId) {
    await supabase.from("messages").delete().eq("id", result.messageId);
  } else if (!isNoop) {
    await supabase
      .from("financial_settings")
      .upsert({ user_id: GADF_OWNER_USER_ID, last_proactive_post_at: new Date().toISOString() }, { onConflict: "user_id" });
  }

  return new Response(JSON.stringify({ status: "ok", posted: !isNoop }), {
    headers: { "Content-Type": "application/json" },
  });
});
