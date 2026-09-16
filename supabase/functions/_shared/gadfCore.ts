import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  getAccountBalances,
  getIncomeExpense,
  calculateSafeToSpend,
  getCategorySpending,
  getBusinessFinancials,
  getProjectFinancials,
} from "./financeEngine.ts";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY")!;
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") ?? "";
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";

const DRIVE_CONTENT_LIMIT = 50_000;
const MAX_TOOL_ROUNDS = 5;
const CALENDAR_TIMEZONE = "Africa/Kampala";

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
      "Read a Drive file's content by its file ID. Google Docs/Sheets/Slides are exported as text/CSV/text; PDFs, Word/Excel/PowerPoint files (.doc/.docx/.xls/.xlsx/.ppt/.pptx), and images (JPEG/PNG/GIF/BMP/TIFF) are converted and OCR'd on the fly — for images this extracts any visible text, it does not describe the image (long scanned PDFs may come back truncated, since only the first ~10 pages get OCR'd); plain text, Markdown, JSON, HTML, and CSV are read directly.",
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
    // Drive can convert these into a Google-native copy on the fly — for PDFs
    // and images this also runs OCR, though only the first ~10 pages / a few
    // MB get OCR'd, so long scanned PDFs may come back truncated.
    const convertibleToGoogle: Record<string, string> = {
      "application/pdf": "application/vnd.google-apps.document",
      "application/msword": "application/vnd.google-apps.document",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "application/vnd.google-apps.document",
      "application/vnd.ms-excel": "application/vnd.google-apps.spreadsheet",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "application/vnd.google-apps.spreadsheet",
      "application/vnd.ms-powerpoint": "application/vnd.google-apps.presentation",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation": "application/vnd.google-apps.presentation",
      "image/jpeg": "application/vnd.google-apps.document",
      "image/png": "application/vnd.google-apps.document",
      "image/gif": "application/vnd.google-apps.document",
      "image/bmp": "application/vnd.google-apps.document",
      "image/tiff": "application/vnd.google-apps.document",
    };

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
    } else if (convertibleToGoogle[meta.mimeType]) {
      const targetMimeType = convertibleToGoogle[meta.mimeType];
      const copyRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/copy?fields=id`, {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ name: `gadf-temp-${meta.name}`, mimeType: targetMimeType }),
      });
      if (!copyRes.ok) {
        return { error: `Could not convert "${meta.name}" for reading (${copyRes.status}): ${await copyRes.text()}` };
      }
      const copy = await copyRes.json();
      try {
        contentRes = await fetch(
          `https://www.googleapis.com/drive/v3/files/${copy.id}/export?mimeType=${encodeURIComponent(exportMimeType[targetMimeType])}`,
          { headers: authHeaders },
        );
      } finally {
        await fetch(`https://www.googleapis.com/drive/v3/files/${copy.id}`, {
          method: "DELETE",
          headers: authHeaders,
        }).catch(() => {});
      }
    } else {
      return {
        error: `"${meta.name}" is a ${meta.mimeType} file, which gadf can't read yet.`,
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

const financeTools = [
  {
    name: "finance_summary",
    description:
      "Get aggregated totals of the user's mobile money transactions (money in, money out, fees, net) over a date range, optionally broken down by transaction type. Transactions are captured automatically from forwarded MTN Mobile Money SMS — the user never enters these manually.",
    input_schema: {
      type: "object",
      properties: {
        startDate: { type: "string", description: "ISO date, inclusive. Omit for all-time." },
        endDate: { type: "string", description: "ISO date, exclusive. Omit for up to now." },
      },
    },
  },
  {
    name: "finance_search_transactions",
    description: "List individual mobile money transactions matching filters, most recent first.",
    input_schema: {
      type: "object",
      properties: {
        startDate: { type: "string", description: "ISO date, inclusive" },
        endDate: { type: "string", description: "ISO date, exclusive" },
        counterparty: { type: "string", description: "Free-text match against the other party's name" },
        transactionType: { type: "string", enum: ["receive", "send", "payment", "withdraw", "deposit", "airtime", "other"] },
        limit: { type: "number", description: "Default 20" },
      },
    },
  },
  {
    name: "finance_safe_to_spend",
    description:
      "Calculate how much of the user's cash is genuinely discretionary right now: total cash across accounts, minus business/project funds, minus pending commitments, minus configured essential expenses and protected reserve. Returns every component of the calculation, not just the final number — always show the breakdown, not a bare figure.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "finance_account_balances",
    description: "Get the current balance of each of the user's financial accounts (e.g. each MTN Mobile Money number), as of their most recent transaction.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "finance_category_spending",
    description: "Get spending totals grouped by category over a date range, largest first.",
    input_schema: {
      type: "object",
      properties: {
        startDate: { type: "string", description: "ISO date, inclusive" },
        endDate: { type: "string", description: "ISO date, exclusive" },
      },
    },
  },
  {
    name: "finance_business_project_summary",
    description: "Get cash received/spent/position for each of the user's businesses and projects. Call this when asked about a specific business or project, or 'what's making money'. Labeled as cash position, not profit, since it isn't full accrual accounting.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "finance_add_commitment",
    description: "Record a known upcoming financial obligation (e.g. rent due, a bill) so it's accounted for in safe-to-spend and commitment totals.",
    input_schema: {
      type: "object",
      properties: {
        description: { type: "string" },
        amount: { type: "number" },
        dueDate: { type: "string", description: "ISO date, optional" },
      },
      required: ["description", "amount"],
    },
  },
  {
    name: "finance_add_receivable",
    description: "Record money someone owes the user, so it's tracked separately from cash they actually have.",
    input_schema: {
      type: "object",
      properties: {
        description: { type: "string" },
        amount: { type: "number" },
        counterparty: { type: "string" },
        expectedDate: { type: "string", description: "ISO date, optional" },
      },
      required: ["description", "amount", "counterparty"],
    },
  },
  {
    name: "finance_create_business",
    description: "Create a new business the user runs, so transactions can be allocated to it.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "finance_create_project",
    description: "Create a new project (optionally under a business), so transactions can be allocated to it.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        businessId: { type: "string", description: "Optional — id of the business this project belongs to" },
      },
      required: ["name"],
    },
  },
  {
    name: "finance_correct_transaction",
    description: "Correct a transaction's classification when the user tells you it's wrong — e.g. wrong category, actually a business expense, actually a transfer between their own accounts. Find the transaction first with finance_search_transactions if you don't already have its id.",
    input_schema: {
      type: "object",
      properties: {
        transactionId: { type: "string" },
        categoryName: { type: "string", description: "New category, existing or new" },
        purposeType: { type: "string", enum: ["personal", "business", "mixed", "unknown"] },
        businessId: { type: "string" },
        projectId: { type: "string" },
        isTransfer: { type: "boolean", description: "True if this is a transfer between the user's own accounts, not real income/expense" },
      },
      required: ["transactionId"],
    },
  },
  {
    name: "consult_lydia",
    description:
      "Ask Lydia, the user's financial analyst sub-agent, for a report on their current financial state — call this whenever the user asks how they're doing financially, or on a scheduled check-in. Lydia gathers the real numbers herself and returns a written analysis; relay/interpret her report in your own voice rather than just pasting it verbatim.",
    input_schema: { type: "object", properties: {} },
  },
];

async function runFinanceTool(
  name: string,
  input: Record<string, unknown>,
  supabase: SupabaseClient,
  userId: string,
): Promise<unknown> {
  if (name === "finance_summary") {
    let query = supabase
      .from("transactions")
      .select("transaction_type, amount, fee")
      .eq("user_id", userId)
      .eq("parse_status", "parsed");
    if (input.startDate) query = query.gte("occurred_at", String(input.startDate));
    if (input.endDate) query = query.lt("occurred_at", String(input.endDate));

    const { data, error } = await query;
    if (error) return { error: `Could not summarize transactions: ${error.message}` };

    const byType: Record<string, { count: number; total: number }> = {};
    let moneyIn = 0;
    let moneyOut = 0;
    let totalFees = 0;
    for (const t of data ?? []) {
      const type = t.transaction_type ?? "other";
      const amount = Number(t.amount) || 0;
      byType[type] = byType[type] ?? { count: 0, total: 0 };
      byType[type].count += 1;
      byType[type].total += amount;
      totalFees += Number(t.fee) || 0;
      if (type === "receive" || type === "deposit") moneyIn += amount;
      else if (type === "send" || type === "payment" || type === "withdraw" || type === "airtime") moneyOut += amount;
    }

    return { moneyIn, moneyOut, net: moneyIn - moneyOut, totalFees, byType, transactionCount: data?.length ?? 0 };
  }

  if (name === "finance_search_transactions") {
    let query = supabase
      .from("transactions")
      .select("transaction_type, amount, currency, counterparty, fee, balance_after, occurred_at, raw_sms")
      .eq("user_id", userId)
      .eq("parse_status", "parsed")
      .order("occurred_at", { ascending: false })
      .limit(Number(input.limit) || 20);
    if (input.startDate) query = query.gte("occurred_at", String(input.startDate));
    if (input.endDate) query = query.lt("occurred_at", String(input.endDate));
    if (input.transactionType) query = query.eq("transaction_type", String(input.transactionType));
    if (input.counterparty) query = query.ilike("counterparty", `%${input.counterparty}%`);

    const { data, error } = await query;
    if (error) return { error: `Could not search transactions: ${error.message}` };
    return { transactions: data };
  }

  if (name === "finance_safe_to_spend") {
    return await calculateSafeToSpend(supabase, userId);
  }

  if (name === "finance_account_balances") {
    return { accounts: await getAccountBalances(supabase, userId) };
  }

  if (name === "finance_category_spending") {
    const categories = await getCategorySpending(
      supabase,
      userId,
      input.startDate ? String(input.startDate) : undefined,
      input.endDate ? String(input.endDate) : undefined,
    );
    return { categories };
  }

  if (name === "finance_business_project_summary") {
    const [businesses, projects] = await Promise.all([
      getBusinessFinancials(supabase, userId),
      getProjectFinancials(supabase, userId),
    ]);
    return { businesses, projects };
  }

  if (name === "finance_add_commitment") {
    const { data, error } = await supabase
      .from("commitments")
      .insert({
        user_id: userId,
        description: String(input.description),
        amount: Number(input.amount),
        due_date: input.dueDate ? String(input.dueDate) : null,
      })
      .select("id")
      .single();
    if (error) return { error: `Could not add commitment: ${error.message}` };
    return { added: true, commitmentId: data.id };
  }

  if (name === "finance_add_receivable") {
    const { data, error } = await supabase
      .from("receivables")
      .insert({
        user_id: userId,
        description: String(input.description),
        amount: Number(input.amount),
        counterparty: String(input.counterparty),
        expected_date: input.expectedDate ? String(input.expectedDate) : null,
      })
      .select("id")
      .single();
    if (error) return { error: `Could not add receivable: ${error.message}` };
    return { added: true, receivableId: data.id };
  }

  if (name === "finance_create_business") {
    const { data, error } = await supabase
      .from("businesses")
      .insert({ user_id: userId, name: String(input.name) })
      .select("id")
      .single();
    if (error) return { error: `Could not create business: ${error.message}` };
    return { created: true, businessId: data.id };
  }

  if (name === "finance_create_project") {
    const { data, error } = await supabase
      .from("projects")
      .insert({ user_id: userId, name: String(input.name), business_id: input.businessId ? String(input.businessId) : null })
      .select("id")
      .single();
    if (error) return { error: `Could not create project: ${error.message}` };
    return { created: true, projectId: data.id };
  }

  if (name === "finance_correct_transaction") {
    // deno-lint-ignore no-explicit-any
    const update: Record<string, any> = {};
    if (input.purposeType) update.purpose_type = input.purposeType;
    if (input.businessId) update.business_id = input.businessId;
    if (input.projectId) update.project_id = input.projectId;
    if (typeof input.isTransfer === "boolean") update.is_transfer = input.isTransfer;

    if (input.categoryName) {
      const { data: existing } = await supabase
        .from("categories")
        .select("id")
        .eq("user_id", userId)
        .ilike("name", String(input.categoryName))
        .limit(1)
        .maybeSingle();
      if (existing) {
        update.category_id = existing.id;
      } else {
        const { data: created, error: catError } = await supabase
          .from("categories")
          .insert({ user_id: userId, name: String(input.categoryName), kind: input.purposeType === "business" ? "business" : "personal" })
          .select("id")
          .single();
        if (catError) return { error: `Could not create category: ${catError.message}` };
        update.category_id = created.id;
      }
    }

    if (Object.keys(update).length === 0) return { error: "Nothing to update — provide at least one field to correct" };

    const { error } = await supabase
      .from("transactions")
      .update(update)
      .eq("id", String(input.transactionId))
      .eq("user_id", userId);
    if (error) return { error: `Could not correct transaction: ${error.message}` };
    return { corrected: true };
  }

  if (name === "consult_lydia") {
    return { report: await consultLydia(supabase, userId) };
  }

  return { error: `Unknown tool ${name}` };
}

async function consultLydia(supabase: SupabaseClient, userId: string): Promise<string> {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const [balances, monthActivity, safeToSpend, categorySpending, businessProjects, commitmentsTotal, receivablesTotal, recentTx] =
    await Promise.all([
      getAccountBalances(supabase, userId),
      getIncomeExpense(supabase, userId, monthStart),
      calculateSafeToSpend(supabase, userId),
      getCategorySpending(supabase, userId, monthStart),
      Promise.all([getBusinessFinancials(supabase, userId), getProjectFinancials(supabase, userId)]),
      supabase.from("commitments").select("description, amount, due_date").eq("user_id", userId).eq("status", "pending"),
      supabase.from("receivables").select("description, amount, counterparty, expected_date").eq("user_id", userId).eq("status", "pending"),
      supabase
        .from("transactions")
        .select("transaction_type, amount, counterparty, occurred_at")
        .eq("user_id", userId)
        .eq("parse_status", "parsed")
        .order("occurred_at", { ascending: false })
        .limit(10),
    ]);

  const financialState = {
    asOf: now.toISOString(),
    accountBalances: balances,
    thisMonth: monthActivity,
    safeToSpend,
    categorySpendingThisMonth: categorySpending,
    businesses: businessProjects[0],
    projects: businessProjects[1],
    pendingCommitments: commitmentsTotal.data ?? [],
    pendingReceivables: receivablesTotal.data ?? [],
    recentTransactions: recentTx.data ?? [],
  };

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 1024,
      system: [
        "You are Lydia, a personal financial analyst. You report to G.A.D.F (gadf), who relays your analysis to the user — you never talk to the user directly.",
        "You are calm, factual, concise, and non-judgmental. State what changed and by how much rather than passing judgment (\"transport spending rose from X to Y\", not \"you were irresponsible\"). No exclamation marks, no emoji, no congratulations.",
        "Every number in the JSON below was already calculated deterministically from real transaction data — you are not doing arithmetic, only explaining it. Never invent a figure, transaction, balance, client, or commitment that isn't in this data. If something needed to answer well isn't present, say so plainly rather than guessing.",
        "Cover, briefly: current cash position, this month's income/expense/net, safe-to-spend (with its components, not just the final number), notable category spending, any business/project activity, pending commitments and receivables, and anything that stands out.",
        `Financial state:\n${JSON.stringify(financialState, null, 2)}`,
      ].join("\n\n"),
      messages: [{ role: "user", content: "Give me your current report." }],
    }),
  });

  if (!res.ok) {
    console.error("Lydia consult failed:", await res.text());
    return "I tried to consult Lydia but the call to her failed — try again in a moment.";
  }
  const data = await res.json();
  const textBlock = (data.content ?? []).find((b: { type: string; text?: string }) => b.type === "text");
  return textBlock?.text ?? "Lydia didn't return a report this time.";
}

// ── Shared core — used by both the web chat function and the WhatsApp webhook ──

export type GadfResult = { reply: string } | { error: string; status: number };

export async function handleGadfMessage(
  supabase: SupabaseClient,
  userId: string,
  message: string,
  channel: string,
): Promise<GadfResult> {
  // One continuous conversation per user, shared across every channel
  // (web, watch, WhatsApp) — context doesn't reset by device.
  const { data: existingConv } = await supabase
    .from("conversations")
    .select("id")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  let conversationId = existingConv?.id as string | undefined;
  if (!conversationId) {
    const { data: created, error: createError } = await supabase
      .from("conversations")
      .insert({ user_id: userId, channel, title: "G.A.D.F" })
      .select("id")
      .single();
    if (createError) {
      console.error("Failed to create conversation:", createError);
      return { error: "Could not start a conversation", status: 500 };
    }
    conversationId = created.id as string;
  }

  await supabase.from("messages").insert({
    conversation_id: conversationId,
    user_id: userId,
    role: "user",
    content: message,
    channel,
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
    channel === "whatsapp"
      ? "This message came in over WhatsApp — keep replies concise and readable on a phone screen; avoid long tables or heavy markdown."
      : "",
    "For anything financial, you work with Lydia, the user's financial analyst — call consult_lydia and relay/interpret her report rather than just pasting it. Transactions themselves are captured automatically from mobile money SMS forwarded off the user's phones; you have no way to record a transaction yourself. You can use finance_summary/finance_search_transactions/finance_account_balances/finance_safe_to_spend/finance_category_spending/finance_business_project_summary directly for quick lookups without going through Lydia when that's simpler. You can also finance_add_commitment, finance_add_receivable, finance_create_business, finance_create_project, and finance_correct_transaction when the user tells you about an obligation, money owed to them, a new business/project, or that a transaction was misclassified. Some messages may fail to parse, so a gap in the numbers may mean an unparsed message, not that nothing happened — mention that possibility if a total looks off rather than stating it with full confidence.",
    "You do not yet have tool access to email, contacts, or maps, and you can't send a WhatsApp message on your own initiative (only reply to one) — that arrives in a later build phase. If asked to perform one of those actions, say so plainly instead of pretending to do it.",
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
        tools: [...googleTools, ...codingTools, ...financeTools],
      }),
    });

    if (!anthropicRes.ok) {
      console.error("Anthropic error:", await anthropicRes.text());
      return { error: "Assistant call failed", status: 502 };
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
      const isCodingTool = toolUse.name === "queue_coding_task";
      const isFinanceTool = toolUse.name.startsWith("finance_") || toolUse.name === "consult_lydia";
      const result = isCodingTool
        ? await runCodingTool(toolUse.name, toolUse.input, supabase, userId)
        : isFinanceTool
        ? await runFinanceTool(toolUse.name, toolUse.input, supabase, userId)
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
    channel,
  });

  return { reply };
}
