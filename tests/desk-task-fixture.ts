import type {DeskPushContext} from '../packages/core/desk-push';
export const deskId=(n:number)=>String(n).padStart(26,'0');
export const deskScope:DeskPushContext={v:1,businessId:deskId(1),outletId:deskId(2),memberId:deskId(3),role:'owner'};
export const deskTaskRow=(n:number)=>({id:deskId(100+n),orderId:deskId(200+n),contentHash:'a'.repeat(64),sourceRevision:1,generation:1,
 titleJson:JSON.stringify('Order A-'+n+' needs Got it'),bodyJson:JSON.stringify('No preparation acknowledgement after 2 minutes.'),
 actionsJson:JSON.stringify([{kind:'open-order',orderId:deskId(200+n)},{kind:'copy',text:'Order A-'+n+' needs Got it'}]),dueAt:1000,raisedAt:2000,updatedAt:2000});
export const deskPage=(numbers:number[],more=false)=>({v:1,access:deskScope,at:3000,version:12,settings:{enabled:true,minutes:2,revision:0},tasks:numbers.map(deskTaskRow),next:more?{dueAt:1000,id:deskId(100+numbers.at(-1)!)}:null});
