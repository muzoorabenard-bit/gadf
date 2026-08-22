import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

// Tool executors get registered here as later phases add real sensitive
// tools (send email, send WhatsApp/SMS, write to Drive, ...). Empty for
// now — Phase 0/1 has no tools at all, so "approve" just records the
// decision instead of running anything.
const executors: Record<string, (input: unknown) => Promise<unknown>> = {};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData.user) {
      return new Response(JSON.stringify({ error: "Invalid session" }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const { actionId, decision }: { actionId: string; decision: "approved" | "denied" } =
      await req.json();

    if (!actionId || !["approved", "denied"].includes(decision)) {
      return new Response(
        JSON.stringify({ error: "actionId and a valid decision are required" }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } },
      );
    }

    const { data: action, error: fetchError } = await supabase
      .from("pending_actions")
      .select("*")
      .eq("id", actionId)
      .single();

    if (fetchError || !action) {
      return new Response(JSON.stringify({ error: "Action not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    if (action.status !== "pending") {
      return new Response(JSON.stringify({ error: `Action already ${action.status}` }), {
        status: 409,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    let status: string = decision;
    let result: unknown = null;

    if (decision === "approved") {
      const executor = executors[action.tool_name];
      if (executor) {
        try {
          result = await executor(action.tool_input);
          status = "executed";
        } catch (e) {
          console.error("Executor failed:", e);
          status = "failed";
          result = { error: String(e) };
        }
      } else {
        result = { note: "No executor registered for this tool yet" };
      }
    }

    await supabase
      .from("pending_actions")
      .update({ status, result, resolved_at: new Date().toISOString() })
      .eq("id", actionId);

    return new Response(JSON.stringify({ status, result }), {
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (err) {
    console.error("gadf-approve-action error:", err);
    return new Response(JSON.stringify({ error: "Internal error" }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
});
