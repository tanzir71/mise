import {lazy,Suspense,type ReactNode} from 'react';
import type {CustomerOrder} from '@mise/core/customer-links';
import type {CustomerViewerLink} from '@mise/core/customer-link-url';
import {useCustomerCheckout} from './customer-links-context';
const Checkout=lazy(()=>import('./CustomerCheckout').then(module=>({default:module.CustomerCheckout})));
export function CustomerCheckoutArea(props:{source:CustomerViewerLink|null;order:CustomerOrder;connected?:boolean;language:'en'|'bn';children:ReactNode;onConfirmed:()=>void}){
 return useCustomerCheckout()&&props.source&&props.order.businessType==='corner_shop'?<Suspense fallback={props.children}><Checkout {...props} source={props.source}/></Suspense>:props.children;
}
