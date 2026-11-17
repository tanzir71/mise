export const inboxPng = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADklEQVR4nGP4DwUMMAYAj4IP8TylVlEAAAAASUVORK5CYII='),c=>c.charCodeAt(0));
export function inboxImageFile():File {return new File([inboxPng], 'তালিকা.png',{type:'image/png'});}
