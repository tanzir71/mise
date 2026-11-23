import {ulid} from 'ulid';
import type {PublicShop} from './public-shop';
import {parsePublicOrderSubmission,publicOrderAttemptIdFromHash,publicOrderHash,publicOrderRequestParts,type PublicOrderIntent} from './public-order-submission';
export type CustomerOrderFields=Pick<PublicOrderIntent,'name'|'phone'|'fulfilment'|'address'|'when'|'scheduledFor'|'selections'|'text'|'paymentPreference'|'language'>;
export async function newPublicOrderSubmission(shopToken:string,shop:PublicShop,fields:CustomerOrderFields){
 const bytes=crypto.getRandomValues(new Uint8Array(32)),trackingToken=btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,''),
  id=publicOrderAttemptIdFromHash(await publicOrderHash(trackingToken)),at=Date.now(),lineCount=fields.selections.length+publicOrderRequestParts(fields.text).length+(fields.fulfilment==='delivery'?1:0);
 return parsePublicOrderSubmission({v:1,action:'submit',shopToken,trackingToken,website:'',intent:{...fields,v:1,id,orderId:ulid(at),eventId:ulid(at),linkId:ulid(at),linkEventId:ulid(at),lineIds:Array.from({length:lineCount},()=>ulid(at)),shop}});
}
