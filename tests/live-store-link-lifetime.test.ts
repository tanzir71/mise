import {afterAll,beforeAll,it,expect} from 'vitest';
import {startCustomerLinkService} from './fixtures/customer-link-service';
import {newInboxId} from '../packages/core/inbox';
let service:Awaited<ReturnType<typeof startCustomerLinkService>>;
beforeAll(async()=>{service=await startCustomerLinkService({liveStore:true,ordering:true});},30000);afterAll(async()=>{await service?.close();});
it('keeps actually approved no-expiry shop links and table labels live, then removes a genuinely revoked publication',async()=>{
 const one=await service.publishShop('T-1'),two=await service.publishShop('T-2','T'.repeat(43)),config=service.config(),headers={Authorization:'Bearer '+config.jwt,apikey:config.publishableKey,'Content-Type':'application/json'},body={p_outlet_id:config.records.setup.outlet.id,p_all_outlets:false,p_period:'today',p_after_outlet:null,p_view_outlet_id:null};
 const read=async()=>{const response=await fetch(config.apiUrl+'/rest/v1/rpc/read_live_store',{method:'POST',headers,body:JSON.stringify(body)});expect(response.status).toBe(200);return response.json() as Promise<{detail:{orderingLinks:number;tables:{labelJson:string}[]}}>;};
 const initial=await read();expect(initial.detail.orderingLinks).toBe(2);expect(initial.detail.tables.map(t=>JSON.parse(t.labelJson))).toEqual(['T-1','T-2']);expect(one.metadata.expiresAt??null).toBeNull();expect(two.metadata.expiresAt??null).toBeNull();
 const response=await fetch(config.apiUrl+'/rest/v1/rpc/revoke_public_shop',{method:'POST',headers,body:JSON.stringify({p_id:one.metadata.id,p_event_id:newInboxId(),p_outlet_id:config.records.setup.outlet.id})});expect(response.status).toBe(200);const current=await read();expect(current.detail.orderingLinks).toBe(1);expect(current.detail.tables.map(t=>JSON.parse(t.labelJson))).toEqual(['T-2']);
});
