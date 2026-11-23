import { createContext, useContext } from 'react';
export const CustomerLinksContext = createContext(false);
export const useCustomerLinks = () => useContext(CustomerLinksContext);
export const PublicOrdersContext=createContext(false);
export const usePublicOrders=()=>useContext(PublicOrdersContext);
