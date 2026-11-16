/** Preserve every character, including line endings and surrogate pairs, across separately reviewed parts. */
export function handoffParts(text:string):string[]{
  if(!text.trim()||text.length>350000)throw new Error('Use a message with at most 100 parts.');
  const parts:string[]=[];let remaining=text;
  while(remaining.length>3500){let cut=remaining.lastIndexOf('\n',3499)+1;if(cut<1)cut=3500;if(/[\uD800-\uDBFF]/.test(remaining[cut-1])&&/[\uDC00-\uDFFF]/.test(remaining[cut]))cut--;parts.push(remaining.slice(0,cut));remaining=remaining.slice(cut);}
  if(remaining)parts.push(remaining);if(parts.length>100)throw new Error('Use a message with at most 100 parts.');if(parts.some(part=>!part.trim()))throw new Error('Remove long blank sections before sharing this message.');return parts;
}
