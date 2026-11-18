import type {InboxItem,InboxKind} from './inbox';
import type {InboxCommand} from './inbox-commands';
import type {AuditEvent} from './models';

/** Project metadata only; image bytes remain in the local source and recovery row. */
export function inboxCaptureIntent(item:InboxItem,event:AuditEvent,hashes:readonly string[]):Extract<InboxCommand,{type:'inbox.capture'}>{
 if(item.outletId===null||hashes.length!==item.images.length)throw new Error('Keep the original Inbox source and image hashes.');
 return {id:event.id,type:'inbox.capture',itemId:item.id,outletId:item.outletId,occurredAt:event.at,createdAt:item.createdAt,input:{title:item.title,text:item.text,url:item.url,images:item.images.map(({id,name,type,size},position)=>({id,name,type,size,sha256:hashes[position]}))}};
}
export function inboxChangeIntent(before:InboxItem,event:AuditEvent,change:{kind:InboxKind}|{archived:boolean}):Extract<InboxCommand,{type:'inbox.change'}>{
 if(before.outletId===null)throw new Error('Assign the Inbox source to its shop before sorting.');
 return {id:event.id,type:'inbox.change',itemId:before.id,outletId:before.outletId,occurredAt:event.at,revision:before.revision,change:'kind' in change?{kind:change.kind}:{archived:change.archived}};
}
