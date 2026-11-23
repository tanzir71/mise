import {lazy,Suspense} from 'react';
import type {Order,SetupSnapshot} from '@mise/core/models';
import {usePublicOrders} from './customer-links-context';
const Controls=lazy(()=>import('./OrderEstimateControls').then(module=>({default:module.OrderEstimateControls})));
export function OrderEstimateArea({order,setup}:{order:Order;setup:SetupSnapshot}){
 return usePublicOrders()&&['owner','manager'].includes(setup.owner.role)?<Suspense fallback={<p aria-busy="true">Opening arrival estimates…</p>}><Controls key={order.id} order={order} setup={setup}/></Suspense>:null;
}
