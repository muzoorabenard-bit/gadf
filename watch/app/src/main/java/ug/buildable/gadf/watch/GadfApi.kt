package ug.buildable.gadf.watch

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

private val JSON_MEDIA_TYPE = "application/json".toMediaType()
private val json = Json { ignoreUnknownKeys = true }

class GadfApiException(message: String) : IOException(message)

@Serializable
private data class AuthUser(val id: String)

@Serializable
private data class AuthTokenResponse(
    @SerialName("access_token") val accessToken: String,
    @SerialName("refresh_token") val refreshToken: String,
    @SerialName("expires_in") val expiresIn: Long,
    val user: AuthUser,
)

@Serializable
private data class SignInRequest(val email: String, val password: String)

@Serializable
private data class RefreshRequest(@SerialName("refresh_token") val refreshToken: String)

@Serializable
private data class ChatRequest(val message: String, val channel: String)

@Serializable
private data class ChatReply(val reply: String? = null, val error: String? = null)

// Talks to the same Supabase project + gadf-chat edge function the web app
// uses — plain REST calls (Auth, PostgREST, Functions) rather than the full
// Supabase SDK, to keep the watch APK small.
class GadfApi {
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    private fun tokenToSession(token: AuthTokenResponse): GadfSession {
        val expiresAt = System.currentTimeMillis() + token.expiresIn * 1000
        return GadfSession(token.accessToken, token.refreshToken, expiresAt, token.user.id)
    }

    suspend fun signIn(email: String, password: String): GadfSession = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url("${GadfConfig.SUPABASE_URL}/auth/v1/token?grant_type=password")
            .addHeader("apikey", GadfConfig.SUPABASE_ANON_KEY)
            .addHeader("Content-Type", "application/json")
            .post(json.encodeToString(SignInRequest(email, password)).toRequestBody(JSON_MEDIA_TYPE))
            .build()
        tokenToSession(execute(request, "Sign-in failed - check email/password"))
    }

    suspend fun refresh(refreshToken: String): GadfSession = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url("${GadfConfig.SUPABASE_URL}/auth/v1/token?grant_type=refresh_token")
            .addHeader("apikey", GadfConfig.SUPABASE_ANON_KEY)
            .addHeader("Content-Type", "application/json")
            .post(json.encodeToString(RefreshRequest(refreshToken)).toRequestBody(JSON_MEDIA_TYPE))
            .build()
        tokenToSession(execute(request, "Session refresh failed"))
    }

    // Server resolves/creates the one continuous conversation for this user
    // itself — the watch just sends the message and which channel it's from.
    suspend fun sendMessage(accessToken: String, message: String): String =
        withContext(Dispatchers.IO) {
            val request = Request.Builder()
                .url("${GadfConfig.SUPABASE_URL}/functions/v1/gadf-chat")
                .addHeader("apikey", GadfConfig.SUPABASE_ANON_KEY)
                .addHeader("Authorization", "Bearer $accessToken")
                .addHeader("Content-Type", "application/json")
                .post(json.encodeToString(ChatRequest(message, "watch")).toRequestBody(JSON_MEDIA_TYPE))
                .build()
            val result = execute<ChatReply>(request, "G.A.D.F didn't respond")
            result.reply ?: throw GadfApiException(result.error ?: "Empty reply")
        }

    private inline fun <reified T> execute(request: Request, errorPrefix: String): T {
        client.newCall(request).execute().use { response ->
            val bodyText = response.body?.string().orEmpty()
            if (!response.isSuccessful) throw GadfApiException("$errorPrefix (${response.code})")
            return json.decodeFromString(bodyText)
        }
    }
}
