import {useCallback,useMemo} from 'react';
import {useLocation} from 'react-router-dom';
import {decodeStaffViewer} from '@mise/core/staff-links';
import {createStaffPublicSession} from './data/staff-public-session';
import {StaffShift} from './StaffShift';
export function StaffLinkView(){
 const route=useLocation(),source=useMemo(()=>{try{return decodeStaffViewer(location.pathname,route.hash,import.meta.env.BASE_URL);}catch{return null;}},[route.pathname,route.hash]);
 const createSession=useCallback(()=>{if(!source)throw Error('Open the complete current staff link.');return createStaffPublicSession(source,{storage:localStorage,locks:navigator.locks});},[source]);
 return source?<StaffShift key={route.pathname+route.hash} createSession={createSession}/>:<main className="staff-public"><h1>This staff link is unavailable.</h1><p>Open the complete current link from the shop.</p></main>;
}
