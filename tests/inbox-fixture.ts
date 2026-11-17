export const inboxPng = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII='),c=>c.charCodeAt(0));
export function inboxImageFile():File {return new File([inboxPng], 'তালিকা.png',{type:'image/png'});}
