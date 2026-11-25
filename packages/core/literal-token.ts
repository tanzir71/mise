/** Stable complete JSON snapshots. Equality evidence, never authorization. */
export function literalToken(value:unknown):string {
 const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
 const sorted=(v:unknown):unknown=>Array.isArray(v)?v.map(sorted):object(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sorted(v[k])])):v;
 return JSON.stringify(sorted(value));
}
