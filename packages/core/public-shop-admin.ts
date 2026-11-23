import {publicRecord,publicText} from './public-shop';
import {publicOrderShopSource} from './public-order-link';
export interface PublicShopScope {businessId:string;outletId:string;actorId:string;actorRole:'owner'|'manager'}
export interface PublicShopSource {id:string;eventId:string;sourceUrl:string;shopToken:string;table:string|null;expiresAt:number|null}
export interface PublicShopMetadata {id:string;createEventId:string|null;createdAt:number|null;expiresAt:number|null;revokedAt:number|null;revokeEventId:string|null;revokedBy:string|null;table:string|null}
export interface PublicShopPage extends PublicShopScope {v:1;links:PublicShopMetadata[];nextId:string|null}
export const publicShopId=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const stamp=(v:unknown):v is number=>Number.isSafeInteger(v)&&(v as number)>=0&&(v as number)<=253402300799999;
const bad=()=>Error('Review the original shop publication with its owner or assigned manager.');
function exact(v:unknown,keys:string){const r=publicRecord(v,keys.split(','));if(Object.keys(r).sort().join(',')!==keys.split(',').sort().join(','))throw bad();return r;}
export function parsePublicShopSource(value:unknown):PublicShopSource{
 const r=exact(value,'id,eventId,sourceUrl,shopToken,table,expiresAt');if(!publicShopId(r.id)||!publicShopId(r.eventId)||r.id===r.eventId||typeof r.sourceUrl!=='string'||typeof r.shopToken!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(r.shopToken)||!(r.expiresAt===null||stamp(r.expiresAt)))throw bad();
 return {id:r.id,eventId:r.eventId,sourceUrl:publicOrderShopSource(r.sourceUrl).url.href,shopToken:r.shopToken,table:r.table===null?null:publicText(r.table,40,false,true),expiresAt:r.expiresAt as number|null};
}
export function parsePublicShopMetadata(value:unknown):PublicShopMetadata{
 const r=exact(value,'id,createEventId,createdAt,expiresAt,revokedAt,revokeEventId,revokedBy,table');
 if(!publicShopId(r.id)||![r.createEventId,r.revokeEventId,r.revokedBy].every(v=>v===null||publicShopId(v))||![r.createdAt,r.expiresAt,r.revokedAt].every(v=>v===null||stamp(v))||
  (r.createdAt===null)!==(r.createEventId===null)||(r.revokedAt===null)!==(r.revokeEventId===null)||(r.revokedAt===null)!==(r.revokedBy===null)||r.createdAt===null&&r.revokedAt===null||r.expiresAt!==null&&(r.createdAt===null||(r.expiresAt as number)<=(r.createdAt as number)))throw bad();
 return {id:r.id,createEventId:r.createEventId as string|null,createdAt:r.createdAt as number|null,expiresAt:r.expiresAt as number|null,revokedAt:r.revokedAt as number|null,revokeEventId:r.revokeEventId as string|null,revokedBy:r.revokedBy as string|null,table:r.table===null?null:publicText(r.table,40,false,true)};
}
export function parsePublicShopPage(value:unknown,scope:PublicShopScope,after:string|null,limit:number):PublicShopPage{
 const r=exact(value,'v,businessId,outletId,actorId,actorRole,links,nextId');
 if(r.v!==1||r.businessId!==scope.businessId||r.outletId!==scope.outletId||r.actorId!==scope.actorId||r.actorRole!==scope.actorRole||!Array.isArray(r.links)||r.links.length>limit||!(r.nextId===null||publicShopId(r.nextId)))throw bad();
 const links=r.links.map(parsePublicShopMetadata);
 if(links.some((l,i)=>l.id<=(i?links[i-1].id:after??'')||l.id===after)||r.nextId!==null&&(links.length!==limit||r.nextId!==links.at(-1)?.id))throw bad();
 return {v:1,...scope,links,nextId:r.nextId as string|null};
}
