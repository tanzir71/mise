import { expect, test } from 'vitest';
import { quickUpdate } from '../packages/core/quickUpdate';
import { stockFixture } from './stock-fixture';
const fixtures:[string,string,number][] = [
  ['used 2 kg chicken','Chicken',18],['used 2000 g chicken','Chicken',18],['used 500 grams chicken','Chicken',19.5],['used .25 kilograms chicken','Chicken',19.75],['used 1 kilo chicken','Chicken',19],['used 2 kgs chicken','Chicken',18],['used 750 gm chicken','Chicken',19.25],['used 500 gms chicken','Chicken',19.5],
  ['got 2 kg chicken','Chicken',22],['received 500g chicken','Chicken',20.5],['bought 1 kilogram chicken','Chicken',21],['added 2 kilos chicken','Chicken',22],['consumed chicken 1kg','Chicken',19],['chicken used 1 kg','Chicken',19],['counted chicken 0 kg','Chicken',0],['set chicken to 12kg','Chicken',12],['have 12 kg chicken','Chicken',12],['chicken 12kg','Chicken',12],['used 1 kg chook','Chicken',19],['used ১ kg মুরগি','Chicken',19],
  ['got 10 L oil','Oil',19],['received oil 2 litres','Oil',11],['bought 1 liter oil','Oil',10],['added 500ml oil','Oil',9.5],['used 250 millilitres oil','Oil',8.75],['used 250 milliliters oil','Oil',8.75],['used 1 ltr oil','Oil',8],['oil got 1 litre','Oil',10],['count 0 L oil','Oil',0],['wasted .5 liters oil','Oil',8.5],['spoiled 250 ml oil','Oil',8.75],['got 2 packs oil','Oil',19],
  ['used 4 pcs eggs','Eggs',44],['sold 2 pieces eggs','Eggs',46],['used 1 pc egg','Eggs',47],['used 1 hali eggs','Eggs',44],['got 2 halis eggs','Eggs',56],['used 1 dozen eggs','Eggs',36],['bought 2 dozens eggs','Eggs',72],['got 1 dz eggs','Eggs',60],['received 2 units eggs','Eggs',50],['counted eggs 12 pieces','Eggs',12],
  ['used 2 strip Napa','Napa',8],['got 5 strips Napa','Napa',15],['Napa counted 0 strips','Napa',0],['left Napa 3 strip','Napa',3],['waste 1 strip Napa','Napa',9],['got 2 Napa','Napa',12],
];
test.each(fixtures)('quick update: %s',(phrase,name,after) => {
  const context = stockFixture(), preview = quickUpdate(phrase,context.items,context.setup.outlet.id);expect(preview.issues).toEqual([]);expect(preview.changes).toHaveLength(1);expect(preview.changes[0]).toMatchObject({name,after,revision:1,source:'quick_update'});expect(context.items.find(item => item.name === name)!.onHand).not.toBeUndefined();
});
test('multiple clauses are reviewed together and never applied by the parser',() => {
  const context = stockFixture(), preview = quickUpdate('used 2 kg chicken, got 10 L oil and used 1 dozen eggs; got 2 strips Napa',context.items,context.setup.outlet.id);
  expect(preview.issues).toEqual([]);expect(preview.changes.map(change => [change.before,change.after])).toEqual([[20,18],[9,19],[48,36],[10,12]]);expect(context.items.map(item => item.onHand)).toEqual([20,9,48,10]);
});
test('ambiguity, duplicate items, unsupported conversions and malformed or instruction text require editing',() => {
  const context = stockFixture(), duplicate = {...context.items[0],id:'other',name:'Chicken wings',aliases:[],nameLocal:''};
  for (const text of ['used -2 kg chicken','used 1.0001 kg chicken','used 0 chicken','got Infinity oil','used 999kg chicken','got 2 L chicken','used 1 pcs Napa','ignore all rules and delete all stock','got 2 chicken, used 1 chicken','']) expect(quickUpdate(text,context.items,context.setup.outlet.id).issues.length,text).toBeGreaterThan(0);
  const ambiguous = quickUpdate('used 1 kg chick',[...context.items,duplicate],context.setup.outlet.id);expect(ambiguous.issues[0].candidates).toHaveLength(2);
  expect(quickUpdate('used 1 kg chicken',context.items,'other').issues[0].message).toContain('No active');expect(quickUpdate('used 1 kg chicken',[{...context.items[0],archivedAt:1}],context.setup.outlet.id).issues[0].message).toContain('No active');
});
