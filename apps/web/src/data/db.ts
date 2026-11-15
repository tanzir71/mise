import Dexie, { type EntityTable } from 'dexie';
import type { Business, Outlet, Member, Category, Item, AuditEvent, SetupSnapshot, SetupInput } from '@mise/core/models';
import { setupCommand } from '@mise/core/setup';
import { removeSampleCommand, saveItemCommand, itemAvailabilityCommand, deleteItemCommand, type ItemInput } from '@mise/core/catalogue';

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
  async saveItem(input: ItemInput, id?: string): Promise<Item> {
    return this.transaction('rw', this.tables, async () => {
      const setup = await this.setup(); if (!setup) throw new Error('Set up your shop first.');
      const before = id ? await this.items.get(id) : null;
      if (id && !before) throw new Error('Item not found.');
      const command = saveItemCommand(input, { outletId: setup.outlet.id, actorId: setup.owner.id, categories: await this.categories.where('outletId').equals(setup.outlet.id).toArray() }, before);
      if (command.category) await this.categories.add(command.category);
      await this.items.put(command.item); await this.events.add(command.event);
      return command.item;
    });
  }
  async setItemAvailable(id: string, available: boolean): Promise<void> {
    await this.transaction('rw', this.tables, async () => {
      const [item, setup] = await Promise.all([this.items.get(id), this.setup()]);
      if (!item || !setup || item.outletId !== setup.outlet.id) throw new Error('Item not found.');
      const command = itemAvailabilityCommand(item, available, setup.owner.id);
      await this.items.put(command.item); await this.events.add(command.event);
    });
  }
  async deleteItem(id: string): Promise<void> {
    await this.transaction('rw', this.tables, async () => {
      const [item, setup] = await Promise.all([this.items.get(id), this.setup()]);
      if (!item || !setup || item.outletId !== setup.outlet.id) throw new Error('Item not found.');
      const event = deleteItemCommand(item, setup.owner.id);
      await this.items.delete(id); await this.events.add(event);
    });
  }
  async addItems(inputs: ItemInput[]): Promise<void> {
    if (!inputs.length || inputs.length > 1000) throw new Error('Paste between 1 and 1,000 items at a time.');
    await this.transaction('rw', this.tables, async () => {
      const setup = await this.setup(); if (!setup) throw new Error('Set up your shop first.');
      const categories = await this.categories.where('outletId').equals(setup.outlet.id).toArray();
      for (const input of inputs) {
        const command = saveItemCommand(input, { outletId: setup.outlet.id, actorId: setup.owner.id, categories });
        if (command.category) { await this.categories.add(command.category); categories.push(command.category); }
        await this.items.add(command.item); await this.events.add(command.event);
      }
    });
  }
}
export const db = new MiseDatabase(`mise-local:${import.meta.env.BASE_URL}`);
