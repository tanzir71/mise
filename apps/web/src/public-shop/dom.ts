export function el<K extends keyof HTMLElementTagNameMap>(tag:K,attributes:Record<string,string|boolean>={},...children:(Node|string|null|undefined)[]):HTMLElementTagNameMap[K]{
  const node=document.createElement(tag);for(const child of children)if(child!==null&&child!==undefined)node.append(child);
  for(const [name,value] of Object.entries(attributes)){
    if(name==='value'&&'value' in node)(node as HTMLInputElement).value=String(value);
    else if(value!==false)node.setAttribute(name,value===true?'':value);
  }
  return node;
}
