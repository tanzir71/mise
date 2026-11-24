/** Exercise the built service-worker entry in Chromium. Only browser/provider
 * edges are synthetic; its production event dispatch, native cache and target
 * navigation remain actual code. This is not hosted push timing acceptance. */
export async function installUrgentWorker(context,page){
 await page.evaluate(()=>navigator.serviceWorker.ready.then(()=>undefined));
 const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');
 const capability=await page.evaluate(()=>JSON.parse(localStorage.getItem('__mise_desk_test_capability')));
 await worker.evaluate(input=>{
  const bytes=value=>Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')),character=>character.charCodeAt(0));
  let shown=[],pending=[];
  Object.defineProperty(PushManager.prototype,'getSubscription',{configurable:true,value:async()=>({endpoint:input.endpoint,expirationTime:null,options:{applicationServerKey:bytes(input.applicationKey).buffer},getKey:key=>bytes(input.keys[key]).buffer})});
  Object.defineProperty(self.registration,'showNotification',{configurable:true,value:async(title,options)=>{const note={title,...options,closed:false,close(){this.closed=true;}};shown=shown.filter(row=>row.tag!==note.tag);shown.push(note);}});
  Object.defineProperty(self.registration,'getNotifications',{configurable:true,value:async()=>shown.filter(row=>!row.closed)});
  const windows=self.clients.matchAll.bind(self.clients);
  Object.defineProperty(self.clients,'matchAll',{configurable:true,value:async options=>(await windows(options)).map(client=>({url:client.url,focus:async()=>client,navigate:url=>client.navigate(url),postMessage:value=>client.postMessage(value)}))});
  Object.defineProperty(ExtendableEvent.prototype,'waitUntil',{configurable:true,value:function(work){pending.push(Promise.resolve(work));}});
  async function flush(){while(pending.length){const batch=pending;pending=[];await Promise.all(batch);}}
  self.__miseUrgentTest={async push(notice){self.dispatchEvent(new PushEvent('push',{data:JSON.stringify(notice)}));await flush();},async click(){const note=shown.find(row=>!row.closed);if(!note)throw Error('No current notification');const event=new Event('notificationclick');Object.defineProperty(event,'notification',{value:note});Object.defineProperty(event,'waitUntil',{value:work=>pending.push(Promise.resolve(work))});self.dispatchEvent(event);await flush();},shown:()=>shown.filter(row=>!row.closed).map(({title,body,tag,data})=>({title,body,tag,data})),flush};
 },capability);
 return {
  push:notice=>worker.evaluate(value=>self.__miseUrgentTest.push(value),notice),
  click:()=>worker.evaluate(()=>self.__miseUrgentTest.click()),
  shown:()=>worker.evaluate(()=>self.__miseUrgentTest.shown()),
  flush:()=>worker.evaluate(()=>self.__miseUrgentTest.flush()),
 };
}
