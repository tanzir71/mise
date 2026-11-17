import {pbkdf2Sync,createHmac} from 'node:crypto';
import {expect,it} from 'vitest';
import {createStaffPin,deriveStaffPin} from '../supabase/functions/_shared/staff-pin';
const scope={businessId:'01KABQ9JC00000000000000001',memberId:'01KABQ9JC00000000000000002'},pepper=new Uint8Array(32).fill(37),salt='0123456789abcdef0123456789abcdef';
it('matches an independent PBKDF2/HMAC implementation and binds the shop/member',async()=>{
  const derived=pbkdf2Sync('0042',Buffer.from(salt,'hex'),600000,32,'sha256');
  const expected=createHmac('sha256',pepper).update(JSON.stringify([1,scope.businessId,scope.memberId])).update(derived).digest('hex');
  expect(await deriveStaffPin('0042',salt,scope,pepper)).toBe(expected);
  expect(await deriveStaffPin('0043',salt,scope,pepper)).not.toBe(expected);
  expect(await deriveStaffPin('0042',salt,{...scope,memberId:'01KABQ9JC00000000000000003'},pepper)).not.toBe(expected);
  expect(await deriveStaffPin('0042',salt,scope,new Uint8Array(32).fill(38))).not.toBe(expected);
});
it('creates fresh salts and emits only a versioned verifier, never the PIN or pepper',async()=>{
  const a=await createStaffPin('1234',scope,pepper),b=await createStaffPin('1234',scope,pepper);
  expect(a.salt).toMatch(/^[a-f0-9]{32}$/);expect(a.verifier).toMatch(/^[a-f0-9]{64}$/);expect(a.pepperVersion).toBe('v1');
  expect(a.salt).not.toBe(b.salt);expect(a.verifier).not.toBe(b.verifier);expect(Object.keys(a).sort()).toEqual(['pepperVersion','salt','verifier']);
});
it.each(['','123','12345',' 1234','1234 ','১২৩৪','1e03','12\n3','1.23'])('rejects malformed PIN %j',async value=>{
  await expect(createStaffPin(value,scope,pepper)).rejects.toThrow('four digits');
});
it.each(['','abc','G'.repeat(32),'1'.repeat(30)])('rejects malformed salt %j',async value=>{
  await expect(deriveStaffPin('1234',value,scope,pepper)).rejects.toThrow('salt');
});
it('fails closed on missing/short secrets, unsupported versions and invalid scope',async()=>{
  await expect(createStaffPin('1234',scope,new Uint8Array())).rejects.toThrow('not configured');
  await expect(createStaffPin('1234',scope,pepper,'v0')).rejects.toThrow('version');
  await expect(createStaffPin('1234',{...scope,memberId:'foreign'},pepper)).rejects.toThrow('scope');
});
