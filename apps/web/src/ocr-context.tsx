import {createContext,useContext} from 'react';
export const OcrContext=createContext(false);
export const useOcrEnabled=()=>useContext(OcrContext);
