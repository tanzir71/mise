import { createContext, useContext } from 'react';
export const CustomerLinksContext = createContext(false);
export const useCustomerLinks = () => useContext(CustomerLinksContext);
