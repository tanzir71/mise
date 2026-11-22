import {createHmac,randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {createKitchenDispatchAuthorization} from '../supabase/functions/_shared/kitchen-dispatch-auth';

const key='A'.repeat(43),at=1795338000000;
const signed=(issuedAt=at,nonce=randomUUID(),limit=25,secret=key)=>{
 const mac=createHmac('sha256',secret).update(`mise:kitchen-dispatch:v1\n${issuedAt}\n${nonce}\n${limit}`).digest('hex');
 return {header:`Bearer v1.${issuedAt}.${nonce}.${mac}`,nonce,issuedAt,limit};
};
it('verifies Node-generated HMAC authorization with Web Crypto without sending the reusable key',async()=>{
 const proof=signed(),verify=createKitchenDispatchAuthorization(key);
 expect(await verify(proof.header,25,at)).toEqual({nonce:proof.nonce,issuedAt:proof.issuedAt,limit:25});expect(proof.header).not.toContain(key);
});
it.each([1,7,25])('binds the authorization to the exact bounded batch size %s',async limit=>{
 const proof=signed(at,randomUUID(),limit),verify=createKitchenDispatchAuthorization(key);expect(await verify(proof.header,limit,at)).not.toBeNull();expect(await verify(proof.header,limit===25?24:limit+1,at)).toBeNull();
});
it.each([-60001,5001])('rejects an authentic proof outside its freshness window (%s ms)',async offset=>{
 const proof=signed(at+offset);expect(await createKitchenDispatchAuthorization(key)(proof.header,25,at)).toBeNull();
});
it.each([-60000,5000])('accepts only the bounded clock tolerance (%s ms)',async offset=>{
 const proof=signed(at+offset);expect(await createKitchenDispatchAuthorization(key)(proof.header,25,at)).toMatchObject({issuedAt:at+offset});
});
it('rejects changed nonce, timestamp, signature, context and a different key',async()=>{
 const proof=signed(),verify=createKitchenDispatchAuthorization(key),different=signed(at,proof.nonce,25,'B'.repeat(43));
 for(const header of [proof.header.replace(proof.nonce,randomUUID()),proof.header.replace(String(at),String(at+1)),proof.header.slice(0,-1)+(proof.header.endsWith('0')?'1':'0'),different.header])expect(await verify(header,25,at)).toBeNull();
 const mac=createHmac('sha256',key).update(`other-purpose\n${at}\n${proof.nonce}\n25`).digest('hex');expect(await verify(`Bearer v1.${at}.${proof.nonce}.${mac}`,25,at)).toBeNull();
});
it('rejects reusable bearer keys, malformed or ambiguous wires and invalid clocks before granting work',async()=>{
 const proof=signed(at,'11111111-1111-4111-8111-11111111111a'),verify=createKitchenDispatchAuthorization(key);
 for(const header of [null,'Bearer '+key,proof.header+' ',proof.header.replace('v1.','v2.'),proof.header.replace(String(at),'0'+at),proof.header.replace(proof.nonce,proof.nonce.toUpperCase()),proof.header.replace(proof.nonce,'00000000-0000-0000-0000-000000000000')])expect(await verify(header,25,at)).toBeNull();
 for(const limit of [0,26,1.5,NaN])expect(await verify(proof.header,limit,at)).toBeNull();
 for(const clock of [-1,Infinity,NaN,8640000000000001])expect(await verify(proof.header,25,clock)).toBeNull();
});
it('requires a configured independent worker key',()=>{
 for(const secret of ['',key.slice(1),'sb_secret_test_only'])expect(()=>createKitchenDispatchAuthorization(secret)).toThrow('unavailable');
});
