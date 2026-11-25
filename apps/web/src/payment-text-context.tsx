import { createContext, useContext } from 'react';
export const PaymentTextContext = createContext(false);
export const usePaymentTextEnabled = () => useContext(PaymentTextContext);
