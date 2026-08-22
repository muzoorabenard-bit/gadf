package ug.buildable.gadf.watch

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Stop
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.wear.compose.material.Button
import androidx.wear.compose.material.ButtonDefaults
import androidx.wear.compose.material.Icon
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.Text
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private lateinit var authStore: AuthStore
    private val api = GadfApi()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        authStore = AuthStore(this)
        setContent {
            GadfApp(authStore = authStore, api = api)
        }
    }
}

@Composable
fun GadfApp(authStore: AuthStore, api: GadfApi) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    var session by remember { mutableStateOf(authStore.load()) }
    var state by remember { mutableStateOf<UiState>(UiState.CheckingSession) }

    var hasMicPermission by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
                PackageManager.PERMISSION_GRANTED,
        )
    }
    val permissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission(),
    ) { granted -> hasMicPermission = granted }

    var stt by remember { mutableStateOf<SpeechToText?>(null) }
    var tts by remember { mutableStateOf<VoiceOutput?>(null) }

    suspend fun ensureReady(): String? {
        var s = session
        if (s == null) {
            state = UiState.LoggedOut
            return null
        }
        if (s.expiresAtMillis < System.currentTimeMillis() + 30_000) {
            try {
                s = api.refresh(s.refreshToken)
                authStore.save(s)
                session = s
            } catch (e: Exception) {
                authStore.clear()
                session = null
                state = UiState.LoggedOut
                return null
            }
        }
        return s.accessToken
    }

    LaunchedEffect(session) {
        state = if (session == null) UiState.LoggedOut else UiState.Idle
    }

    DisposableEffect(Unit) {
        tts = VoiceOutput(context) { state = UiState.Idle }
        onDispose {
            tts?.shutdown()
            stt?.destroy()
        }
    }

    fun startListening() {
        if (!hasMicPermission) {
            permissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
            return
        }
        stt?.destroy()
        state = UiState.Listening
        val recognizer = SpeechToText(
            context = context,
            onResult = { transcript ->
                state = UiState.Sending
                scope.launch {
                    val accessToken = ensureReady() ?: return@launch
                    try {
                        val reply = api.sendMessage(accessToken, transcript)
                        state = UiState.Speaking
                        tts?.speak(reply)
                    } catch (e: Exception) {
                        state = UiState.Error(e.message ?: "G.A.D.F didn't respond")
                    }
                }
            },
            onFailure = { message -> state = UiState.Error(message) },
        )
        stt = recognizer
        recognizer.start()
    }

    fun stopListening() {
        stt?.stop()
    }

    MaterialTheme {
        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            when (val s = state) {
                is UiState.CheckingSession -> Text("...")

                is UiState.LoggedOut -> LoginScreen { email, password ->
                    scope.launch {
                        try {
                            val newSession = api.signIn(email, password)
                            authStore.save(newSession)
                            session = newSession
                        } catch (e: Exception) {
                            state = UiState.Error(e.message ?: "Sign-in failed")
                        }
                    }
                }

                is UiState.Error -> Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(s.message, textAlign = TextAlign.Center)
                    Spacer(modifier = Modifier.height(8.dp))
                    Button(onClick = { state = UiState.Idle }) {
                        Text("OK")
                    }
                }

                else -> Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Button(
                        onClick = {
                            if (state == UiState.Listening) stopListening() else startListening()
                        },
                        modifier = Modifier.size(60.dp),
                        colors = if (state == UiState.Listening) {
                            ButtonDefaults.primaryButtonColors()
                        } else {
                            ButtonDefaults.secondaryButtonColors()
                        },
                        enabled = state == UiState.Idle || state == UiState.Listening,
                    ) {
                        if (state == UiState.Listening) {
                            Icon(Icons.Filled.Stop, contentDescription = "Send")
                        } else {
                            Icon(Icons.Filled.Mic, contentDescription = "Talk")
                        }
                    }
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        when (state) {
                            UiState.Idle -> "Tap to talk"
                            UiState.Listening -> "Listening... tap to send"
                            UiState.Sending -> "Thinking..."
                            UiState.Speaking -> "Speaking..."
                            else -> ""
                        },
                    )
                }
            }
        }
    }
}
