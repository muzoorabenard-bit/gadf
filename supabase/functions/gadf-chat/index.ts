import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY")!;
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") ?? "";
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";

const DRIVE_CONTENT_LIMIT = 50_000;
const MAX_TOOL_ROUNDS = 5;
const CALENDAR_TIMEZONE = "Africa/Kampala";

interface ChatRequest {
  message: string;
  channel?: string;
}

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

// ── Google Drive ─────────────────────────────────────────────────────────

async function getGoogleAccessToken(supabase: SupabaseClient, userId: string): Promise<string | null> {
  const { data: tokenRow } = await supabase
    .from("google_tokens")
    .select("access_token, refresh_token, expires_at")
    .eq("user_id", userId)
    .maybeSingle();

  if (!tokenRow) return null;

  if (new Date(tokenRow.expires_at).getTime() > Date.now() + 60_000) {
    return tokenRow.access_token;
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: tokenRow.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    console.error("Google token refresh failed:", await res.text());
    return null;
  }

  const data = await res.json();
  const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
  await supabase
    .from("google_tokens")
    .update({ access_token: data.access_token, expires_at: expiresAt, updated_at: new Date().toISOString() })
    .eq("user_id", userId);

  return data.access_token as string;
}

const googleTools = [
  {
    name: "drive_search",
    description: "Search the user's Google Drive by file name or content, optionally scoped to inside one folder.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search text" },
        folderId: { type: "string", description: "Restrict the search to inside this folder's ID (optional — omit to search all of Drive)" },
      },
      required: ["query"],
    },
  },
  {
    name: "drive_list_folder",
    description:
      "List the files and subfolders directly inside a Drive folder, newest changes first. Use drive_search first to find a folder's ID by name if you don't already have it.",
    input_schema: {
      type: "object",
      properties: {
        folderId: { type: "string", description: "The folder's Drive file ID. Omit to list the top level of My Drive." },
      },
    },
  },
  {
    name: "drive_read_file",
    description:
      "Read a Drive file's content by its file ID. Google Docs, Sheets, and Slides are exported as text/CSV/text; plain text, Markdown, JSON, HTML, and CSV files are read directly. PDFs, Word/Excel/PowerPoint (.docx/.xlsx/.pptx), images, and other binary formats aren't supported yet — trying to read one returns an error instead of garbled content.",
    input_schema: {
      type: "object",
      properties: { fileId: { type: "string" } },
      required: ["fileId"],
    },
  },
  {
    name: "drive_write_file",
    description:
      "Create a new plain-text file in Drive, or overwrite an existing one if fileId is given.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        content: { type: "string" },
        fileId: { type: "string", description: "Omit to create a new file" },
        folderId: { type: "string", description: "Parent folder for a new file (optional)" },
      },
      required: ["name", "content"],
    },
  },
  {
    name: "drive_delete_file",
    description: "Move a Drive file to Trash by its file ID.",
    input_schema: {
      type: "object",
      properties: { fileId: { type: "string" } },
      required: ["fileId"],
    },
  },
  {
    name: "calendar_list_events",
    description:
      "List the user's upcoming Google Calendar events. Omit timeMin/timeMax for the next 15 upcoming events.",
    input_schema: {
      type: "object",
      properties: {
        timeMin: { type: "string", description: "RFC3339 datetime, inclusive lower bound" },
        timeMax: { type: "string", description: "RFC3339 datetime, exclusive upper bound" },
        query: { type: "string", description: "Free-text search over event titles/descriptions" },
      },
    },
  },
  {
    name: "calendar_create_event",
    description: `Create a calendar event. Times are interpreted in ${CALENDAR_TIMEZONE} unless the datetime string includes its own timezone offset.`,
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        startDateTime: { type: "string", description: "RFC3339, e.g. 2026-08-25T14:00:00" },
        endDateTime: { type: "string", description: "RFC3339, e.g. 2026-08-25T15:00:00" },
        description: { type: "string" },
        location: { type: "string" },
      },
      required: ["summary", "startDateTime", "endDateTime"],
    },
  },
  {
    name: "calendar_update_event",
    description: "Update fields on an existing calendar event. Only the fields provided are changed.",
    input_schema: {
      type: "object",
      properties: {
        eventId: { type: "string" },
        summary: { type: "string" },
        startDateTime: { type: "string" },
        endDateTime: { type: "string" },
        description: { type: "string" },
        location: { type: "string" },
      },
      required: ["eventId"],
    },
  },
  {
    name: "calendar_delete_event",
    description: "Permanently cancel/delete a calendar event by its event ID. There is no undo.",
    input_schema: {
      type: "object",
      properties: { eventId: { type: "string" } },
      required: ["eventId"],
    },
  },
];

async function runGoogleTool(
  name: string,
  input: Record<string, unknown>,
  supabase: SupabaseClient,
  userId: string,
): Promise<unknown> {
  const accessToken = await getGoogleAccessToken(supabase, userId);
  if (!accessToken) {
    return { error: "Google isn't connected yet — tell the user to connect it from the website." };
  }
  const authHeaders = { Authorization: `Bearer ${accessToken}` };

  if (name === "drive_search") {
    const term = String(input.query).replace(/'/g, "\\'");
    let q = `(fullText contains '${term}' or name contains '${term}') and trashed = false`;
    if (input.folderId) q += ` and '${String(input.folderId).replace(/'/g, "\\'")}' in parents`;
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,modifiedTime)&pageSize=15`,
      { headers: authHeaders },
    );
    if (!res.ok) return { error: `Drive search failed (${res.status})` };
    return await res.json();
  }

  if (name === "drive_list_folder") {
    const parent = input.folderId ? String(input.folderId).replace(/'/g, "\\'") : "root";
    const q = `'${parent}' in parents and trashed = false`;
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,modifiedTime)&pageSize=100&orderBy=folder,name`,
      { headers: authHeaders },
    );
    if (!res.ok) return { error: `Folder listing failed (${res.status})` };
    return await res.json();
  }

  if (name === "drive_read_file") {
    const fileId = String(input.fileId);
    const metaRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType`,
      { headers: authHeaders },
    );
    if (!metaRes.ok) return { error: `Could not read file metadata (${metaRes.status})` };
    const meta = await metaRes.json();

    const exportMimeType: Record<string, string> = {
      "application/vnd.google-apps.document": "text/plain",
      "application/vnd.google-apps.spreadsheet": "text/csv",
      "application/vnd.google-apps.presentation": "text/plain",
    };
    const readableDirectly = new Set([
      "text/plain",
      "text/markdown",
      "text/csv",
      "text/html",
      "application/json",
    ]);

    let contentRes: Response;
    if (exportMimeType[meta.mimeType]) {
      contentRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(exportMimeType[meta.mimeType])}`,
        { headers: authHeaders },
      );
    } else if (readableDirectly.has(meta.mimeType)) {
      contentRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
        { headers: authHeaders },
      );
    } else {
      return {
        error: `"${meta.name}" is a ${meta.mimeType} file. gadf can currently only read Google Docs/Sheets/Slides and plain text/Markdown/CSV/JSON/HTML files — not PDFs, Word/Excel/PowerPoint files, images, or other binary formats.`,
      };
    }
    if (!contentRes.ok) return { error: `Could not read file content (${contentRes.status})` };
    const text = await contentRes.text();
    return {
      name: meta.name,
      mimeType: meta.mimeType,
      content: text.slice(0, DRIVE_CONTENT_LIMIT),
      truncated: text.length > DRIVE_CONTENT_LIMIT,
    };
  }

  if (name === "drive_write_file") {
    const fileId = input.fileId ? String(input.fileId) : null;
    const name_ = String(input.name);
    const content = String(input.content);
    const boundary = "gadf-drive-boundary";
    const metadata = fileId ? { name: name_ } : { name: name_, parents: input.folderId ? [String(input.folderId)] : undefined };
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: text/plain\r\n\r\n${content}\r\n--${boundary}--`;

    const url = fileId
      ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`
      : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`;

    const res = await fetch(url, {
      method: fileId ? "PATCH" : "POST",
      headers: { ...authHeaders, "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    });
    if (!res.ok) return { error: `Drive write failed (${res.status}): ${await res.text()}` };
    return await res.json();
  }

  if (name === "drive_delete_file") {
    const fileId = String(input.fileId);
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
      method: "PATCH",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ trashed: true }),
    });
    if (!res.ok) return { error: `Drive delete failed (${res.status})` };
    return { trashed: true };
  }

  if (name === "calendar_list_events") {
    const params = new URLSearchParams({
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "15",
      timeMin: input.timeMin ? String(input.timeMin) : new Date().toISOString(),
    });
    if (input.timeMax) params.set("timeMax", String(input.timeMax));
    if (input.query) params.set("q", String(input.query));
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`,
      { headers: authHeaders },
    );
    if (!res.ok) return { error: `Calendar list failed (${res.status})` };
    const data = await res.json();
    return {
      events: (data.items ?? []).map((e: { id: string; summary?: string; start?: unknown; end?: unknown; location?: string }) => ({
        id: e.id,
        summary: e.summary,
        start: e.start,
        end: e.end,
        location: e.location,
      })),
    };
  }

  if (name === "calendar_create_event") {
    const body = {
      summary: String(input.summary),
      description: input.description ? String(input.description) : undefined,
      location: input.location ? String(input.location) : undefined,
      start: { dateTime: String(input.startDateTime), timeZone: CALENDAR_TIMEZONE },
      end: { dateTime: String(input.endDateTime), timeZone: CALENDAR_TIMEZONE },
    };
    const res = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { error: `Calendar create failed (${res.status}): ${await res.text()}` };
    return await res.json();
  }

  if (name === "calendar_update_event") {
    const eventId = String(input.eventId);
    // deno-lint-ignore no-explicit-any
    const body: Record<string, any> = {};
    if (input.summary) body.summary = String(input.summary);
    if (input.description) body.description = String(input.description);
    if (input.location) body.location = String(input.location);
    if (input.startDateTime) body.start = { dateTime: String(input.startDateTime), timeZone: CALENDAR_TIMEZONE };
    if (input.endDateTime) body.end = { dateTime: String(input.endDateTime), timeZone: CALENDAR_TIMEZONE };

    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`,
      {
        method: "PATCH",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) return { error: `Calendar update failed (${res.status}): ${await res.text()}` };
    return await res.json();
  }

  if (name === "calendar_delete_event") {
    const eventId = String(input.eventId);
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`,
      { method: "DELETE", headers: authHeaders },
    );
    if (!res.ok && res.status !== 410) return { error: `Calendar delete failed (${res.status})` };
    return { deleted: true };
  }

  return { error: `Unknown tool ${name}` };
}

const codingTools = [
  {
    name: "queue_coding_task",
    description:
      "Hand off a real coding task to the local coding agent on the user's PC, which will write the code, commit, and push it. Only call this once you're confident you understand exactly what's wanted — ask clarifying questions in normal conversation first if anything is ambiguous (repo, scope, behavior). The coding agent has no memory of this conversation, so `instructions` must be a complete, self-contained brief.",
    input_schema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Folder name under the user's GitHub directory, e.g. 'gadf' or 'buildableug'" },
        instructions: { type: "string", description: "Complete, self-contained task description — the executing agent sees only this, not the chat history" },
      },
      required: ["repo", "instructions"],
    },
  },
];

async function runCodingTool(
  name: string,
  input: Record<string, unknown>,
  supabase: SupabaseClient,
  userId: string,
): Promise<unknown> {
  if (name === "queue_coding_task") {
    const { data, error } = await supabase
      .from("coding_tasks")
      .insert({
        user_id: userId,
        repo: String(input.repo),
        instructions: String(input.instructions),
      })
      .select("id")
      .single();
    if (error) return { error: `Could not queue the task: ${error.message}` };
    return { queued: true, taskId: data.id };
  }

  return { error: `Unknown tool ${name}` };
}

// ── Main handler ─────────────────────────────────────────────────────────

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

    // RLS-scoped client — every query below only ever touches this user's rows.
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
    const userId = userData.user.id;

    const { message, channel }: ChatRequest = await req.json();
    if (!message) {
      return new Response(
        JSON.stringify({ error: "message is required" }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } },
      );
    }

    // One continuous conversation per user, shared across every channel
    // (web, watch, WhatsApp/SMS later) — context doesn't reset by device.
    const { data: existingConv } = await supabase
      .from("conversations")
      .select("id")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    let conversationId = existingConv?.id as string | undefined;
    if (!conversationId) {
      const { data: created, error: createError } = await supabase
        .from("conversations")
        .insert({ user_id: userId, channel: channel ?? "web", title: "G.A.D.F" })
        .select("id")
        .single();
      if (createError) {
        console.error("Failed to create conversation:", createError);
        return new Response(JSON.stringify({ error: "Could not start a conversation" }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      conversationId = created.id as string;
    }

    await supabase.from("messages").insert({
      conversation_id: conversationId,
      user_id: userId,
      role: "user",
      content: message,
      channel: channel ?? "web",
    });

    // Tier 1 — identity facts (small, static, always included)
    const { data: facts } = await supabase
      .from("identity_facts")
      .select("key, value")
      .eq("user_id", userId);
    const identityBlock = (facts ?? []).map((f) => `${f.key}: ${f.value}`).join("\n");

    // Tier 3 — only the top-K relevant long-term memories, not the whole store
    let memoryBlock = "";
    try {
      const queryEmbedding = await embed(message);
      const { data: memories } = await supabase.rpc("match_memories", {
        query_embedding: queryEmbedding,
        match_user_id: userId,
        match_count: 5,
      });
      if (memories?.length) {
        memoryBlock = memories.map((m: { content: string }) => `- ${m.content}`).join("\n");
      }
    } catch (embedErr) {
      console.error("Memory retrieval skipped:", embedErr);
    }

    // Tier 2 — recent working memory for this conversation
    const { data: recentMessages } = await supabase
      .from("messages")
      .select("role, content")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(20);

    const history = (recentMessages ?? [])
      .reverse()
      .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }));

    const googleConnected = Boolean(GOOGLE_CLIENT_ID) && (await getGoogleAccessToken(supabase, userId)) !== null;

    const now = new Date();
    const nowReadable = now.toLocaleString("en-US", {
      timeZone: CALENDAR_TIMEZONE,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });

    const systemPrompt = [
      "You are G.A.D.F (Grace and Daddy Forever), a personal assistant with a warm, direct, loyal personality.",
      `Current date/time: ${nowReadable} (${CALENDAR_TIMEZONE}). ISO: ${now.toISOString()}. Use this as "now" for anything relative — today, tomorrow, next week, in an hour, etc. — including when calling calendar tools.`,
      identityBlock ? `Known facts about the user:\n${identityBlock}` : "",
      memoryBlock ? `Relevant memories:\n${memoryBlock}` : "",
      googleConnected
        ? "You have full read/write access to the user's Google Drive and Google Calendar via the drive_* and calendar_* tools. Drive deletes move files to Trash (recoverable); calendar_delete_event is permanent with no undo — be reasonably sure before calling it, but you do not need to ask the user for confirmation first for either."
        : "Google Drive and Calendar aren't connected yet. If asked to do something with either, tell the user to connect Google from the website.",
      "You have a queue_coding_task tool that hands real coding work off to a local agent on the user's PC — it writes the code, commits, and pushes, fully autonomously, no review step. Because of that: (1) if a request is at all ambiguous — which repo, what exactly should change, what \"done\" looks like — ask clarifying questions as a normal reply instead of calling the tool; never queue a half-understood task. (2) Once you do have enough clarity, write the `instructions` field as a complete, self-contained brief — the coding agent that receives it has no access to this conversation, only that string. (3) After queuing, tell the user it's in progress, not finished — the result comes back as a later message once the local agent completes it.",
      "You do not yet have tool access to email, WhatsApp, contacts, SMS, or maps — that arrives in a later build phase. If asked to perform one of those actions, say so plainly instead of pretending to do it.",
    ]
      .filter(Boolean)
      .join("\n\n");

    // deno-lint-ignore no-explicit-any
    const messages: any[] = [...history];
    let reply = "";

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-5",
          max_tokens: 1024,
          system: systemPrompt,
          messages,
          tools: [...googleTools, ...codingTools],
        }),
      });

      if (!anthropicRes.ok) {
        console.error("Anthropic error:", await anthropicRes.text());
        return new Response(JSON.stringify({ error: "Assistant call failed" }), {
          status: 502,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const anthropicData = await anthropicRes.json();
      const content = anthropicData.content ?? [];
      const toolUseBlocks = content.filter((b: { type: string }) => b.type === "tool_use");

      if (anthropicData.stop_reason !== "tool_use" || toolUseBlocks.length === 0) {
        const textBlock = content.find((b: { type: string; text?: string }) => b.type === "text");
        reply = textBlock?.text ?? "";
        break;
      }

      messages.push({ role: "assistant", content });

      const toolResults = [];
      for (const toolUse of toolUseBlocks) {
        const result = toolUse.name === "queue_coding_task"
          ? await runCodingTool(toolUse.name, toolUse.input, supabase, userId)
          : await runGoogleTool(toolUse.name, toolUse.input, supabase, userId);
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify(result),
        });
      }
      messages.push({ role: "user", content: toolResults });
    }

    await supabase.from("messages").insert({
      conversation_id: conversationId,
      user_id: userId,
      role: "assistant",
      content: reply,
      channel: channel ?? "web",
    });

    return new Response(JSON.stringify({ reply }), {
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (err) {
    console.error("gadf-chat error:", err);
    return new Response(JSON.stringify({ error: "Internal error" }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
});
