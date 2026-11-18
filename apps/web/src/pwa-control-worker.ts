/// <reference lib="webworker" />
/** Only an owner-app top-level document can request the existing active worker. */
export async function claimOwnerClient(clients:Pick<Clients,'get'|'claim'>,id:string,origin:string,base:string):Promise<void>{
 try{const client=await clients.get(id);if(!client||client.type!=='window'||client.frameType!=='top-level')return;const url=new URL(client.url);if(url.origin!==origin||!url.pathname.startsWith(base)||new RegExp('^'+base.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'s(?:/|$)').test(url.pathname))return;await clients.claim();}catch{/* A closed or inaccessible client keeps the manual offline fallback. */}
}
