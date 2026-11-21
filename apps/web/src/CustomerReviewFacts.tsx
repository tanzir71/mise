import {useState} from 'react';
import {Button} from '@mise/ui/primitives.tsx';
import {formatMoney} from '@mise/core/money';
import type {CustomerCommand} from '@mise/core/customer-commands';
import type {CustomerReviewSource,CustomerSourceOpening} from '@mise/core/customer-review-source';
import type {CreditAccount} from '@mise/core/models';

/** Make invisible saved code units legible without normalizing literal text. */
export const customerDisplayText=(value:string)=>value.replace(/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/gu,char=>JSON.stringify(char).slice(1,-1));
export function customerActionName(command:CustomerCommand):string{return command.type==='customer.create'?'New customer and khata':command.type==='customer.update'?'Saved customer details':command.type==='customer.archive'?'Archive customer':command.type==='customer.restore'?'Restore customer':'Saved khata settings';}
function Literal({value,empty='None'}:{value:string;empty?:string}){
 const [expanded,setExpanded]=useState(false);
 if(value.length<=250)return <>{value?customerDisplayText(value):empty}</>;
 return <details onToggle={event=>setExpanded(event.currentTarget.open)}><summary>Full saved text ({value.length.toLocaleString('en')} characters)</summary>{expanded?<pre className="order-review-source">{customerDisplayText(value)}</pre>:null}</details>;
}
interface ProfileFacts {name:string;nickname:string;phone?:string|null;address:string;notes:string;tags:string[];archived?:boolean;archivedAt?:number|null}
export function CustomerProfileFacts({profile}:{profile:ProfileFacts}){
 return <dl className="customer-review-fields"><div><dt>Name</dt><dd><Literal value={profile.name}/></dd></div><div><dt>Nickname</dt><dd><Literal value={profile.nickname}/></dd></div><div><dt>Phone</dt><dd><Literal value={profile.phone??''} empty="Not saved"/></dd></div><div><dt>Address</dt><dd><Literal value={profile.address}/></dd></div><div><dt>Tags</dt><dd><Literal value={profile.tags.join(', ')}/></dd></div><div><dt>Customer</dt><dd>{profile.archived===true||profile.archivedAt!=null?'Archived':'Active'}</dd></div><div><dt>Notes</dt><dd><Literal value={profile.notes}/></dd></div></dl>;
}
export function CustomerAccountFacts({account,balance}:{account:Pick<CreditAccount,'currency'|'allowed'|'limit'|'reminder'>;balance?:number}){
 return <dl className="customer-review-fields"><div><dt>Currency</dt><dd>{account.currency}</dd></div><div><dt>Allow baki</dt><dd>{account.allowed?'Allowed':'Not allowed'}</dd></div><div><dt>Limit</dt><dd className="money">{formatMoney(account.limit,account.currency)}</dd></div>{balance!==undefined?<div><dt>Current balance</dt><dd className="money">{formatMoney(balance,account.currency)}</dd></div>:null}<div><dt>Monthly reminder</dt><dd>{account.reminder.enabled?`Day ${account.reminder.dayOfMonth} · ${account.reminder.tone} · WhatsApp`:'Off'}</dd></div></dl>;
}
export function CustomerOpeningFacts({opening,timezone}:{opening:Pick<CustomerSourceOpening,'amount'|'currency'|'occurredAt'>;timezone:string}){
 return <dl className="customer-review-fields"><div><dt>Opening balance</dt><dd className="money">{formatMoney(opening.amount,opening.currency)}</dd></div><div><dt>Balance date</dt><dd>{new Date(opening.occurredAt).toLocaleString('en-GB',{timeZone:timezone})} · {timezone}</dd></div></dl>;
}
export function CopyCustomerReview({source,command}:{source:CustomerReviewSource;command:CustomerCommand}){
 const [manual,setManual]=useState(false),[notice,setNotice]=useState('');
 // Complete source, including original account and opening audit images. Never
 // include a server token, runtime connection or guessed historical name.
 const text=JSON.stringify({action:customerActionName(command),command,source},null,2);
 async function copy(){try{await navigator.clipboard.writeText(text);setManual(false);setNotice('Saved customer details copied.');}catch{setManual(true);setNotice('Select the saved details below to copy them.');}}
 return <><Button kind="secondary" onClick={()=>void copy()}>Copy saved customer details</Button>{notice?<p role="status">{notice}</p>:null}{manual?<label className="customer-review-copy">Saved customer details<textarea readOnly rows={6} value={text} onFocus={event=>event.currentTarget.select()}/></label>:null}</>;
}
