import Dexie, { type EntityTable } from 'dexie';
import type { Business, Outlet, Member, Category, Item, AuditEvent, SetupSnapshot, SetupInput } from '@mise/core/models';
import { setupCommand } from '@mise/core/setup';
import { removeSampleCommand } from '@mise/core/catalogue';

export class MiseDatabase extends Dexie {
  businesses!: EntityTable<Business, 'id'>;
  outlets!: EntityTable<Outlet, 'id'>;
  members!: EntityTable<Member, 'id'>;
  categories!: EntityTable<Category, 'id'>;
  items!: EntityTable<Item, 'id'>;
  events!: EntityTable<AuditEvent, 'id'>;
  constructor(name = 'mise-local') {
    super(name);
    this.version(1).stores({ businesses: 'id', outlets: 'id,businessId', members: 'id,businessId', categories: 'id,outletId', items: 'id,outletId,categoryId', events: 'id,outletId,at,command' });
  }
  async setup(): Promise<SetupSnapshot | null> {
    const business = await this.businesses.toCollection().first();
    if (!business) return null;
    const [outlet, owner] = await Promise.all([this.outlets.where('businessId').equals(business.id).first(), this.members.where('businessId').equals(business.id).first()]);
    if (!outlet || !owner) throw new Error('Shop data is incomplete. Keep this browser’s data and try again.');
    return { business, outlet, owner };
  }
  async saveSetup(input: SetupInput): Promise<SetupSnapshot> {
    return this.transaction('rw', this.tables, async () => {
      const command = setupCommand(input, await this.setup());
      const { business, outlet, owner } = command.snapshot;
      await this.businesses.put(business); await this.outlets.put(outlet); await this.members.put(owner);
      await this.categories.bulkPut(command.categories); await this.items.bulkPut(command.items); await this.events.add(command.event);
      return command.snapshot;
    });
  }
  async removeSample(id: string): Promise<void> {
    await this.transaction('rw', this.tables, async () => {
      const [item, setup] = await Promise.all([this.items.get(id), this.setup()]);
      if (!item || !setup || item.outletId !== setup.outlet.id) throw new Error('Sample item not found.');
      const event = removeSampleCommand(item, setup.owner.id);
      await this.items.delete(id); await this.events.add(event);
    });
  }
}
export const db = new MiseDatabase(`mise-local:${import.meta.env.BASE_URL}`);
