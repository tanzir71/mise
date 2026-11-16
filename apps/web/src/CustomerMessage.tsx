import { useLiveQuery } from 'dexie-react-hooks';
import { Modal } from '@mise/ui/Modal.tsx';
import type { SetupSnapshot } from '@mise/core/models';
import { db } from './data/db';
import { MessageHandoff } from './MessageHandoff';

export function CustomerMessage({id,setup,onClose}:{id:string;setup:SetupSnapshot;onClose:()=>void}){
  const customer=useLiveQuery(async()=>(await db.customers.get(id))||null,[id]);
  if(!customer||customer.businessId!==setup.business.id||customer.archivedAt!==undefined)return <Modal open title="Message customer" variant="sheet" closeLabel="Close message" onClose={onClose}><p role="status">{customer===undefined?'Preparing…':'This customer is unavailable. Reopen their current profile.'}</p></Modal>;
  const name=(customer.nickname||customer.name).replace(/\s+/g,' '),shop=setup.business.name.replace(/\s+/g,' '),text=[setup.business.languages.includes('bn')&&`আসসালামু আলাইকুম ${name}, ${shop} থেকে বলছি। কিছু লাগলে আমাদের জানাবেন।`,setup.business.languages.includes('en')&&`Hi ${name}, this is ${shop}. Let us know if you need anything.`].filter(Boolean).join('\n\n');
  return <MessageHandoff title="Message customer" draft={{source:{kind:'customer',id:customer.id},purpose:'win-back',text,target:customer.phone?'whatsapp':'copy',phone:customer.phone}} onClose={onClose}/>;
}
