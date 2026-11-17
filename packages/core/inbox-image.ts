export const inboxImageTypes = ['image/jpeg','image/png','image/webp'] as const;
export type InboxImageType = typeof inboxImageTypes[number];
export function validateInboxImageBytes(type:InboxImageType,bytes:Uint8Array):void {
  const matches=type==='image/png'?bytes.length>=8&&[137,80,78,71,13,10,26,10].every((n,i)=>bytes[i]===n):type==='image/jpeg'?bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255:bytes.length>=12&&[82,73,70,70].every((n,i)=>bytes[i]===n)&&[87,69,66,80].every((n,i)=>bytes[i+8]===n);
  if(!matches)throw new Error('The shared image contents do not match its JPEG, PNG or WebP type.');
}
