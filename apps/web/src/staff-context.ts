import {createContext,useContext} from 'react';
export const StaffTeamContext=createContext(false);
export const useStaffTeamEnabled=()=>useContext(StaffTeamContext);
