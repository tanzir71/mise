import type { ManifestOptions } from 'vite-plugin-pwa';

export function appManifest(base:string):Partial<ManifestOptions> {
  return {
    id:base,name:'Mise',short_name:'Mise',
    description:'Sales, orders, khata and stock, saved on this device and available offline.',
    lang:'en',dir:'ltr',start_url:base,scope:base,display:'standalone',
    theme_color:'#141414',background_color:'#f5f5f4',
    icons:[
      {src:'icon-192.png',sizes:'192x192',type:'image/png',purpose:'any'},
      {src:'icon-512.png',sizes:'512x512',type:'image/png',purpose:'any'},
      {src:'icon-maskable-512.png',sizes:'512x512',type:'image/png',purpose:'maskable'},
    ],
  };
}
