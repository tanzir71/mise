import { publicRecord, publicText, parsePublicShop, type PublicShop } from './public-shop';
import { normalisePublicPhone } from './public-phone';
import { orderMessage } from './public-order';

export interface PublicOrderIntent {
  v: 1;
  id: string;
  orderId: string;
  eventId: string;
  linkId: string;
  linkEventId: string;
  lineIds: string[];
  shop: PublicShop;
  name: string;
  phone: string;
  fulfilment: 'pickup' | 'delivery' | 'dine_in';
  address: string;
  when: string;
  scheduledFor: number | null;
  selections: { itemId: string; qty: number }[];
  text: string;
  paymentPreference: string;
  language: 'en' | 'bn';
}
export interface PublicOrderSubmission {
  v: 1;
  action: 'submit' | 'inspect' | 'close';
  shopToken: string;
  trackingToken: string;
  intent: PublicOrderIntent;
  website: string;
}
const ulid = (v: unknown): v is string => typeof v === 'string' && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const token = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v);
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 253402300799999;
const bad = () => Error('Review the complete request before placing the order.');
function exact(value: unknown, keys: string) {
  const row = publicRecord(value, keys.split(','));
  if (Object.keys(row).sort().join(',') !== keys.split(',').sort().join(',')) throw bad();
  return row;
}
/** The complete literal request is retained in sourceText. Notes additionally
 * expose its unpriced parts without truncating a long customer list. */
export function publicOrderRequestParts(text: string): string[] {
  if (!text.trim()) return [];
  const parts: string[] = [];
  let current = '';
  for (const character of text) {
    if (current.length + character.length > 500) { parts.push(current); current = ''; }
    current += character;
  }
  if (current) parts.push(current);
  return parts;
}
export function parsePublicOrderIntent(value: unknown): PublicOrderIntent {
  const r = exact(value, 'v,id,orderId,eventId,linkId,linkEventId,lineIds,shop,name,phone,fulfilment,address,when,scheduledFor,selections,text,paymentPreference,language');
  if (r.v !== 1 || ![r.id,r.orderId,r.eventId,r.linkId,r.linkEventId].every(ulid) || !Array.isArray(r.lineIds) || !r.lineIds.every(ulid) ||
    !['pickup','delivery','dine_in'].includes(r.fulfilment as string) || !['en','bn'].includes(r.language as string) ||
    !(r.scheduledFor === null || integer(r.scheduledFor)) || !Array.isArray(r.selections) || r.selections.length > 20) throw bad();
  const shop = parsePublicShop(r.shop), text = publicText(r.text,4000,true),
    selections = r.selections.map(value => {
      const s = exact(value,'itemId,qty');
      if (typeof s.itemId !== 'string' || !Number.isSafeInteger(s.qty) || (s.qty as number) < 1 || (s.qty as number) > 99 ||
        !shop.items.some(i => i.id === s.itemId && i.available)) throw bad();
      return {itemId:s.itemId,qty:s.qty as number};
    });
  if (new Set(selections.map(s => s.itemId)).size !== selections.length || !selections.length && !text.trim() ||
    r.lineIds.length !== selections.length + publicOrderRequestParts(text).length + (r.fulfilment==='delivery'?1:0)) throw bad();
  const ids = [r.id,r.orderId,r.eventId,r.linkId,r.linkEventId,...r.lineIds];
  if (new Set(ids).size !== ids.length) throw bad();
  const name = publicText(r.name,80,false,true), phone = publicText(r.phone,16,false,true), address = publicText(r.address,250,true),
    when = publicText(r.when,120,false,true), paymentPreference = publicText(r.paymentPreference,40);
  if (normalisePublicPhone(phone,shop.market) !== phone || r.fulfilment === 'delivery' && !address.trim() || r.fulfilment !== 'delivery' && address !== '') throw bad();
  const result: PublicOrderIntent = {v:1,id:r.id as string,orderId:r.orderId as string,eventId:r.eventId as string,
    linkId:r.linkId as string,linkEventId:r.linkEventId as string,lineIds:[...r.lineIds],shop,name,phone,
    fulfilment:r.fulfilment as PublicOrderIntent['fulfilment'],address,when,scheduledFor:r.scheduledFor as number|null,
    selections,text,paymentPreference,language:r.language as PublicOrderIntent['language']};
  // Apply the established M20 limits and message format to the original source.
  publicSubmissionMessage(result);
  return result;
}
export function publicSubmissionMessage(intent: PublicOrderIntent): string {
  let message = orderMessage({shopCode:intent.shop.code,shopName:intent.shop.name,name:intent.name,phone:intent.phone,
    fulfilment:intent.fulfilment === 'delivery' ? 'delivery' : 'pickup',address:intent.address,when:intent.when,
    items:[...intent.selections.map(s => `${s.qty} × ${intent.shop.items.find(i => i.id === s.itemId)!.name}`),
      ...(intent.text.trim() ? intent.text.split(/\r?\n/) : [])],payment:intent.paymentPreference,photo:false,language:intent.language});
  if(intent.fulfilment==='dine_in'){
    const lines=message.split('\n');lines[2]=(intent.language==='bn'?'টেবিল অর্ডার: ':'Table order: ')+intent.when;message=lines.join('\n');
  }
  return intent.text && !message.includes(intent.text) ? message + '\n\nOriginal customer text:\n' + intent.text : message;
}
export function parsePublicOrderSubmission(value: unknown): PublicOrderSubmission {
  const r = exact(value,'v,action,shopToken,trackingToken,intent,website');
  if (r.v !== 1 || !['submit','inspect','close'].includes(r.action as string) || !token(r.shopToken) || !token(r.trackingToken)) throw bad();
  return {v:1,action:r.action as PublicOrderSubmission['action'],shopToken:r.shopToken,trackingToken:r.trackingToken,
    intent:parsePublicOrderIntent(r.intent),website:publicText(r.website,512)};
}
export async function publicOrderHash(text: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),b => b.toString(16).padStart(2,'0')).join('');
}
/** Binding the opaque attempt ID to the customer's secret prevents someone
 * who merely knows a request reference from planting an earlier closure. */
export function publicOrderAttemptIdFromHash(hash: string): string {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw bad();
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let bits = BigInt('0x'+hash.slice(0,32)), result = '';
  for (let i=0;i<26;i++) { result = alphabet[Number(bits & 31n)] + result; bits >>= 5n; }
  return result;
}
export function publicOrderIntentJson(intent: PublicOrderIntent): string { return JSON.stringify(parsePublicOrderIntent(intent)); }

export interface PublicOrderOutcome {
  v: 1;
  state: 'pending' | 'closed' | 'created';
  attemptId: string;
  closedAt: number | null;
  receipt: null | {orderId:string;eventId:string;linkId:string;number:string;currency:string;total:number|null;createdAt:number;receivedAt:number};
  link: null | {id:string;kind:'order';resourceId:string;createdAt:number;expiresAt:number;revokedAt:number|null};
}
/** The HTTP boundary copies only the customer's own original receipt. No
 * preparation token, tenant/member ID, source context or server setting escapes. */
export function parsePublicOrderOutcome(value:unknown,input:PublicOrderIntent):PublicOrderOutcome {
  const source=parsePublicOrderIntent(input),r=exact(value,'v,state,attemptId,closedAt,receipt,link');
  if(r.v!==1||!['pending','closed','created'].includes(r.state as string)||r.attemptId!==source.id||!(r.closedAt===null||integer(r.closedAt)))throw bad();
  const result:PublicOrderOutcome={v:1,state:r.state as PublicOrderOutcome['state'],attemptId:source.id,closedAt:r.closedAt as number|null,receipt:null,link:null};
  if(r.state!=='created'){
    if(r.receipt!==null||r.link!==null||(r.state==='closed')!==(r.closedAt!==null))throw bad();
    return result;
  }
  const receipt=exact(r.receipt,'orderId,eventId,linkId,number,currency,total,createdAt,receivedAt'),link=exact(r.link,'id,kind,resourceId,createdAt,expiresAt,revokedAt');
  if(r.closedAt!==null||receipt.orderId!==source.orderId||receipt.eventId!==source.eventId||receipt.linkId!==source.linkId||receipt.currency!==source.shop.currency||
    typeof receipt.number!=='string'||!/^A-\d{4,16}$/.test(receipt.number)||!(receipt.total===null||typeof receipt.total==='number'&&Number.isSafeInteger(receipt.total)&&receipt.total>=0)||
    !integer(receipt.createdAt)||!integer(receipt.receivedAt)||receipt.receivedAt<receipt.createdAt||link.id!==source.linkId||link.kind!=='order'||link.resourceId!==source.orderId||
    !integer(link.createdAt)||!integer(link.expiresAt)||link.expiresAt<=link.createdAt||!(link.revokedAt===null||integer(link.revokedAt)&&link.revokedAt>=link.createdAt))throw bad();
  result.receipt={orderId:source.orderId,eventId:source.eventId,linkId:source.linkId,number:receipt.number,currency:source.shop.currency,total:receipt.total as number|null,createdAt:receipt.createdAt,receivedAt:receipt.receivedAt};
  result.link={id:source.linkId,kind:'order',resourceId:source.orderId,createdAt:link.createdAt,expiresAt:link.expiresAt,revokedAt:link.revokedAt as number|null};
  return result;
}

