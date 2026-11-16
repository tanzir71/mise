import { createContext,useContext } from 'react';
export const HandoffContext=createContext(false);
export const useHandoffs=()=>useContext(HandoffContext);
