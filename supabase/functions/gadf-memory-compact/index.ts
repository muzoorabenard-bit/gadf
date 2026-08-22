import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Nightly job (triggered by Supabase cron — see Supabase dashboard > Database >
// Cron once this project's ref exists): condenses the last day's raw messages
// into a handful of durable `memories` rows, and archives the full transcript
// for later Google Drive sync (Phase 2 adds the actual Drive upload).
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY")!;
const CRON_SECRET = Deno.env.get("GADF_CRON_SECRET")!;

async function embed(text: string): Promise<number[]> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "models/text-embedding-004",
        content: { parts: [{ text }] },
      }),
    },
  );
  if (!res.ok) throw new Error(`Embedding failed: ${await res.text()}`);
  const data = await res.json();
  return data.embedding.values as number[];
}

serve(async (req) => {
  const provided = req.headers.get("x-cron-secret");
  if (!CRON_SECRET || provided !== CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Service role — this is a system job that spans all users, so it must
  // bypass RLS by design (there's normally just the one user, but this
  // keeps the function correct if that ever changes).
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const since = new Date();
  since.setDate(since.getDate() - 1);
  const archiveDate = since.toISOString().slice(0, 10);

  const { data: recent, error: recentError } = await supabase
    .from("messages")
    .select("user_id")
    .gte("created_at", since.toISOString());

  if (recentError) {
    console.error("Failed to list recent messages:", recentError);
    return new Response(JSON.stringify({ error: "Failed to list recent messages" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const userIds = [...new Set((recent ?? []).map((r) => r.user_id as string))];

  for (const userId of userIds) {
    const { data: messages } = await supabase
      .from("messages")
      .select("role, content, created_at")
      .eq("user_id", userId)
      .gte("created_at", since.toISOString())
      .order("created_at", { ascending: true });

    if (!messages?.length) continue;

    const transcript = messages
      .map((m) => `[${m.created_at}] ${m.role}: ${m.content}`)
      .join("\n");

    await supabase.from("memory_archives").upsert(
      { user_id: userId, archive_date: archiveDate, content: transcript },
      { onConflict: "user_id,archive_date" },
    );

    const extractRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 1024,
        system:
          "Extract durable facts worth remembering long-term from this conversation transcript (preferences, plans, relationships, ongoing commitments). Skip small talk. Return a JSON array of short, self-contained fact strings, nothing else. If there is nothing worth remembering, return [].",
        messages: [{ role: "user", content: transcript }],
      }),
    });

    if (!extractRes.ok) {
      console.error("Extraction failed for user", userId, await extractRes.text());
      continue;
    }

    const extractData = await extractRes.json();
    const textBlock = extractData.content?.find(
      (block: { type: string; text?: string }) => block.type === "text",
    );
    const raw = textBlock?.text ?? "[]";

    let facts: string[] = [];
    try {
      facts = JSON.parse(raw);
    } catch {
      console.error("Could not parse extracted facts:", raw);
      continue;
    }

    for (const fact of facts) {
      try {
        const embedding = await embed(fact);
        await supabase.from("memories").insert({
          user_id: userId,
          content: fact,
          embedding,
          source: "compaction",
        });
      } catch (e) {
        console.error("Failed to store memory:", fact, e);
      }
    }
  }

  return new Response(JSON.stringify({ processedUsers: userIds.length }), {
    headers: { "Content-Type": "application/json" },
  });
});
