import type {StaffDraft} from '@mise/core/staff';
export const staffRoleNames={owner:'Owner',manager:'Manager',staff:'Desk',kitchen:'Kitchen',rider:'Rider',agent:'Agent'};
export const staffClock=(value:number)=>String(Math.floor(value/60)).padStart(2,'0')+':'+String(value%60).padStart(2,'0');
export function staffDraftText(draft:StaffDraft):string {
 const days=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
 return [draft.active?'Team member change':'Remove from team',draft.name,draft.nameLocal,staffRoleNames[draft.role],draft.phone??'No contact number',
  `Station: ${draft.station||'Not set'}`,`WhatsApp on this number: ${draft.whatsapp?'Yes':'No'}`,
  draft.language==='bn'?'Messages in Bangla':'Messages in English',draft.shift?`Usual shift: ${draft.shift.days.map(day=>days[day]).join(', ')} · ${staffClock(draft.shift.start)}–${staffClock(draft.shift.end)}`:'No usual shift configured',
  `Check-in methods: ${draft.methods.length?draft.methods.map(method=>({link:'Their own staff link',order_phone:'Order phone',group:'Staff group'})[method]).join(', '):'Manager logs by hand'}`,
  ...([['confirmOrders','Confirm orders'],['updateStock','Update stock'],['viewOwnPerformance','See own performance']] as const).map(([key,label])=>`Requested preference · ${label}: ${draft.permissions[key]?'Yes':'No'}`)].filter(Boolean).join('\n');
}
