/** Pure initials; safe on account-free pages without loading owner data code. */
export function Avatar({name,large=false,className='khata-avatar'}:{name:string;large?:boolean;className?:string}){
 return <span className={className+(large?' large':'')} aria-hidden="true">{Array.from(name.trim().split(/\s+/).slice(0,2).map(part=>Array.from(part)[0]).join('')).slice(0,2).join('').toLocaleUpperCase()}</span>;
}
