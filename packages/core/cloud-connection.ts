export interface CloudConnection {apiUrl:string;publishableKey:string}
export const cloudConnectionStorageKey='mise.cloud.connection.v1';
export interface KeyStorage {getItem(key:string):string|null;setItem(key:string,value:string):void;removeItem(key:string):void}
/** Runtime configuration only; never derive a deployment value from build variables. */
export function parseCloudConnection(value:unknown):CloudConnection {
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='apiUrl,publishableKey')throw new Error('Enter the project URL and publishable key.');
 const v=value as Record<string,unknown>;
 if(typeof v.apiUrl!=='string'||v.apiUrl.length>2048||typeof v.publishableKey!=='string'||v.publishableKey.length>512)throw new Error('Enter the project URL and publishable key.');
 let url:URL;try{url=new URL(v.apiUrl.trim());}catch{throw new Error('Use the project’s HTTPS address.');}
 if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||!(url.protocol==='https:'||url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname)))throw new Error('Use the project’s HTTPS address without a path.');
 const publishableKey=v.publishableKey.trim();if(!/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey))throw new Error('Use the project’s publishable key for this device.');
 return Object.freeze({apiUrl:url.origin,publishableKey});
}
export function readCloudConnection(storage:KeyStorage):CloudConnection|null {
 let raw:string|null;try{raw=storage.getItem(cloudConnectionStorageKey);}catch{throw new Error('This browser could not read its saved connection.');}if(!raw)return null;if(raw.length>4096)throw new Error('Review this device’s connection settings.');
 try{return parseCloudConnection(JSON.parse(raw));}catch{throw new Error('Review this device’s connection settings.');}
}
export function saveCloudConnection(storage:KeyStorage,input:unknown):CloudConnection {const config=parseCloudConnection(input);try{storage.setItem(cloudConnectionStorageKey,JSON.stringify(config));}catch{throw new Error('This browser could not save the connection. Try again.');}return config;}
export async function cloudAuthStorageKey(input:CloudConnection,scope:string){const config=parseCloudConnection(input);const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([config.apiUrl,config.publishableKey,scope]))));return 'mise.cloud.auth.'+Array.from(hash,b=>b.toString(16).padStart(2,'0')).join('');}
/** A private target identifier, never a credential or an authorization decision. */
export async function cloudConnectionTarget(input:CloudConnection,scope:string,userId:string):Promise<string>{
 const config=parseCloudConnection(input);if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(userId)||!scope||scope.length>2048)throw new Error('Use the verified account and local shop scope.');
 const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(['mise-cloud-target-v1',config.apiUrl,config.publishableKey,scope,userId.toLowerCase()]))));return Array.from(hash,b=>b.toString(16).padStart(2,'0')).join('');
}
export function normalisePhoneCode(value:string):string {const code=value.replace(/[০-৯]/g,d=>String(d.charCodeAt(0)-0x09e6)).replace(/\s/g,'');if(!/^\d{6,10}$/.test(code))throw new Error('Enter the verification code from your SMS.');return code;}
