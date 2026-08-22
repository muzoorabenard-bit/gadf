import "dotenv/config";
import path from "node:path";
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { query } from "@anthropic-ai/claude-agent-sdk";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!;
const GADF_EMAIL = process.env.GADF_EMAIL!;
const GADF_PASSWORD = process.env.GADF_PASSWORD!;
const GITHUB_ROOT = path.resolve(process.env.GITHUB_ROOT!);
const POLL_INTERVAL_MS = 10_000;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !GADF_EMAIL || !GADF_PASSWORD || !process.env.GITHUB_ROOT) {
  console.error("Missing required env vars — copy .env.example to .env and fill it in.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

interface CodingTask {
  id: string;
  repo: string;
  instructions: string;
}

// Resolves a bare repo name to an absolute path, refusing anything that
// would escape GITHUB_ROOT (e.g. "../../Windows") or doesn't exist.
function resolveRepoPath(repo: string): string | null {
  const candidate = path.resolve(GITHUB_ROOT, repo);
  const withinRoot = candidate === GITHUB_ROOT || candidate.startsWith(GITHUB_ROOT + path.sep);
  if (!withinRoot) return null;
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) return null;
  return candidate;
}

async function postResultMessage(userId: string, text: string) {
  const { data: conv } = await supabase
    .from("conversations")
    .select("id")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  let conversationId = conv?.id as string | undefined;
  if (!conversationId) {
    const { data: created, error } = await supabase
      .from("conversations")
      .insert({ user_id: userId, channel: "coding-agent", title: "G.A.D.F" })
      .select("id")
      .single();
    if (error) {
      console.error("Could not create a conversation to post the result into:", error);
      return;
    }
    conversationId = created.id as string;
  }

  await supabase.from("messages").insert({
    conversation_id: conversationId,
    user_id: userId,
    role: "assistant",
    content: text,
    channel: "coding-agent",
  });
}

async function runTask(task: CodingTask, userId: string) {
  console.log(`\n[${new Date().toISOString()}] Starting task ${task.id} on repo "${task.repo}"`);

  await supabase.from("coding_tasks").update({ status: "running", updated_at: new Date().toISOString() }).eq("id", task.id);

  const repoPath = resolveRepoPath(task.repo);
  if (!repoPath) {
    const reason = `Repo "${task.repo}" is not a valid, existing folder under ${GITHUB_ROOT}.`;
    console.error(reason);
    await supabase
      .from("coding_tasks")
      .update({ status: "failed", result_summary: reason, updated_at: new Date().toISOString() })
      .eq("id", task.id);
    await postResultMessage(userId, `I couldn't start that coding task: ${reason}`);
    return;
  }

  const prompt = [
    task.instructions,
    "",
    "When the work is complete and correct, stage, commit, and push the changes yourself (git add, git commit with a clear message, git push) — do not leave it uncommitted.",
  ].join("\n");

  try {
    let resultText = "";
    let succeeded = false;

    for await (const message of query({
      prompt,
      options: {
        cwd: repoPath,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
      },
    })) {
      if (message.type === "result") {
        if (message.subtype === "success" && !message.is_error) {
          succeeded = true;
          resultText = message.result;
        } else {
          succeeded = false;
          resultText = `${message.subtype} (stop_reason: ${message.stop_reason ?? "unknown"})`;
        }
      }
    }

    if (succeeded) {
      console.log(`Task ${task.id} completed.`);
      await supabase
        .from("coding_tasks")
        .update({ status: "completed", result_summary: resultText, updated_at: new Date().toISOString() })
        .eq("id", task.id);
      await postResultMessage(userId, `Done — "${task.repo}": ${resultText}`);
    } else {
      console.error(`Task ${task.id} failed:`, resultText);
      await supabase
        .from("coding_tasks")
        .update({ status: "failed", result_summary: resultText || "Unknown error", updated_at: new Date().toISOString() })
        .eq("id", task.id);
      await postResultMessage(userId, `I ran into a problem with that coding task on "${task.repo}": ${resultText || "unknown error"}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Task ${task.id} threw:`, err);
    await supabase
      .from("coding_tasks")
      .update({ status: "failed", result_summary: message, updated_at: new Date().toISOString() })
      .eq("id", task.id);
    await postResultMessage(userId, `That coding task on "${task.repo}" hit an error: ${message}`);
  }
}

async function main() {
  const { data, error } = await supabase.auth.signInWithPassword({ email: GADF_EMAIL, password: GADF_PASSWORD });
  if (error || !data.user) {
    console.error("Sign-in failed:", error?.message);
    process.exit(1);
  }
  const userId = data.user.id;
  console.log(`Signed in as ${GADF_EMAIL}. Watching for coding tasks under ${GITHUB_ROOT} every ${POLL_INTERVAL_MS / 1000}s.`);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const { data: pending, error: fetchError } = await supabase
        .from("coding_tasks")
        .select("id, repo, instructions")
        .eq("status", "pending")
        .order("created_at", { ascending: true })
        .limit(1);

      if (fetchError) {
        console.error("Failed to poll for tasks:", fetchError.message);
      } else if (pending && pending.length > 0) {
        await runTask(pending[0] as CodingTask, userId);
      }
    } catch (err) {
      console.error("Poll loop error:", err);
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

main();
