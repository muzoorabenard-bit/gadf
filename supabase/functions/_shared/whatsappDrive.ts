import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const FOLDER_NAME = "whatsapp messages";

export async function getOrCreateWhatsappFolder(
  supabase: SupabaseClient,
  userId: string,
  token: string,
  cachedFolderId: string | null,
): Promise<string | null> {
  if (cachedFolderId) return cachedFolderId;

  const q = encodeURIComponent(`name = '${FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
  const searchRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (searchRes.ok) {
    const { files } = await searchRes.json();
    if (files?.length) {
      const folderId = files[0].id as string;
      await supabase.from("financial_settings").upsert({ user_id: userId, whatsapp_folder_id: folderId, updated_at: new Date().toISOString() });
      return folderId;
    }
  }

  const createRes = await fetch("https://www.googleapis.com/drive/v3/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" }),
  });
  if (!createRes.ok) {
    console.error("Drive folder create failed:", await createRes.text());
    return null;
  }
  const created = await createRes.json();
  await supabase.from("financial_settings").upsert({ user_id: userId, whatsapp_folder_id: created.id, updated_at: new Date().toISOString() });
  return created.id as string;
}

async function readFileContent(token: string, fileId: string): Promise<{ content: string; missing: boolean }> {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.ok) return { content: await res.text(), missing: false };
  return { content: "", missing: res.status === 404 };
}

async function createContactFile(token: string, folderId: string | null, fileName: string, content: string): Promise<string | null> {
  const boundary = "gadfwhatsappfileboundary";
  const metadata: Record<string, unknown> = { name: fileName, mimeType: "text/plain" };
  if (folderId) metadata.parents = [folderId];
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: text/plain\r\n\r\n${content}\r\n--${boundary}--`;
  const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) {
    console.error("Drive contact file create failed:", await res.text());
    return null;
  }
  const created = await res.json();
  return created.id as string;
}

// Appends `lines` to a contact's Drive file (creating it in the "whatsapp
// messages" folder if it doesn't exist yet). Batched per contact per sync
// run rather than one Drive round trip per message.
export async function appendLinesToContactFile(
  supabase: SupabaseClient,
  token: string,
  folderId: string | null,
  contactId: string,
  cachedFileId: string | null,
  fileName: string,
  lines: string[],
): Promise<void> {
  if (lines.length === 0) return;

  let fileId = cachedFileId;
  let existing = "";

  if (fileId) {
    const { content, missing } = await readFileContent(token, fileId);
    if (missing) fileId = null;
    else existing = content;
  }

  const updated = existing + lines.join("\n") + "\n";

  if (fileId) {
    await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/plain" },
      body: updated,
    });
    return;
  }

  const newFileId = await createContactFile(token, folderId, fileName, updated);
  if (!newFileId) return;
  await supabase.from("whatsapp_contacts").update({ drive_file_id: newFileId, updated_at: new Date().toISOString() }).eq("id", contactId);
}
