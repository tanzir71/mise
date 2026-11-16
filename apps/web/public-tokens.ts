import postcss from 'postcss';

/** Emit the shared tokens used by public styles, folding constant aliases only. */
export function publicTokens(definitions:string,usage:string):string {
  const values=new Map<string,string>(),needed=new Map<string,string>(),references=(text:string)=>[...text.matchAll(/var\(\s*(--[\w-]+)/g)].map(match=>match[1]);
  postcss.parse(definitions).walkRules(rule=>{if(rule.selector===':root')rule.walkDecls(declaration=>{if(declaration.prop.startsWith('--'))values.set(declaration.prop,declaration.value);});});
  function value(name:string,path=new Set<string>()):string {
    const raw=values.get(name);if(raw===undefined)throw Error(`Missing shared public token: ${name}`);
    const alias=/^var\(\s*(--[\w-]+)\s*\)$/.exec(raw);if(!alias||path.has(name))return raw;
    const resolved=value(alias[1],new Set([...path,name]));return references(resolved).length?raw:resolved;
  }
  function include(name:string){if(needed.has(name))return;const resolved=value(name);needed.set(name,resolved);for(const dependency of references(resolved))include(dependency);}
  for(const name of references(usage))include(name);
  return ':root{'+[...needed.keys()].sort().map(name=>`${name}:${needed.get(name)};`).join('')+'}';
}
