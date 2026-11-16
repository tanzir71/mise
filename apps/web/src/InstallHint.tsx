import { Button } from '@mise/ui/primitives.tsx';
import { installApp,installInstructions,useAppInstall } from './app-install';

export function InstallHint(){
  const install=useAppInstall();
  if(install.installed)return null;
  return <details className="onboarding-install"><summary>Install Mise on this device</summary><p>For a new shop, install first and finish setup from its app icon.</p><ol>{installInstructions().map(step=><li key={step}>{step}</li>)}</ol>{install.canPrompt?<Button type="button" disabled={install.busy} onClick={()=>void installApp()}>{install.busy?'Opening install…':'Install on this device'}</Button>:null}{install.message?<p role="status">{install.message}</p>:null}</details>;
}
