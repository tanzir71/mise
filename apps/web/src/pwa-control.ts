/** Reclaim a document whose navigation began before first activation finished. */
export function requestWorkerControl(registration:ServiceWorkerRegistration,container:Pick<ServiceWorkerContainer,'controller'>=navigator.serviceWorker):void {
 if(container.controller)return;const worker=registration.active??registration.installing;if(!worker)return;
 const claim=()=>{
  if(worker.state==='activated'||worker.state==='redundant')worker.removeEventListener('statechange',claim);
  if(worker.state==='activated'&&!container.controller)try{worker.postMessage({type:'MISE_CLAIM_CLIENT'});}catch{/* Keep the offline/backup fallback if the browser has stopped this worker. */}
 };
 if(worker.state==='activated')claim();else if(worker.state!=='redundant')worker.addEventListener('statechange',claim);
}
