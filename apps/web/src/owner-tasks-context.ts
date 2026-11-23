import {createContext,useContext} from 'react';
export const OwnerTasksContext=createContext(false);
export const useOwnerTasksEnabled=()=>useContext(OwnerTasksContext);
