import { useCallback, useEffect, useRef, useState } from "react";

// Thin wrapper around the browser's Web Speech API — free, zero external
// deps, good enough for Phase 3. Swap for Whisper/ElevenLabs later if the
// quality needs to go up.
export function useVoice() {
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [supported, setSupported] = useState(true);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

  useEffect(() => {
    const SpeechRecognitionCtor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!SpeechRecognitionCtor || !("speechSynthesis" in window)) {
      setSupported(false);
      return;
    }
    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = "en-US";
    recognitionRef.current = recognition;
  }, []);

  const listen = useCallback((): Promise<string> => {
    return new Promise((resolve, reject) => {
      const recognition = recognitionRef.current;
      if (!recognition) {
        reject(new Error("Speech recognition not supported in this browser"));
        return;
      }

      recognition.onresult = (event: SpeechRecognitionEvent) => {
        const transcript = event.results[0]?.[0]?.transcript ?? "";
        resolve(transcript);
      };
      recognition.onerror = () => {
        setListening(false);
        reject(new Error("Speech recognition failed"));
      };
      recognition.onend = () => setListening(false);

      setListening(true);
      recognition.start();
    });
  }, []);

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
    setListening(false);
  }, []);

  const speak = useCallback((text: string) => {
    if (!("speechSynthesis" in window) || !text) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    // Chrome can silently garbage-collect an utterance with no surviving
    // reference before it finishes speaking — keep one alive in a ref.
    utteranceRef.current = utterance;
    utterance.onstart = () => setSpeaking(true);
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    window.speechSynthesis.speak(utterance);
  }, []);

  return { supported, listening, speaking, listen, stopListening, speak };
}
