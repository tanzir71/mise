import { ulid } from 'ulid';
import { normalisePhone } from './phone';
import type { AuditEvent, Customer, SetupSnapshot } from './models';

export interface CustomerInput { name: string; nickname: string; phone: string; address: string; notes: string; tags: string[] }
export type CustomerSetup=Pick<SetupSnapshot,'business'|'outlet'>&{owner:{id:string}};
export function customerEvent(command: string, customerId: string, before: unknown, after: unknown, setup: CustomerSetup, at: number, newId:()=>string=()=>ulid(at)): AuditEvent {
  return { id: newId(), outletId: setup.outlet.id, customerId, actor: { type: 'member', id: setup.owner.id }, command, before, after, at };
}
export function saveCustomerCommand(input: CustomerInput, setup: CustomerSetup, customers: Customer[], before: Customer | null = null, at = Date.now(), newId:(kind:'customer'|'event')=>string=()=>ulid(at)): { customer: Customer; event: AuditEvent } {
  const name = input.name.trim(), nickname = input.nickname.trim(), address = input.address.trim(), notes = input.notes.trim();
  if (!name || name.length > 80 || /[\r\n]/.test(name) || nickname.length > 80) throw new Error('Use a customer name between 1 and 80 characters.');
  if (address.length > 250 || notes.length > 2000) throw new Error('Keep the address within 250 characters and notes within 2,000.');
  if (input.tags.length > 20 || input.tags.some(tag => tag.trim().length > 32)) throw new Error('Use up to 20 tags of at most 32 characters.');
  if (before && before.businessId !== setup.business.id) throw new Error('This customer belongs to another business.');
  const phone = input.phone.trim() ? normalisePhone(input.phone,setup.business.marketCode) : undefined;
  if (input.phone.trim() && !phone) throw new Error('Enter a complete phone number.');
  if (phone && customers.some(customer => customer.businessId === setup.business.id && customer.id !== before?.id && customer.phone === phone)) throw new Error('A customer already has this number. Open or restore their profile.');
  const tags = [...new Map(input.tags.map(tag => [tag.trim().normalize('NFKC').toLowerCase(),tag.trim()])).values()].filter(Boolean);
  const customer: Customer = { id: before?.id || newId('customer'), businessId: setup.business.id, name, nickname, phone: phone || undefined, address, notes, tags, consent: before && before.phone === phone ? before.consent : { savedAt: at, source: 'manual' }, archivedAt: before?.archivedAt, createdAt: before?.createdAt ?? at, updatedAt: Math.max(at,before?.createdAt??at) };
  return { customer, event: customerEvent(before ? 'customer.update' : 'customer.create',customer.id,before,customer,setup,at,()=>newId('event')) };
}
export function archiveCustomerCommand(customer: Customer, setup: CustomerSetup, hasBalance: boolean, archive: boolean, at = Date.now(), newId:()=>string=()=>ulid(at)): { customer: Customer; event: AuditEvent } {
  if (customer.businessId !== setup.business.id) throw new Error('This customer belongs to another business.');
  if (archive && hasBalance) throw new Error('Settle this customer’s khata before removing them.');
  const after = { ...customer, archivedAt: archive ? at : undefined, updatedAt: Math.max(at,customer.createdAt) };
  return { customer: after, event: customerEvent(archive ? 'customer.archive' : 'customer.restore',customer.id,customer,after,setup,at,newId) };
}
export function searchCustomers(customers: Customer[], query: string, archived = false): Customer[] {
  const normalized = query.replace(/[০-৯]/g,digit => String(digit.charCodeAt(0)-0x09e6));
  const term = normalized.trim().normalize('NFKC').toLowerCase(), digits = normalized.replace(/\D/g,''), national = digits.replace(/^0+/,'');
  return customers.filter(customer => (archived || customer.archivedAt === undefined) && (!term || `${customer.name} ${customer.nickname} ${customer.phone || ''} ${customer.tags.join(' ')}`.normalize('NFKC').toLowerCase().includes(term) || (digits.length >= 3 && (customer.phone?.includes(digits) || (national.length >= 3 && customer.phone?.endsWith(national))))));
}
