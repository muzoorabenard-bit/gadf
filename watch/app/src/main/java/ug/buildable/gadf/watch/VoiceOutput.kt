package ug.buildable.gadf.watch

import android.content.Context
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import java.util.Locale

// System TTS engine speaks G.A.D.F's replies. Swap for a branded voice
// (ElevenLabs, etc.) later — this is the free, zero-setup option for now.
class VoiceOutput(context: Context, private val onSpeechDone: () -> Unit) {
    private var tts: TextToSpeech? = null

    init {
        tts = TextToSpeech(context) { status ->
            if (status == TextToSpeech.SUCCESS) {
                tts?.setLanguage(Locale.US)
                tts?.setOnUtteranceProgressListener(
                    object : UtteranceProgressListener() {
                        override fun onStart(utteranceId: String?) {}

                        override fun onDone(utteranceId: String?) {
                            onSpeechDone()
                        }

                        @Deprecated("Deprecated in Java")
                        override fun onError(utteranceId: String?) {
                            onSpeechDone()
                        }
                    },
                )
            }
        }
    }

    fun speak(text: String) {
        tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, "gadf-reply")
    }

    fun shutdown() {
        tts?.stop()
        tts?.shutdown()
    }
}
