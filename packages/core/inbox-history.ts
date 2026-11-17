import type { AuditEvent } from './models';
import { inboxSnapshot, validateInboxItem, type InboxItem } from './inbox';

function key(item:InboxItem):string {
  return JSON.stringify([item.id,item.outletId,item.revision,item.title,item.text,item.url,item.images.map(i=>[i.id,i.name,i.type,i.size]),item.kind,item.archived,item.createdAt,item.updatedAt]);
}
function snapshot(value:unknown):InboxItem {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid Inbox audit snapshot.');
  const item=value as InboxItem;validateInboxItem(item);
  const fields=['id','outletId','revision','title','text','url','images','kind','archived','createdAt','updatedAt'];
  if(Object.keys(item).length!==fields.length||Object.keys(item).some(k=>!fields.includes(k))||item.images.some(image=>Object.keys(image).length!==4||Object.keys(image).some(k=>!['id','name','type','size'].includes(k))))throw new Error('Inbox audit snapshots must contain metadata only.');
  return item;
}
/** Restore must preserve a complete, linear manual sorting history. */
export function validateInboxHistory(items:readonly InboxItem[],events:readonly AuditEvent[]):void {
  const grouped=new Map<string,AuditEvent[]>(),ids=new Set(items.map(i=>i.id));
  for(const event of events){
    if(!event.command.startsWith('inbox.')&&event.inboxId===undefined&&event.inboxRevision===undefined)continue;
    if(!event.inboxId||!ids.has(event.inboxId)||!Number.isSafeInteger(event.inboxRevision)||!event.command.startsWith('inbox.'))throw new Error('Invalid Inbox audit reference.');
    const group=grouped.get(event.inboxId)??[];group.push(event);grouped.set(event.inboxId,group);
  }
  for(const item of items){
    validateInboxItem(item);const history=(grouped.get(item.id)??[]).sort((a,b)=>a.inboxRevision!-b.inboxRevision!);
    if(item.outletId===null){if(history.length)throw new Error('An unassigned share cannot have shop audit history.');continue;}
    if(history.length!==item.revision)throw new Error('Inbox audit history is incomplete.');
    let previous:InboxItem|null=null;
    for(const [index,event] of history.entries()){
      const after=snapshot(event.after);
      if(after.id!==item.id||after.outletId!==item.outletId||event.outletId!==item.outletId||after.revision!==index+1||event.inboxRevision!==after.revision||event.at!==after.updatedAt||event.actor.type!=='member')throw new Error('Invalid Inbox audit revision.');
      if(!previous){if(event.command!=='inbox.capture'||event.before!==null||after.kind!=='unclassified'||after.archived)throw new Error('Invalid Inbox capture history.');}
      else {
        const before=snapshot(event.before);if(key(before)!==key(previous)||after.updatedAt<before.updatedAt)throw new Error('Inbox audit history contains a fork.');
        const classified=event.command==='inbox.classify'&&after.kind!==before.kind;
        const archived=(event.command==='inbox.archive'||event.command==='inbox.reopen')&&after.archived===(event.command==='inbox.archive')&&after.archived!==before.archived;
        const expected={...before,revision:before.revision+1,updatedAt:after.updatedAt,...(classified?{kind:after.kind}:archived?{archived:after.archived}:{})};
        if((!classified&&!archived)||key(after)!==key(expected))throw new Error('Invalid manual Inbox action.');
      }
      previous=after;
    }
    if(!previous||key(previous)!==key(inboxSnapshot(item)))throw new Error('Inbox record differs from its audit history.');
  }
}
