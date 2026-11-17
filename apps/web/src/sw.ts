/// <reference lib="webworker" />
import { clientsClaim } from 'workbox-core';
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { LocalStore } from './data/local-store';
import { captureDatabaseInbox } from './data/inbox';
import { receiveSharedRequest } from './data/share-target';

declare const self:ServiceWorkerGlobalScope & {__WB_MANIFEST:(string|{url:string;revision?:string|null})[]};
const base=new URL(self.registration.scope).pathname;
clientsClaim();cleanupOutdatedCaches();precacheAndRoute(self.__WB_MANIFEST);
registerRoute(new NavigationRoute(createHandlerBoundToURL(`${base}index.html`),{denylist:[new RegExp('^'+base.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'s(?:/|$)')]}));
registerRoute(({url,request})=>url.origin===self.location.origin&&url.pathname===`${base}inbox/receive`&&request.mode==='navigate'&&request.destination==='document',async({request})=>{
  const store=new LocalStore(`mise-local:${base}`);
  try{return await receiveSharedRequest(request,base,input=>captureDatabaseInbox(store,input));}finally{store.close();}
},'POST');
// Updating an open form still requires the owner's explicit Reload action.
self.addEventListener('message',event=>{if(event.data?.type==='SKIP_WAITING')void self.skipWaiting();});
