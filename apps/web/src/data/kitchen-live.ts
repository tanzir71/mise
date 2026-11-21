import {parseScreenJournalRecord,type ScreenJournalRecord} from '@mise/core/device-screen-state';
import {parseKitchenLiveFrame} from '@mise/core/kitchen-live';
import {assertBlankScreenProfile,type ScreenJournal} from './device-screen-journal';
import {DeviceScreenRequestError} from './device-screen-remote';

/** Device-only fetch stream. Credentials are sent in the ordinary protected
 * headers/body, never a WebSocket URL, query string or subprotocol. Every hint
 * still requires a fresh scoped ticket read and native source comparison. */
export function watchKitchenLive(journal: ScreenJournal,input: ScreenJournalRecord,deps: {
  wake(): void;
  state(live: boolean): void;
  denied(): void;
  blank?: () => Promise<void>;
  send?: typeof fetch;
}) {
  const original = parseScreenJournalRecord(input);
  if (original.state.phase !== 'signed-in') throw new DeviceScreenRequestError('auth');
  const {credential,session} = original.state, send = deps.send ?? fetch, blank = deps.blank ?? assertBlankScreenProfile;
  const url = new URL('functions/v1/kitchen-live',credential.connection.apiUrl+'/'), body = JSON.stringify({sessionToken:session.token});
  let stopped = false, retry = 500, reconnect: ReturnType<typeof setTimeout> | undefined, request: AbortController | undefined;
  async function current() {
    if (stopped) throw Error();
    await blank(); await journal.assertCurrent(original);
    if (stopped) throw Error();
  }
  function stop() {
    if (stopped) return;
    stopped = true; clearTimeout(reconnect); request?.abort();
  }
  async function connect() {
    const controller = new AbortController(); request = controller;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, response: Response | undefined, authorized = false;
    let deadline: ReturnType<typeof setTimeout> | undefined = setTimeout(() => controller.abort(),30000);
    const timeout = () => {clearTimeout(deadline); deadline = setTimeout(() => controller.abort(),25000);};
    const abortable = <T>(promise: Promise<T>) => new Promise<T>((resolve,reject) => {
      const abort = () => {controller.signal.removeEventListener('abort',abort); reject(new DeviceScreenRequestError('retry'));};
      if (controller.signal.aborted) {void promise.catch(() => {}); abort(); return;}
      controller.signal.addEventListener('abort',abort,{once:true});
      promise.then(value => {controller.signal.removeEventListener('abort',abort); resolve(value);},error => {controller.signal.removeEventListener('abort',abort); reject(error);});
    });
    try {
      await current();
      response = await abortable(send(url,{method:'POST',credentials:'omit',redirect:'error',cache:'no-store',signal:controller.signal,
        headers:{apikey:credential.connection.publishableKey,Authorization:'Bearer '+credential.token,'Content-Type':'application/json'},body}));
      await current();
      if ([401,403].includes(response.status)) throw new DeviceScreenRequestError('auth');
      if (!response.ok || !/^text\/event-stream(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) throw Error();
      reader = response.body?.getReader(); if (!reader) throw Error();
      const decoder = new TextDecoder('utf-8',{fatal:true}); let pending = '';
      while (!stopped) {
        const part = await abortable(reader.read());
        if (part.done) {if (decoder.decode() || pending) throw Error(); break;}
        // Frames are small closed metadata only. A partial or newline-free
        // response cannot grow the browser's receive buffer without a bound.
        pending += decoder.decode(part.value,{stream:true});
        if (pending.length > 8192) throw Error();
        for (;;) {
          const end = pending.indexOf('\n\n'); if (end < 0) break;
          const text = pending.slice(0,end); pending = pending.slice(end+2);
          if (!text.startsWith('data: ') || text.includes('\n')) throw Error();
          const frame = parseKitchenLiveFrame(JSON.parse(text.slice(6)));
          await current(); timeout();
          if (frame.type === 'auth') throw new DeviceScreenRequestError('auth');
          if (!authorized && frame.type !== 'ready' || authorized && frame.type === 'ready') throw Error();
          if (frame.type === 'ready') {authorized = true; retry = 500; deps.state(true); deps.wake();}
          else if (frame.type === 'wake') deps.wake();
        }
      }
    } catch(error) {
      if (!stopped && error instanceof DeviceScreenRequestError && error.kind === 'auth') {stop(); deps.state(false); deps.denied();}
    } finally {
      clearTimeout(deadline); controller.abort();
      if (reader) {void reader.cancel().catch(() => {}); reader.releaseLock();} else void response?.body?.cancel().catch(() => {});
      if (request === controller) request = undefined;
      if (!stopped) {
        deps.state(false);
        // Reconnect always receives ready -> a real cursor pull. No source,
        // status, cursor or receipt is inferred from a broken live connection.
        reconnect = setTimeout(() => void connect(),retry);
        retry = Math.min(10000,retry*2);
      }
    }
  }
  void connect();
  return stop;
}
