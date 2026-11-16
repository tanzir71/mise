/** Shared by the owner interface and the small public customer page. No browser or database imports. */
export type HandoffChannel = 'manual'|'whatsapp'|'call'|'share';
export type HandoffAction = 'open'|'copy'|'copy-failed'|'failed'|'sent'|'undo-sent';
export type HandoffStatus = 'ready'|'opened'|'copied'|'failed'|'sent';
export interface HandoffProgress {
  revision:number;status:HandoffStatus;lastAttempt:'prepared'|'open'|'copy'|'copy-failed'|'failed';channel:HandoffChannel;updatedAt:number;
  openedAt?:number;copiedAt?:number;failedAt?:number;sentAt?:number;sentChannel?:HandoffChannel;
}
export interface HandoffChoice {type:HandoffAction;channel?:Exclude<HandoffChannel,'manual'>}
const channels:readonly string[]=['manual','whatsapp','call','share'];
const choices:readonly string[]=['open','copy','copy-failed','failed','sent','undo-sent'];
const attemptStatus={prepared:'ready',open:'opened',copy:'copied','copy-failed':'failed',failed:'failed'} as const;
function timestamp(value:unknown):value is number{return Number.isSafeInteger(value)&&(value as number)>=0&&(value as number)<=253402300799999;}
export function assertHandoffProgress(value:unknown):asserts value is HandoffProgress {
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new Error('This message progress is unsupported.');
  const row=value as Record<string,unknown>,allowed=['revision','status','lastAttempt','channel','updatedAt','openedAt','copiedAt','failedAt','sentAt','sentChannel'];
  if(Object.keys(row).some(key=>!allowed.includes(key))||!Number.isSafeInteger(row.revision)||(row.revision as number)<1||typeof row.status!=='string'||!['ready','opened','copied','failed','sent'].includes(row.status)||typeof row.lastAttempt!=='string'||!Object.hasOwn(attemptStatus,row.lastAttempt)||typeof row.channel!=='string'||!channels.includes(row.channel)||!timestamp(row.updatedAt))throw new Error('This message progress is unsupported.');
  for(const key of ['openedAt','copiedAt','failedAt','sentAt'])if(row[key]!==undefined&&(!timestamp(row[key])||(row[key] as number)>(row.updatedAt as number)))throw new Error('This message progress has an invalid time.');
  if((row.status==='sent')!==(row.sentAt!==undefined)||(row.sentAt!==undefined)!==(row.sentChannel!==undefined)||(row.sentChannel!==undefined&&(typeof row.sentChannel!=='string'||!channels.includes(row.sentChannel))))throw new Error('This message progress has an invalid confirmation.');
  if(row.sentAt===undefined&&row.status!==attemptStatus[row.lastAttempt as keyof typeof attemptStatus])throw new Error('This message progress has an invalid action.');
  if(row.lastAttempt==='prepared'&&(row.channel!=='manual'||['openedAt','copiedAt','failedAt'].some(key=>row[key]!==undefined))||row.lastAttempt==='open'&&(row.openedAt===undefined||row.channel==='manual')||row.lastAttempt==='copy'&&(row.copiedAt===undefined||row.channel!=='manual')||row.lastAttempt==='copy-failed'&&(row.failedAt===undefined||row.channel!=='manual')||row.lastAttempt==='failed'&&row.failedAt===undefined)throw new Error('This message progress is missing its action.');
}
export function newHandoffProgress(at:number):HandoffProgress {
  if(!timestamp(at))throw new Error('Use a valid message time.');
  return {revision:1,status:'ready',lastAttempt:'prepared',channel:'manual',updatedAt:at};
}
/** Open/Copy never confirm delivery. Only the owner's explicit Sent choice does that. */
export function changeHandoffProgress(previous:HandoffProgress,choice:HandoffChoice,at:number):HandoffProgress {
  assertHandoffProgress(previous);
  return transition(previous,choice,at);
}
/** Rebuilds progress from validated choices, rather than trusting a stored state snapshot. */
export function replayHandoffProgress(at:number,steps:readonly (HandoffChoice&{at:number})[]):HandoffProgress {
  let state=newHandoffProgress(at);for(const {at,...choice} of steps)state=transition(state,choice,at);return state;
}
function transition(previous:HandoffProgress,choice:HandoffChoice,at:number):HandoffProgress {
  if(!timestamp(at)||at<previous.updatedAt)throw new Error('Use a message time after the previous action.');
  if(!choice||!choices.includes(choice.type)||Object.keys(choice).some(key=>!['type','channel'].includes(key))||(choice.type==='open'?choice.channel===undefined||!['whatsapp','call','share'].includes(choice.channel):choice.channel!==undefined))throw new Error('Choose a supported message action.');
  if(previous.revision===Number.MAX_SAFE_INTEGER)throw new Error('This message has too many actions. Start a new attempt.');
  if(choice.type==='failed'&&previous.sentAt!==undefined)throw new Error('Undo Sent before recording a failure.');
  if(choice.type==='sent'&&previous.sentAt!==undefined)throw new Error('This attempt is already marked sent.');
  if(choice.type==='undo-sent'&&(previous.sentAt===undefined||at-previous.sentAt>600000))throw new Error('Undo Sent within ten minutes.');
  const next:HandoffProgress={...previous,revision:previous.revision+1,updatedAt:at};
  if(choice.type==='sent'){next.sentAt=at;next.sentChannel=previous.channel;next.status='sent';}
  else if(choice.type==='undo-sent'){delete next.sentAt;delete next.sentChannel;next.status=attemptStatus[previous.lastAttempt];}
  else {
    next.lastAttempt=choice.type;
    next.status=previous.sentAt===undefined?attemptStatus[choice.type]:'sent';
    if(choice.type==='open'){next.channel=choice.channel!;next.openedAt=at;}
    else if(choice.type==='copy'){next.channel='manual';next.copiedAt=at;}
    else {if(choice.type==='copy-failed')next.channel='manual';next.failedAt=at;}
  }
  return next;
}
