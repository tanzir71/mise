import {newHandoffActionId,type HandoffCompletion,type HandoffSession} from './handoff';
import type {HandoffCompletionChange} from './handoff-completion';
import type {HandoffCommand,HandoffRelatedIds} from './handoff-commands';
import type {HandoffChoice} from './handoff-progress';
import type {AuditEvent} from './models';

type Change={session:HandoffSession;event:AuditEvent};
export function handoffPrepareIntent(change:Change):Extract<HandoffCommand,{type:'handoff.prepare'}>{
 return {id:change.event.id,type:'handoff.prepare',outletId:change.session.outletId,occurredAt:change.event.at,draft:change.session.draft};
}
/** Keep actual companion IDs; a reused supplier message creates no second audit. */
export function handoffChangeIntent(before:HandoffSession,change:Change,choice:HandoffChoice,completion:HandoffCompletion|undefined,effects:HandoffCompletionChange|undefined,newId= newHandoffActionId):Extract<HandoffCommand,{type:'handoff.change'}>{
 let related:HandoffRelatedIds|null=null;
 if(completion){const record=effects?.entries[0]??effects?.communication??effects?.message??effects?.reusedMessage;if(!record)throw new Error('Keep the complete Sent companion.');related={recordId:record.id,eventId:effects?.reusedMessage?newId():record.eventId};}
 return {id:change.event.id,type:'handoff.change',outletId:change.session.outletId,occurredAt:change.event.at,handoffId:before.id,revision:before.progress.revision,choice,completion:completion??null,related};
}
