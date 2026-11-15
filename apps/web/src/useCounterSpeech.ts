import { useEffect, useRef, useState } from 'react';
import { speechExpression } from '@mise/core/speech';
interface Recognition { lang: string; interimResults: boolean; continuous: boolean; onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null; onerror: (() => void) | null; onend: (() => void) | null; start(): void; abort(): void }
type Constructor = new () => Recognition;
const speechWindow = window as Window & { SpeechRecognition?: Constructor; webkitSpeechRecognition?: Constructor };
export function useCounterSpeech(currency: string, online: boolean, onResult: (expression: string) => void, onError: () => void) {
  const [listening, setListening] = useState(false), current = useRef<Recognition | null>(null);
  const callbacks = useRef({ onResult, onError }); callbacks.current = { onResult, onError };
  useEffect(() => () => { if (current.current) { current.current.onresult = null; current.current.onerror = null; current.current.onend = null; current.current.abort(); } }, []);
  useEffect(() => { if (!online) current.current?.abort(); }, [online]);
  function start() {
    const Engine = speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition;
    if (!Engine || !online) return;
    current.current?.abort();
    const recognition = new Engine(); current.current = recognition;
    recognition.lang = 'en-US'; recognition.continuous = false; recognition.interimResults = false;
    recognition.onresult = event => { if (current.current !== recognition) return; const expression = speechExpression(event.results[0]?.[0]?.transcript || '', currency); if (expression === null) callbacks.current.onError(); else callbacks.current.onResult(expression); };
    recognition.onerror = () => { if (current.current === recognition) { setListening(false); callbacks.current.onError(); } };
    recognition.onend = () => { if (current.current === recognition) setListening(false); };
    try { recognition.start(); setListening(true); } catch { setListening(false); callbacks.current.onError(); }
  }
  function cancel() { const recognition = current.current; current.current = null; recognition?.abort(); setListening(false); }
  return { supported: Boolean(online && (speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition)), listening, start, cancel };
}
