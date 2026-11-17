// Server-only. Keep the pepper in Edge Function secrets, outside the database.
// No browser import and no fallback pepper. See docs/m30-delivery.md.
const ITERATIONS=600_000;
const hex=(bytes:Uint8Array)=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
export interface PinScope {businessId:string;memberId:string}
export interface PinCredential {salt:string;verifier:string;pepperVersion:string}
const ulid=/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
export function staffPinPepper(value:string|undefined):Uint8Array{
  if(typeof value!=='string'||!/^(?:[0-9a-f]{2}){32,64}$/.test(value))throw new Error('PIN secret is not configured.');
  return Uint8Array.from(value.match(/../g)!,part=>parseInt(part,16));
}
function saltBytes(value:string){
  if(!/^[0-9a-f]{32}$/.test(value))throw new Error('Invalid PIN salt.');
  return Uint8Array.from(value.match(/../g)!,part=>parseInt(part,16));
}
/** Version 1: PBKDF2-SHA256, then HMAC-SHA256 over scope and derived key. */
export async function deriveStaffPin(pin:string,salt:string,scope:PinScope,pepper:Uint8Array):Promise<string>{
  if(typeof pin!=='string'||!/^[0-9]{4}$/.test(pin))throw new Error('Enter four digits.');
  if(!ulid.test(scope.businessId)||!ulid.test(scope.memberId))throw new Error('Invalid PIN scope.');
  if(!(pepper instanceof Uint8Array)||pepper.byteLength<32||pepper.byteLength>64)throw new Error('PIN secret is not configured.');
  const keyBytes=new Uint8Array(pepper),saltValue=saltBytes(salt),prefix=new TextEncoder().encode(JSON.stringify([1,scope.businessId,scope.memberId]));
  const password=await crypto.subtle.importKey('raw',new TextEncoder().encode(pin),'PBKDF2',false,['deriveBits']);
  const derived=new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:saltValue,iterations:ITERATIONS},password,256));
  const message=new Uint8Array(prefix.length+derived.length);message.set(prefix);message.set(derived,prefix.length);
  const key=await crypto.subtle.importKey('raw',keyBytes,{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC',key,message)));
}
export async function createStaffPin(pin:string,scope:PinScope,pepper:Uint8Array,pepperVersion='v1'):Promise<PinCredential>{
  if(!/^v[1-9][0-9]{0,3}$/.test(pepperVersion))throw new Error('Invalid PIN secret version.');
  const salt=hex(crypto.getRandomValues(new Uint8Array(16)));
  return {salt,verifier:await deriveStaffPin(pin,salt,scope,pepper),pepperVersion};
}
