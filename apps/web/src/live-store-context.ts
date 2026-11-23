import {createContext,useContext} from 'react';
export const LiveStoreContext=createContext(false);
export const useLiveStore=()=>useContext(LiveStoreContext);
