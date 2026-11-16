import { useEffect,useRef,useState } from 'react';
import { Button,Card } from '@mise/ui/primitives.tsx';
import { MiseIcon } from '@mise/ui/MiseIcon.tsx';
import type { SetupSnapshot } from '@mise/core/models';
import { BackupTools } from './BackupTools';
import { installApp,installInstructions,useAppInstall } from './app-install';
import './device-settings.css';

type StorageState='checking'|'standard'|'kept'|'unsupported'|'unknown';
export function DeviceSettings({setup,online}:{setup:SetupSnapshot;online:boolean}){
  const install=useAppInstall(),[storage,setStorage]=useState<StorageState>('checking'),[storageMessage,setStorageMessage]=useState(''),[saving,setSaving]=useState(false),[updateMessage,setUpdateMessage]=useState('');
  const busy=useRef(false),checking=useRef(false);
  useEffect(()=>{
    let current=true;
    if(typeof navigator.storage?.persisted!=='function'||typeof navigator.storage?.persist!=='function'){setStorage('unsupported');return;}
    void navigator.storage.persisted().then(value=>{if(current)setStorage(value?'kept':'standard');}).catch(()=>{if(current)setStorage('unknown');});
    return()=>{current=false;};
  },[]);
  async function keepData(){
    if(busy.current)return;busy.current=true;setSaving(true);setStorageMessage('');
    try{const kept=await navigator.storage.persist();setStorage(kept?'kept':'standard');setStorageMessage(kept?'This browser agreed to keep local data when space is low.':'This browser kept standard storage. Download a JSON backup to keep a separate copy.');}
    catch{setStorage('unknown');setStorageMessage('This browser could not change storage protection. Download a JSON backup to keep a separate copy.');}
    finally{busy.current=false;setSaving(false);}
  }
  async function checkUpdate(){
    if(checking.current)return;checking.current=true;setUpdateMessage('Checking for an update…');
    try{if(!online)throw new Error();const registration=await navigator.serviceWorker?.getRegistration();if(!registration)throw new Error();await registration.update();setUpdateMessage('Update check complete. If an update is ready, choose Reload after saving your changes.');}
    catch{setUpdateMessage('Could not check for updates. Connect to the internet and try again.');}
    finally{checking.current=false;}
  }
  return <div className="device-settings"><header className="app-page-heading"><h1>Settings › This device</h1><p>Install Mise, use it offline and keep a separate copy of your shop.</p></header><div className="device-settings-cards"><Card className="app-panel pwa-install"><header><MiseIcon name="phone" size={20}/><h2>Install Mise</h2></header>{install.installed?<p className="device-state">Installed on this device</p>:<><p>Open Mise from your home screen or desktop. Your records stay in this browser.</p><ol>{installInstructions().map(step=><li key={step}>{step}</li>)}</ol><p>Before moving existing records to a different browser or a Safari home-screen app, download a JSON backup below. If the new app opens at setup, choose Restore a backup.</p></>}{install.message?<p role="status">{install.message}</p>:null}{!install.installed&&install.canPrompt?<footer><Button disabled={install.busy} onClick={()=>void installApp()}>{install.busy?'Opening install…':'Install on this device'}</Button></footer>:null}</Card><Card className="app-panel pwa-offline"><header><MiseIcon name="checkCircle" size={20}/><h2>Offline access and updates</h2></header><p className="device-state" role="status">{install.offlineReady?'Ready offline':'Preparing offline access — stay online for the first load'}</p><p>After the first load finishes, you can reopen Mise and record sales, orders, stock and khata without internet. Sharing through another app needs that app’s connection.</p><p>Updates wait for you to save your changes and choose Reload. Another open tab keeps its form.</p><footer><Button kind="secondary" onClick={()=>void checkUpdate()}>Check for updates</Button></footer>{updateMessage?<p role="status">{updateMessage}</p>:null}</Card><Card className="app-panel pwa-storage"><header><MiseIcon name="database" size={20}/><h2>Keep local data</h2></header><p>Ask this browser to keep your shop’s local data when space is low. Keep a JSON backup so you can restore it on another device.</p><p className="device-state">{storage==='checking'?'Checking storage…':storage==='kept'?'Storage protection granted':storage==='standard'?'Standard browser storage':storage==='unsupported'?'This browser does not offer storage protection':'Storage protection could not be checked'}</p>{storage!=='unsupported'?<div><Button kind="secondary" disabled={storage==='checking'||storage==='kept'||saving} onClick={()=>void keepData()}>{saving?'Requesting…':'Keep local data'}</Button></div>:null}{storageMessage?<p role="status">{storageMessage}</p>:null}<BackupTools setup={setup}/></Card></div></div>;
}
