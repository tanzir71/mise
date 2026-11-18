import type { SetupSnapshot } from './models';
export type ShopSetup=Omit<SetupSnapshot,'owner'>&{owner:Pick<SetupSnapshot['owner'],'id'|'businessId'|'active'|'outletIds'>&Partial<Pick<SetupSnapshot['owner'],'role'>>};
export type NamedShopSetup=ShopSetup&{owner:ShopSetup['owner']&Pick<SetupSnapshot['owner'],'name'>};

export function validateShop(setup:ShopSetup) {
  if (setup.outlet.businessId !== setup.business.id || setup.owner.businessId !== setup.business.id || !setup.owner.active || setup.owner.role!==undefined&&!['owner','manager'].includes(setup.owner.role) || !(setup.owner.role==='owner'||setup.owner.outletIds.includes(setup.outlet.id))) throw new Error('Choose an active member from this shop.');
}
