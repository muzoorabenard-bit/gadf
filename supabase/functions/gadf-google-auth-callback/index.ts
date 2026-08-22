import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Hit directly by Google's OAuth redirect — an unauthenticated browser GET,
// so there's no user JWT to trust. `state` (the user's id, set by the web
// client when it kicked off the consent flow) is the only identity signal,
// which is why this function writes with the service role key instead of
// the usual RLS-scoped anon client.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/gadf-google-auth-callback`;
const WEB_URL = Deno.env.get("GADF_WEB_URL") ?? "https://gadf-assistant.netlify.app";

serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const userId = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  if (oauthError) {
    return Response.redirect(`${WEB_URL}/chat?google=error&reason=${encodeURIComponent(oauthError)}`, 302);
  }
  if (!code || !userId) {
    return Response.redirect(`${WEB_URL}/chat?google=error&reason=missing_code_or_state`, 302);
  }

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        code,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenRes.ok) {
      console.error("Google token exchange failed:", await tokenRes.text());
      return Response.redirect(`${WEB_URL}/chat?google=error&reason=token_exchange_failed`, 302);
    }

    const tokenData = await tokenRes.json();
    const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { error: upsertError } = await supabase.from("google_tokens").upsert(
      {
        user_id: userId,
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_at: expiresAt,
        scope: tokenData.scope,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );

    if (upsertError) {
      console.error("Failed to store Google tokens:", upsertError);
      return Response.redirect(`${WEB_URL}/chat?google=error&reason=storage_failed`, 302);
    }

    return Response.redirect(`${WEB_URL}/chat?google=connected`, 302);
  } catch (err) {
    console.error("gadf-google-auth-callback error:", err);
    return Response.redirect(`${WEB_URL}/chat?google=error&reason=internal`, 302);
  }
});
