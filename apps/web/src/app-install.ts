import { useSyncExternalStore } from 'react';

interface InstallPrompt extends Event {
  prompt:()=>Promise<void>;
  userChoice:Promise<{outcome:'accepted'|'dismissed'}>;
}
interface InstallState {installed:boolean;canPrompt:boolean;busy:boolean;message:string;offlineReady:boolean}
const display=matchMedia('(display-mode: standalone)'),listeners=new Set<()=>void>();
const installed=()=>display.matches||(navigator as Navigator&{standalone?:boolean}).standalone===true;
let prompt:InstallPrompt|null=null;
let state:InstallState={installed:installed(),canPrompt:false,busy:false,message:'',offlineReady:Boolean(navigator.serviceWorker?.controller)};
function update(change:Partial<InstallState>){state={...state,...change};for(const listener of listeners)listener();}
window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();prompt=event as InstallPrompt;update({canPrompt:true,message:''});});
window.addEventListener('appinstalled',()=>{prompt=null;update({installed:true,canPrompt:false,busy:false,message:'Mise is installed on this device.'});});
display.addEventListener('change',()=>update({installed:installed()}));
if('serviceWorker' in navigator){
  navigator.serviceWorker.addEventListener('controllerchange',()=>update({offlineReady:Boolean(navigator.serviceWorker.controller)}));
  void navigator.serviceWorker.ready.then(()=>update({offlineReady:Boolean(navigator.serviceWorker.controller)})).catch(()=>{});
}
const subscribe=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};};
export function useAppInstall(){return useSyncExternalStore(subscribe,()=>state);}
export async function installApp(){
  if(!prompt||state.busy||state.installed)return;
  const current=prompt;prompt=null;update({busy:true,canPrompt:false,message:''});
  try{
    // Call prompt before awaiting anything so the button's user gesture is retained.
    await current.prompt();const choice=await current.userChoice;
    if(!state.installed)update({message:choice.outcome==='accepted'?'Installation requested. Finish the steps shown by your browser.':'You can install later using your browser’s install option.'});
  }catch{update({message:'Use your browser’s install or Add to Home Screen option.'});}
  finally{update({busy:false});}
}
export function installInstructions(){
  const ios=/iPad|iPhone|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
  if(ios)return ['Open Mise in Safari.','Open Share, then choose Add to Home Screen.','Turn on Open as Web App if shown, then tap Add.'];
  if(/Android/.test(navigator.userAgent))return ['Open your browser menu.','Choose Add to Home screen or Install app.','Confirm Install, then open Mise from its home-screen icon.'];
  return ['Open Mise in Chrome or Edge.','Choose the install icon in the address bar, or Install app in the browser menu.','Confirm Install, then open Mise from its app icon.'];
}
