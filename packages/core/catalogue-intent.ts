import {normaliseItemInput,type ItemCommand,type ItemInput} from './catalogue-save';
import type {CloudCommand,CatalogueWrite} from './cloud-commands';
import type {AuditEvent,Item} from './models';
export function catalogueSaveIntent(change:ItemCommand,input:ItemInput):CatalogueWrite {
 if(change.event.command!=='catalogue.create'&&change.event.command!=='catalogue.update')throw new Error('Keep the original catalogue save.');
 return {id:change.event.id,type:change.event.command,itemId:change.item.id,outletId:change.item.outletId,occurredAt:change.event.at,categoryId:change.item.categoryId,input:normaliseItemInput(input)};
}
export function catalogueAvailabilityIntent(change:ItemCommand):CloudCommand {
 return {id:change.event.id,type:'catalogue.availability',itemId:change.item.id,outletId:change.item.outletId,occurredAt:change.event.at,available:change.item.available};
}
export function catalogueDeleteIntent(before:Item,event:AuditEvent):CatalogueWrite {
 if(event.command!=='catalogue.delete'&&event.command!=='catalogue.remove-sample')throw new Error('Keep the original catalogue removal.');
 return {id:event.id,type:event.command,itemId:before.id,outletId:before.outletId,occurredAt:event.at};
}
