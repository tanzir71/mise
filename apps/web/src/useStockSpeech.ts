import { useEffect, useRef, useState } from 'react';
interface Recognition {lang:string;interimResults:boolean;continuous:boolean;onresult:((event:{results:ArrayLike<ArrayLike<{transcript:string}>>}) => void)|null;onerror:(() => void)|null;onend:(() => void)|null;start():void;abort():void}
type Engine = new () => Recognition;
const speechWindow = window as Window & {SpeechRecognition?:Engine;webkitSpeechRecognition?:Engine};
/** Speech only fills a draft. The normal review/keypad/save path remains available. */
export function useStockSpeech(online:boolean,onText:(text:string) => void,onError:() => void) {
  const current = useRef<Recognition|null>(null), callbacks = useRef({onText,onError}), [listening,setListening] = useState(false);callbacks.current = {onText,onError};
  useEffect(() => () => {const active = current.current;if (active) {active.onresult = null;active.onerror = null;active.onend = null;active.abort();}},[]);
  useEffect(() => {if (!online) {const active = current.current;current.current = null;active?.abort();setListening(false);}},[online]);
  function cancel() {const active = current.current;current.current = null;active?.abort();setListening(false);}
  function start() {
    const Constructor = speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition;if (!online || !Constructor) return;cancel();const recognition = new Constructor();current.current = recognition;recognition.lang = 'en-US';recognition.continuous = false;recognition.interimResults = false;
    recognition.onresult = event => {if (current.current === recognition) callbacks.current.onText(event.results[0]?.[0]?.transcript || '');};
    recognition.onerror = () => {if (current.current === recognition) {setListening(false);callbacks.current.onError();}};recognition.onend = () => {if (current.current === recognition) setListening(false);};
    try {recognition.start();setListening(true);}catch {setListening(false);callbacks.current.onError();}
  }
  return {supported:Boolean(online && (speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition)),listening,start,cancel};
}
