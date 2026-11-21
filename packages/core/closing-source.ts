import {parseClosingCommand,type ClosingCommand} from './closing-commands';
import {closingReviewSourceAudits} from './closing-review-source';
import type {LocalRowChange,LocalOutboxEntry} from './local-outbox';
import type {ShopCommand} from './shop-commands';

export const savedClosingParentHeader='X-Mise-Closing-Parent';
export const validClosingParent=(value:unknown):value is string=>typeof value==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value);
/** Bind an undo to the actual original creation event. A reviewed replacement
 * keeps the closing ID but can change its cash effect and primary event. */
export function savedClosingParent(command:ClosingCommand,changes:readonly LocalRowChange[]):string|null{
 if(command.type!=='closing.undo')return null;
 const wanted=[command.id,...(command.saleEventId?[command.saleEventId]:[])],events=changes.filter(row=>row.table==='events'&&wanted.includes(row.key));
 if(events.length!==wanted.length||new Set(events.map(row=>row.key)).size!==events.length||events.some(row=>row.before!==null||!row.after||typeof row.after!=='object'||(row.after as {id:unknown}).id!==row.key))throw Error('Keep the original closing undo source and companion audit.');
 const before=closingReviewSourceAudits(command,events.map(row=>row.after))[0].before;
 if(!before||!validClosingParent(before.eventId))throw Error('Keep the original closing creation event.');
 return before.eventId;
}
/** Only original queue evidence may select the undo parent, never a remade
 * working projection or the current server row. Covered commands need no read. */
export function originalClosingParentReader(entries:readonly Pick<LocalOutboxEntry,'commands'|'changes'>[]){
 const sources=new Map<string,{command:ShopCommand;changes:readonly LocalRowChange[]}>();
 for(const row of entries)for(const command of row.commands){if(sources.has(command.id))throw Error('Keep each original closing command identity.');sources.set(command.id,{command,changes:row.changes});}
 return (command:ShopCommand):string|null=>{
  if(command.type!=='closing.undo')return null;
  const source=sources.get(command.id);
  if(!source||source.command.type!=='closing.undo'||JSON.stringify(parseClosingCommand(source.command))!==JSON.stringify(parseClosingCommand(command)))throw Error('Keep the original pending closing undo.');
  return savedClosingParent(command,source.changes);
 };
}
