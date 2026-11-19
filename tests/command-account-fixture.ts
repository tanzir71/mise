import {createHash} from 'node:crypto';
import type {CloudConnection} from '../packages/core/cloud-connection';
import type {CommandAccount} from '../apps/web/src/data/command-request';
import {createCloudCommandRemote} from '../apps/web/src/data/cloud-command-remote';
import {createShopCommandRemote} from '../apps/web/src/data/shop-command-remote';
import {createCloudUploadRemote} from '../apps/web/src/data/cloud-upload-remote';
const userId='00000000-0000-4000-8000-000000000001',scope='/test/app/shop';
/** Explicit synthetic account for the existing literal-command transport fixtures. */
export function testCommandAccount(config:CloudConnection,getJwt:()=>Promise<string>):CommandAccount {
 const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
 return {scope,accountHash:sha(Buffer.from(userId.replaceAll('-',''),'hex')),targetHash:sha(JSON.stringify(['mise-cloud-target-v1',new URL(config.apiUrl).origin,config.publishableKey,scope,userId])),getAuth:async()=>({jwt:await getJwt(),userId,generation:1}),assertCurrent:()=>{/* Explicit synthetic verifier; native tests use PhoneAuth. */}};
}
export function testCloudCommandRemote(config:CloudConnection,getJwt:()=>Promise<string>,send:typeof fetch=fetch){return createCloudCommandRemote(config,testCommandAccount(config,getJwt),send);}
export function testShopCommandRemote(apiUrl:string,publishableKey:string,getJwt:()=>Promise<string>,send:typeof fetch=fetch){return createShopCommandRemote(apiUrl,publishableKey,testCommandAccount({apiUrl,publishableKey},getJwt),send);}
export function testCloudUploadRemote(apiUrl:string,publishableKey:string,getJwt:()=>Promise<string>,send:typeof fetch=fetch){return createCloudUploadRemote(apiUrl,publishableKey,testCommandAccount({apiUrl,publishableKey},getJwt),send);}
