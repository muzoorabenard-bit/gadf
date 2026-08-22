import { useEffect, useRef, useState, type FormEvent } from "react";
import { Mic, Send, Volume2, LogOut, HardDrive } from "lucide-react";
import { useChat } from "@/hooks/useChat";
import { useVoice } from "@/hooks/useVoice";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/lib/supabaseClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/calendar",
].join(" ");

function connectGoogleUrl(userId: string) {
  const params = new URLSearchParams({
    client_id: import.meta.env.VITE_GOOGLE_CLIENT_ID,
    redirect_uri: `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/gadf-google-auth-callback`,
    response_type: "code",
    scope: GOOGLE_SCOPES,
    access_type: "offline",
    prompt: "consent",
    state: userId,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export default function Chat() {
  const { messages, sendMessage, sending, error } = useChat();
  const { supported: voiceSupported, listening, speaking, listen, speak } = useVoice();
  const { session, signOut } = useAuth();
  const [draft, setDraft] = useState("");
  const [voiceReplies, setVoiceReplies] = useState(false);
  const [googleConnected, setGoogleConnected] = useState<boolean | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!session?.user) return;

    async function checkGoogleConnection() {
      const { data } = await supabase.from("google_tokens").select("id").maybeSingle();
      setGoogleConnected(Boolean(data));
    }

    const params = new URLSearchParams(window.location.search);
    if (params.has("google")) {
      window.history.replaceState({}, "", window.location.pathname);
    }

    checkGoogleConnection();
  }, [session]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    const reply = await sendMessage(text);
    if (reply && voiceReplies) speak(reply);
  }

  async function handleMic() {
    try {
      const transcript = await listen();
      if (transcript) {
        const reply = await sendMessage(transcript);
        if (reply) speak(reply);
      }
    } catch {
      // mic permission denied or unsupported — silently ignore, text input still works
    }
  }

  return (
    <div className="flex h-screen flex-col bg-background">
      <header className="flex items-center justify-between border-b px-4 py-3">
        <div>
          <h1 className="text-lg font-semibold">G.A.D.F</h1>
          <p className="text-xs text-muted-foreground">Grace and Daddy Forever</p>
        </div>
        <div className="flex items-center gap-2">
          {googleConnected !== null && (
            <Button
              variant={googleConnected ? "default" : "outline"}
              onClick={() => {
                if (session?.user) window.location.href = connectGoogleUrl(session.user.id);
              }}
              title={
                googleConnected
                  ? "Google connected (Drive + Calendar) — click to re-authorize"
                  : "Connect Google (Drive + Calendar)"
              }
            >
              <HardDrive className="h-4 w-4" />
            </Button>
          )}
          <Button
            variant={voiceReplies ? "default" : "outline"}
            onClick={() => setVoiceReplies((v) => !v)}
            title="Toggle spoken replies"
          >
            <Volume2 className="h-4 w-4" />
          </Button>
          <Button variant="ghost" onClick={signOut} title="Sign out">
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
          {messages.length === 0 && (
            <p className="text-center text-sm text-muted-foreground">Say hello to get started.</p>
          )}
          {messages.map((m) => (
            <div
              key={m.id}
              className={cn(
                "max-w-[80%] animate-fade-in rounded-lg px-4 py-2 text-sm",
                m.role === "user"
                  ? "ml-auto bg-primary text-primary-foreground"
                  : "mr-auto bg-secondary text-secondary-foreground",
              )}
            >
              {m.content}
            </div>
          ))}
          {sending && <p className="text-xs text-muted-foreground">G.A.D.F is thinking…</p>}
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div ref={bottomRef} />
        </div>
      </main>

      <form onSubmit={submit} className="flex items-center gap-2 border-t px-4 py-3">
        <div className="mx-auto flex w-full max-w-2xl items-center gap-2">
          {voiceSupported && (
            <Button
              type="button"
              variant={listening ? "default" : "outline"}
              onClick={handleMic}
              disabled={listening || speaking}
              title="Speak to G.A.D.F"
            >
              <Mic className="h-4 w-4" />
            </Button>
          )}
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Message G.A.D.F…"
            disabled={sending}
          />
          <Button type="submit" disabled={sending || !draft.trim()}>
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </form>
    </div>
  );
}
