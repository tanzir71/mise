import {authHttp,AuthBodyError,readAuthBody} from './auth-http.ts';
import {isDeviceToken,parseStaffDeviceAccess,type StaffDeviceAccess} from '../../../packages/core/device-access.ts';
import type {KitchenLiveFrame} from '../../../packages/core/kitchen-live.ts';

export interface KitchenLiveDependencies {
  access(device: string, session: string): Promise<unknown>;
  subscribe(outletId: string, changed: () => void, disconnected: () => void): Promise<() => void>;
  origins: ReadonlySet<string>;
  now?: () => number;
}
class Denied extends Error {}
const unavailable = () => Error('Kitchen updates are unavailable.');
function same(a: StaffDeviceAccess,b: StaffDeviceAccess) {
  return ['deviceId','businessId','outletId','memberId','sessionId','mode','expiresAt'].every(key => a[key as keyof StaffDeviceAccess] === b[key as keyof StaffDeviceAccess]);
}
/** One bounded stream per device. Every signal is authorized against BOTH
 * original secrets again. Broker payloads and service credentials never reach
 * a browser, owner Auth, a cache, a URL, a receipt or diagnostic output. */
export function createKitchenLiveHandler(deps: KitchenLiveDependencies) {
  const origins = new Set(deps.origins), now = deps.now ?? Date.now;
  return async (request: Request): Promise<Response> => {
    const {reply,blocked} = authHttp(request,origins);
    if (blocked) return blocked;
    const device = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    if (!device) return reply(401,{error:'Sign in on this screen again.'});
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) return reply(415,{error:'Use JSON.'});
    let input: unknown;
    try {input = await readAuthBody(request);} catch(error) {return reply(error instanceof AuthBodyError ? error.status : 400,{error:'Check the kitchen request.'});}
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).join(',') !== 'sessionToken' ||
        !('sessionToken' in input) || !isDeviceToken(input.sessionToken)) return reply(400,{error:'Keep the original staff session.'});
    const session = input.sessionToken;
    let stopped = false, upstream: (() => void) | undefined, writer: ReadableStreamDefaultController<Uint8Array> | undefined;
    let dirty = false, checking = false, heartbeat: ReturnType<typeof setInterval> | undefined, lifetime: ReturnType<typeof setTimeout> | undefined;
    function stop() {
      if (stopped) return;
      stopped = true; clearInterval(heartbeat); clearTimeout(lifetime); request.signal.removeEventListener('abort',stop);
      try {upstream?.();} catch {/* Keep the public stream free of transport diagnostics. */}
      try {writer?.close();} catch {/* Already cancelled by the browser. */}
    }
    function send(type: KitchenLiveFrame['type']) {
      if (stopped || !writer) return;
      // A stalled reader reconnects through its durable cursor. It cannot
      // accumulate unbounded events in an idle Edge worker.
      if ((writer.desiredSize ?? 0) <= 0) {stop(); return;}
      try {writer.enqueue(new TextEncoder().encode('data: '+JSON.stringify({v:1,type})+'\n\n'));} catch {stop();}
    }
    async function access() {
      if (stopped || request.signal.aborted) throw unavailable();
      const raw = await deps.access(device!,session);
      if (raw === null) throw new Denied();
      const current = parseStaffDeviceAccess(raw);
      if (!current.permissions.includes('orders.read') || current.expiresAt <= now()) throw new Denied();
      if (stopped || request.signal.aborted) throw unavailable();
      return current;
    }
    try {
      const original = await access();
      const confirm = async () => {const current = await access(); if (!same(original,current)) throw new Denied();};
      const flush = async () => {
        if (stopped || checking || !writer) return;
        checking = true;
        try {
          do {
            const changed = dirty; dirty = false;
            await confirm(); if (stopped) return;
            send(changed ? 'wake' : 'heartbeat');
          } while (dirty && !stopped);
        } catch(error) {if (error instanceof Denied) send('auth'); stop();}
        finally {checking = false;}
      };
      upstream = await deps.subscribe(original.outletId,() => {dirty = true; void flush();},stop);
      if (stopped || request.signal.aborted) {upstream(); throw unavailable();}
      // Joining a topic may take time. Re-check enrollment, membership and
      // read permission before returning any successful response to the client.
      await confirm();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          writer = controller; send('ready');
          request.signal.addEventListener('abort',stop,{once:true});
          if (request.signal.aborted) {stop(); return;}
          heartbeat = setInterval(() => void flush(),15000);
          lifetime = setTimeout(() => {if (original.expiresAt <= now()) send('auth'); stop();},Math.max(1,Math.min(110000,original.expiresAt-now())));
          if (dirty) void flush();
        },
        cancel() {stop();},
      },{highWaterMark:8});
      const headers = new Headers({'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','Pragma':'no-cache','Vary':'Origin','X-Accel-Buffering':'no'});
      const origin = request.headers.get('origin'); if (origin) headers.set('Access-Control-Allow-Origin',origin);
      return new Response(stream,{headers});
    } catch(error) {
      stop();
      return error instanceof Denied ? reply(401,{error:'Sign in on this screen again.'}) : reply(503,{error:'Live updates are unavailable. Check the saved tickets and try again.'});
    }
  };
}
