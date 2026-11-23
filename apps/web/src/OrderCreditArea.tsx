import {lazy,Suspense} from 'react';
import type {Order,SetupSnapshot} from '@mise/core/models';
import {usePublicOrders} from './customer-links-context';
const Controls=lazy(()=>import('./CheckoutPolicyControls').then(module=>({default:module.CheckoutPolicyControls})));
export function OrderCreditArea({order,setup}:{order:Order;setup:SetupSnapshot}){
 return usePublicOrders()&&order.businessType==='corner_shop'&&['owner','manager'].includes(setup.owner.role)?<Suspense fallback={<p aria-busy="true">Opening khata permission…</p>}><Controls key={order.id} order={order} setup={setup}/></Suspense>:null;
}
