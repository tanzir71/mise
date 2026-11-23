/// <reference lib="webworker" />
import { clientsClaim } from 'workbox-core';
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { LocalStore } from './data/local-store';
import { captureDatabaseInbox } from './data/inbox';
import { receiveSharedRequest } from './data/share-target';
import { claimOwnerClient } from './pwa-control-worker';
import {DeskCache} from './data/desk-cache';
import {deskPushSource} from './data/desk-browser-push';
import {createDeskNotificationWorker} from './desk-notification-worker';

declare const self:ServiceWorkerGlobalScope & {__WB_MANIFEST:(string|{url:string;revision?:string|null})[]};
const base=new URL(self.registration.scope).pathname;
async function deskWork(work:(worker:ReturnType<typeof createDeskNotificationWorker>)=>Promise<void>){
 const native=new LocalStore(`mise-local:${base}`),cache=new DeskCache(base);
 try{const worker=createDeskNotificationWorker({origin:self.location.origin,base,native,cache,source:async()=>{const subscription=await self.registration.pushManager.getSubscription();return subscription?deskPushSource(subscription):null;},show:(title,options)=>self.registration.showNotification(title,options),notifications:()=>self.registration.getNotifications(),windows:()=>self.clients.matchAll({type:'window',includeUncontrolled:false}),open:url=>self.clients.openWindow(url)});await work(worker);}finally{native.close();cache.close();}
}
function ownDeskClient(source:unknown){if(!source||typeof source!=='object'||!('url'in source)||typeof source.url!=='string')return false;try{const url=new URL(source.url);return url.origin===self.location.origin&&url.pathname.startsWith(base);}catch{return false;}}
self.addEventListener('push',event=>{let data:unknown;try{data=event.data?.json();}catch{return;}event.waitUntil(deskWork(worker=>worker.push(data)).catch(()=>{/* Inbox remains the manual fallback. */}));});
self.addEventListener('notificationclick',event=>{event.waitUntil(deskWork(worker=>worker.click(event.notification)).catch(()=>{event.notification.close();}));});
self.addEventListener('message',event=>{if(event.data?.type==='MISE_DESK_RECHECK'&&ownDeskClient(event.source))event.waitUntil(deskWork(worker=>worker.recheck()).catch(()=>{}));});
clientsClaim();cleanupOutdatedCaches();precacheAndRoute(self.__WB_MANIFEST);
registerRoute(new NavigationRoute(createHandlerBoundToURL(`${base}index.html`),{denylist:[new RegExp('^'+base.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'[so](?:/|$)')]}));
registerRoute(({url,request})=>url.origin===self.location.origin&&url.pathname===`${base}inbox/receive`&&request.mode==='navigate'&&request.destination==='document',async({request})=>{
  const store=new LocalStore(`mise-local:${base}`);
  try{return await receiveSharedRequest(request,base,input=>captureDatabaseInbox(store,input));}finally{store.close();}
},'POST');
// Updating an open form still requires the owner's explicit Reload action.
self.addEventListener('message',event=>{if(event.data?.type==='SKIP_WAITING')void self.skipWaiting();else if(event.data?.type==='MISE_CLAIM_CLIENT'&&event.source&&'id'in event.source)event.waitUntil(claimOwnerClient(self.clients,event.source.id,self.location.origin,base));});
