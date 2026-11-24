import type {startStaffStockService as Factory} from './staff-stock-service';
export function startStaffStockService():Promise<Awaited<ReturnType<typeof Factory>>>;
