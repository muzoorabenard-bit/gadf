import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getGoogleAccessToken } from "./gadfCore.ts";

const LOG_FILE_NAME = "GADF SMS Log.txt";

// Best-effort mirror of raw SMS text into a single running text file in the
// user's own Drive, so it's visible/exportable outside the database. Never
// throws — a missing/expired Google connection or a transient Drive error
// must not block SMS ingestion, which is the primary job of the caller.
export async function appendSmsToDriveLog(supabase: SupabaseClient, userId: string, line: string): Promise<void> {
  try {
    const token = await getGoogleAccessToken(supabase, userId);
    if (!token) return;

    const { data: settings } = await supabase
      .from("financial_settings")
      .select("sms_log_drive_file_id")
      .eq("user_id", userId)
      .maybeSingle();

    let fileId: string | null = settings?.sms_log_drive_file_id ?? null;
    let existing = "";

    if (fileId) {
      const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) existing = await res.text();
      else if (res.status === 404) fileId = null;
    }

    const updated = existing + line + "\n";

    if (fileId) {
      await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/plain" },
        body: updated,
      });
      return;
    }

    const boundary = "gadfsmslogboundary";
    const metadata = { name: LOG_FILE_NAME, mimeType: "text/plain" };
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: text/plain\r\n\r\n${updated}\r\n--${boundary}--`;
    const createRes = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    });
    if (!createRes.ok) {
      console.error("Drive SMS log create failed:", await createRes.text());
      return;
    }
    const created = await createRes.json();
    await supabase
      .from("financial_settings")
      .upsert({ user_id: userId, sms_log_drive_file_id: created.id, updated_at: new Date().toISOString() });
  } catch (err) {
    console.error("Drive SMS log append failed (non-fatal):", err);
  }
}
