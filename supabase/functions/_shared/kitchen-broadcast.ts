import {isDeviceId} from '../../../packages/core/device-access.ts';

export interface KitchenBroadcastSocket {send(text: string): void; close(): void}
export type KitchenBroadcastSocketFactory = (url: string, headers: Readonly<Record<string,string>>, callbacks: {
  open(): void; text(value: string): void; close(): void;
}) => KitchenBroadcastSocket;
const object = (v: unknown): v is Record<string,unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Server-only private Broadcast subscription. New service API keys travel in
 * the WebSocket upgrade header, never its URL, a browser or a channel payload.
 * No order data is returned: a valid event is only a hint to re-read SQL. */
export function kitchenBroadcastSubscriber(apiUrl: string, serviceKey: string, open: KitchenBroadcastSocketFactory) {
  const root = new URL(apiUrl);
  if (root.username || root.password || root.search || root.hash || root.pathname !== '/' ||
      root.protocol !== 'https:' && !(root.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(root.hostname)) ||
      !/^sb_secret_[A-Za-z0-9_-]+$/.test(serviceKey)) throw Error('Kitchen updates are unavailable.');
  const endpoint = new URL('realtime/v1/websocket',root);
  endpoint.protocol = root.protocol === 'https:' ? 'wss:' : 'ws:';
  endpoint.searchParams.set('vsn','1.0.0');
  return (outletId: string, changed: () => void, disconnected: () => void): Promise<() => void> => {
    if (!isDeviceId(outletId)) return Promise.reject(Error('Kitchen updates are unavailable.'));
    return new Promise((resolve,reject) => {
      const topic = 'realtime:kitchen:' + outletId;
      let socket: KitchenBroadcastSocket | undefined, closed = false, joined = false, reference = 1, pending: string | null = null;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const deadline = setTimeout(() => stop(true),5000);
      function stop(failed = false) {
        if (closed) return;
        closed = true; clearTimeout(deadline); clearInterval(heartbeat);
        try {socket?.close();} catch {/* No network diagnostic or credential is logged. */}
        if (!joined) reject(Error('Kitchen updates are unavailable.'));
        else if (failed) disconnected();
      }
      function send(event: string, target: string, payload: object, ref: string) {
        if (closed) return;
        try {socket!.send(JSON.stringify({topic:target,event,payload,ref,join_ref:target === topic ? '1' : null}));}
        catch {stop(true);}
      }
      try {
        socket = open(endpoint.href,{apikey:serviceKey},{
          open() {send('phx_join',topic,{config:{broadcast:{ack:false,self:false},presence:{enabled:false},postgres_changes:[],private:true}},'1');},
          text(text) {
            if (closed) return;
            if (new TextEncoder().encode(text).byteLength > 16384) {stop(true); return;}
            let value: unknown;
            try {value = JSON.parse(text);} catch {stop(true); return;}
            if (!object(value)) {stop(true); return;}
            if (value.event === 'phx_reply' && value.topic === topic && value.ref === '1' && !joined) {
              if (!object(value.payload) || value.payload.status !== 'ok') {stop(true); return;}
              joined = true; clearTimeout(deadline);
              heartbeat = setInterval(() => {
                if (pending !== null) {stop(true); return;}
                pending = String(++reference); send('heartbeat','phoenix',{},pending);
              },20000);
              resolve(() => stop());
              return;
            }
            if (!joined) return;
            if (value.topic === 'phoenix' && value.event === 'phx_reply' && value.ref === pending && object(value.payload) && value.payload.status === 'ok') {pending = null; return;}
            if (value.topic !== topic) return;
            if (value.event === 'phx_close' || value.event === 'phx_error') {stop(true); return;}
            if (value.event === 'broadcast' && object(value.payload) && value.payload.type === 'broadcast' && value.payload.event === 'kitchen_changed' &&
                object(value.payload.payload) && isDeviceId(value.payload.payload.orderId)) changed();
          },
          close() {stop(true);},
        });
      } catch {stop(true);}
    });
  };
}
