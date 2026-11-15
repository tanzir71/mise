import { setupCommand } from '../packages/core/setup';
import { saveOrderCommand, type OrderInput } from '../packages/core/orders';
import type { BusinessType } from '../packages/core/packs';
export const ORDER_AT = Date.UTC(2026,10,15,8);
export function orderFixture(businessType: BusinessType = 'corner_shop') {
  const seeded = setupCommand({businessType,marketCode:'BD',name:'Order shop',phone:'01712345482'},null,ORDER_AT);
  const context = {setup:seeded.snapshot,items:seeded.items,sequence:1};
  const input: OrderInput = {source:'phone',sourceText:'',name:'Karim',phone:'01712345482',type:'pickup',address:'',table:'',lines:[{name:'Tea',unit:'cup',qty:2,unitPrice:1250}],deliveryFee:0,discount:0,payment:{method:'cash'}};
  return {context,input,order:saveOrderCommand(input,context,null,0,ORDER_AT).order};
}
