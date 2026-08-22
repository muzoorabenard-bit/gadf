import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/contexts/AuthContext";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: string;
}

export function useChat() {
  const { session } = useAuth();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // There's one continuous conversation per user, shared across every
  // channel (web, watch, WhatsApp/SMS later) — gadf-chat resolves/creates it
  // server-side, so this just loads whatever history already exists to
  // display it, including messages sent from other devices.
  useEffect(() => {
    if (!session?.user) return;

    async function loadHistory() {
      const { data: existingConv } = await supabase
        .from("conversations")
        .select("id")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();

      if (!existingConv) return;

      const { data: existingMessages } = await supabase
        .from("messages")
        .select("id, role, content, created_at")
        .eq("conversation_id", existingConv.id)
        .order("created_at", { ascending: true });

      setMessages((existingMessages ?? []) as ChatMessage[]);
    }

    loadHistory();
  }, [session]);

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim()) return null;
    setSending(true);
    setError(null);

    setMessages((prev) => [
      ...prev,
      { id: `local-${Date.now()}`, role: "user", content: text, created_at: new Date().toISOString() },
    ]);

    try {
      const { data, error: invokeError } = await supabase.functions.invoke("gadf-chat", {
        body: { message: text, channel: "web" },
      });

      if (invokeError) throw invokeError;

      const reply = data?.reply ?? "";
      setMessages((prev) => [
        ...prev,
        { id: `local-${Date.now()}-r`, role: "assistant", content: reply, created_at: new Date().toISOString() },
      ]);
      return reply as string;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to reach G.A.D.F");
      return null;
    } finally {
      setSending(false);
    }
  }, []);

  return { messages, sendMessage, sending, error };
}
