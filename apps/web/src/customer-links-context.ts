import { createContext, useContext } from 'react';
export const CustomerLinksContext = createContext(false);
export const useCustomerLinks = () => useContext(CustomerLinksContext);
export const PublicOrdersContext=createContext(false);
export const usePublicOrders=()=>useContext(PublicOrdersContext);
export const CustomerCheckoutContext=createContext(false);
export const useCustomerCheckout=()=>useContext(CustomerCheckoutContext);

export const CustomerKhataContext=createContext(false);
export const useCustomerKhata=()=>useContext(CustomerKhataContext);
