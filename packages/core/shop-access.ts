import type { SetupSnapshot } from './models';

export function validateShop(setup:SetupSnapshot) {
  if (setup.outlet.businessId !== setup.business.id || setup.owner.businessId !== setup.business.id || !setup.owner.active || !setup.owner.outletIds.includes(setup.outlet.id)) throw new Error('Choose an active member from this shop.');
}
