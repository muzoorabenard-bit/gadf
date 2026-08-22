package ug.buildable.gadf.watch

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer

// Wraps Android's on-device/Google speech recognizer. start() begins
// listening; stop() tells it to finalize whatever was heard so far, which
// fires onResults with the transcript — this is what turns the second
// button press into "stop listening and convert to text".
class SpeechToText(
    context: Context,
    private val onResult: (String) -> Unit,
    private val onFailure: (String) -> Unit,
) {
    private val recognizer: SpeechRecognizer? =
        if (SpeechRecognizer.isRecognitionAvailable(context)) {
            SpeechRecognizer.createSpeechRecognizer(context)
        } else {
            null
        }

    private val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false)
    }

    val isAvailable: Boolean get() = recognizer != null

    fun start() {
        val r = recognizer
        if (r == null) {
            onFailure("Speech recognition isn't available on this watch")
            return
        }
        r.setRecognitionListener(
            object : RecognitionListener {
                override fun onResults(results: Bundle) {
                    val text = results
                        .getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                        ?.firstOrNull()
                    if (text.isNullOrBlank()) onFailure("Didn't catch that") else onResult(text)
                }

                override fun onError(error: Int) {
                    onFailure("Listening error ($error)")
                }

                override fun onReadyForSpeech(params: Bundle?) {}
                override fun onBeginningOfSpeech() {}
                override fun onRmsChanged(rmsdB: Float) {}
                override fun onBufferReceived(buffer: ByteArray?) {}
                override fun onEndOfSpeech() {}
                override fun onPartialResults(partialResults: Bundle?) {}
                override fun onEvent(eventType: Int, params: Bundle?) {}
            },
        )
        r.startListening(intent)
    }

    fun stop() {
        recognizer?.stopListening()
    }

    fun destroy() {
        recognizer?.destroy()
    }
}
