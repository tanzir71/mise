import type {Order,OrderStatus} from './models';

/** Preparation includes commercial review and the ready shelf. Handoff,
 * fulfilment and returns keep their own original order history. */
export const kitchenPreparationStatuses:readonly OrderStatus[]=[
 'new','to_confirm','confirmed','kitchen_seen','cooking','ready','packed',
 'ordered','making','ready_called','requested','priced','accepted','packing',
];
export function isKitchenPreparation(order:Pick<Order,'status'>):boolean {
 return kitchenPreparationStatuses.includes(order.status);
}

/** Callers validate original UTC times; never replace them with observation time. */
export function kitchenAlarmStart(order:Pick<Order,'createdAt'|'scheduledFor'>):number {
 return Math.max(order.createdAt,order.scheduledFor??order.createdAt);
}
