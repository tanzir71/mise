import { publicRecord } from './public-shop';
import { parsePublicOrderIntent, publicSubmissionMessage, publicOrderRequestParts, type PublicOrderIntent } from './public-order-submission';
import { saveOrderCommand, type OrderInput } from './orders';
import { decodeCommandRecord, encodeCommandRecord, type CloudRecord } from './cloud-records';
import type { Business, Item, Outlet } from './models';
import type { ShopSetup } from './shop-access';
const ulid=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const token=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{43}$/.test(v);
const integer=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=253402300799999;
const bad=()=>Error('Review the complete request before placing the order.');
function exact(value:unknown,keys:string){const r=publicRecord(value,keys.split(','));if(Object.keys(r).sort().join(',')!==keys.split(',').sort().join(','))throw bad();return r;}
/** Only the service's scoped database preparation supplies business, outlet,
 * responsible member, table, server clock, live items and next sequence. */
export function publicOrderRecords(value: unknown, input: PublicOrderIntent): CloudRecord[] {
  const intent = parsePublicOrderIntent(input), r = exact(value,'v,state,attemptId,ticketToken,businessId,outletId,actorId,at,contextJson');
  if (r.v !== 1 || r.state !== 'prepared' || r.attemptId !== intent.id || !token(r.ticketToken) ||
    !ulid(r.businessId) || !ulid(r.outletId) || !ulid(r.actorId) || !integer(r.at) || typeof r.contextJson !== 'string') throw bad();
  const raw = exact(JSON.parse(r.contextJson),'business,outlet,items,sequence,table');
  if (!Array.isArray(raw.items) || !Number.isSafeInteger(raw.sequence) || (raw.sequence as number) < 1 || !(raw.table === null || typeof raw.table === 'string')) throw bad();
  const business = decodeCommandRecord('businesses',raw.business as Record<string,unknown>) as unknown as Business,
    outlet = decodeCommandRecord('outlets',raw.outlet as Record<string,unknown>) as unknown as Outlet,
    items = raw.items.map(i => decodeCommandRecord('items',i) as unknown as Item);
  if (business.id !== r.businessId || outlet.id !== r.outletId || outlet.businessId !== business.id || items.some(i => i.outletId !== outlet.id) ||
    outlet.currency !== intent.shop.currency || outlet.timezone !== intent.shop.timezone || business.marketCode !== intent.shop.market ||
    outlet.name !== intent.shop.name || outlet.address !== intent.shop.address ||
    (raw.table !== null) !== (intent.fulfilment === 'dine_in') || typeof raw.table === 'string' && (!raw.table.trim() || raw.table.length > 40) ||
    intent.scheduledFor !== null && intent.scheduledFor > r.at + 7776000000) throw bad();
  const setup: ShopSetup = {business,outlet,owner:{id:r.actorId,businessId:business.id,active:true,outletIds:[outlet.id]}},
    parts = publicOrderRequestParts(intent.text), lines: OrderInput['lines'] = intent.selections.map(s => {
      const offered = intent.shop.items.find(i => i.id === s.itemId)!, live = items.find(i => i.id === s.itemId);
      if (!live?.available || live.name !== offered.name || live.unit !== offered.unit || live.price !== offered.price) throw bad();
      return {itemId:live.id,name:live.name,unit:live.unit,qty:s.qty,unitPrice:live.price};
    });
  for (const [index,note] of parts.entries()) lines.push({name:parts.length === 1 ? 'Customer request' : `Customer request (${index+1}/${parts.length})`,unit:'request',qty:1,unitPrice:null,note});
  if(intent.fulfilment==='delivery')lines.push({name:'Delivery fee to confirm',unit:'request',qty:1,unitPrice:null,note:'The shop will confirm the delivery fee before accepting this order.'});
  let next = 0;
  const change = saveOrderCommand({source:intent.fulfilment === 'dine_in' ? 'table' : 'other',sourceText:publicSubmissionMessage(intent),
    name:intent.name,phone:intent.phone,type:intent.fulfilment,address:intent.address,table:raw.table as string|null ?? '',
    ...(intent.scheduledFor === null ? {} : {scheduledFor:intent.scheduledFor}),lines,deliveryFee:0,discount:0,payment:{method:'cash'}},
    {setup,items,sequence:raw.sequence as number},null,0,r.at,kind => kind === 'order' ? intent.orderId : kind === 'event' ? intent.eventId : intent.lineIds[next++]);
  if (next !== intent.lineIds.length) throw bad();
  // Legacy createdBy/handledBy identify the publishing member responsible for
  // admission. The actual actor is explicitly the customer submission system.
  change.event.actor = {type:'system',id:'public-order'};
  return [encodeCommandRecord('orders',change.order as unknown as Record<string,unknown>,business.id),
    encodeCommandRecord('events',change.event as unknown as Record<string,unknown>,business.id)];
}
