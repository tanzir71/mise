import { expect, test } from 'vitest';
import fc from 'fast-check';
import { activeStockMoves, adjustStockCommand, archiveStockItemCommand, archiveSupplierCommand, canUndoStockMove, saveStockItemCommand, saveSupplierCommand, stockBatchCommand, stockIsLow, undoStockMoveCommand, type StockChange, type StockContext } from '../packages/core/stock';
import { convertStockQuantity, MAX_STOCK_QUANTITY, parseStockQuantity, stockAtoms, stockNumber, stockToOrder } from '../packages/core/stock-quantity';
import { STOCK_AT as at, stockFixture, stockInput } from './stock-fixture';
const append = (context:StockContext,change:StockChange):StockContext => ({...context,items:context.items.map(item => change.items.find(next => next.id === item.id) || item),moves:[...context.moves,...change.moves]});

test('quantities and conversions use exact thousandths, with explicit count and strip units',() => {
  for (const [input,value] of [['২.৫',2.5],['.125',.125],['0',0],['1000000000',MAX_STOCK_QUANTITY]] as const) expect(parseStockQuantity(input)).toBe(value);
  for (const text of ['NaN','Infinity','1e3','1,000','1.0001','-1','1.','1000000000.001']) expect(parseStockQuantity(text)).toBeNull();
  expect(convertStockQuantity(250,'grams','kilograms')).toBe(.25);expect(convertStockQuantity(.125,'L','ml')).toBe(125);expect(convertStockQuantity(2,'hali','pcs')).toBe(8);expect(convertStockQuantity(1,'dozen','hali')).toBe(3);expect(convertStockQuantity(2,'packs','kg',5)).toBe(10);
  expect(convertStockQuantity(2,'strips','strip')).toBe(2);expect(() => convertStockQuantity(1,'strip','pcs')).toThrow(/cannot/);expect(() => convertStockQuantity(1,'kg','L')).toThrow(/cannot/);expect(() => convertStockQuantity(1,'pcs','dozen')).toThrow(/three decimals/);
});
test('pack-rounded recommendations match an independent integer reference, including decimal packs',() => {
  fc.assert(fc.property(fc.integer({min:0,max:1000000}),fc.integer({min:0,max:1000000}),fc.integer({min:1,max:10000}),(have,target,pack) => {
    const expected = Math.ceil(Math.max(0,target-have)/pack)*pack;
    expect(stockToOrder({onHand:have/1000,target:target/1000,packSize:pack/1000})).toBe(expected/1000);
  }),{numRuns:500});
  expect(() => stockToOrder({onHand:0,target:MAX_STOCK_QUANTITY,packSize:3})).toThrow(/range/);expect(() => stockToOrder({onHand:0,target:1,packSize:0})).toThrow(/pack size/);
});
test('item edits preserve unit/history; thresholds, aliases, names and supplier scope are checked',() => {
  const context = stockFixture(), before = context.items[0];expect(before).toMatchObject({onHand:20,target:30,packSize:5,lowAt:15,lastCountedAt:at});
  const metadata = saveStockItemCommand({...stockInput,target:40},context,before,1,at+1);expect(metadata.moves).toEqual([]);expect(metadata.items[0].lastCountedAt).toBe(at);
  const count = saveStockItemCommand({...stockInput,onHand:18},context,before,1,at+1);expect(count.moves[0]).toMatchObject({reason:'count',before:20,after:18,delta:-2});expect(count.events[0]).toMatchObject({stockItemId:before.id,stockRevision:2,actor:{id:context.setup.owner.id},after:{item:count.items[0],move:count.moves[0]}});
  for (const patch of [{name:' oil '},{packSize:0},{lowAt:31},{onHand:-1},{unit:'g'},{supplierId:'foreign'},{aliases:Array(11).fill('').map((_,i) => String(i))}]) expect(() => saveStockItemCommand({...stockInput,...patch},context,before,1,at)).toThrow();
  expect(() => saveStockItemCommand(stockInput,context,before,0,at)).toThrow(/changed/);expect(() => saveStockItemCommand(stockInput,{...context,setup:{...context.setup,owner:{...context.setup.owner,active:false}}},before,1,at)).toThrow(/active member/);
  expect(stockIsLow({...before,onHand:15})).toBe(true);expect(stockIsLow({...before,onHand:15.001})).toBe(false);expect(stockIsLow({...before,target:0,lowAt:0,onHand:0})).toBe(false);
});
test('stock deltas agree with an independent integer model and do not mutate their inputs',() => {
  const context = stockFixture(), before = context.items[0];let current = context, expected = 20000;
  for (let i=1;i<=300;i++) {
    const item = current.items[0], received = i%3 === 0, amount = i%47+1, change = adjustStockCommand({id:item.id,revision:item.revision,reason:received ? 'received' : 'used',quantity:amount/1000},current,at+i);
    expected += received ? amount : -amount;current = append(current,change);expect(stockAtoms(current.items[0].onHand)).toBe(BigInt(expected));expect(change.moves[0].delta).toBe((received ? amount : -amount)/1000);
  }
  expect(context.items[0]).toEqual(before);expect(context.items[0].onHand).toBe(20);expect(() => adjustStockCommand({id:before.id,revision:1,reason:'used',quantity:21},context,at)).toThrow(/not enough/);
  expect(() => adjustStockCommand({id:before.id,revision:1,reason:'received',quantity:MAX_STOCK_QUANTITY},context,at)).toThrow(/range/);expect(() => stockNumber(-1n)).toThrow();
});
test('night counts share a batch, include zero variances and refuse any stale/duplicate input',() => {
  const context = stockFixture(), changes = stockBatchCommand(context.items.map((item,i) => ({id:item.id,revision:1,reason:'count' as const,quantity:i ? item.onHand : 18})),context,at+1,true);
  expect(changes.moves.map(move => move.delta)).toEqual([-2,0,0,0]);expect(new Set(changes.moves.map(move => move.countBatchId)).size).toBe(1);expect(changes.moves.every(move => move.source === 'count' && move.reason === 'count')).toBe(true);
  const first = {id:context.items[0].id,revision:1,reason:'count' as const,quantity:0};expect(() => stockBatchCommand([first,first],context,at,true)).toThrow(/one reviewed/);expect(() => stockBatchCommand([first,{...first,id:context.items[1].id,revision:0}],context,at,true)).toThrow(/changed/);
  expect(() => stockBatchCommand([{...first,reason:'used'}],context,at,true)).toThrow(/physical/);
});
test('undo appends a movement once, preserves newer usage and enforces physical-count dependencies',() => {
  let context = stockFixture(), item = context.items[0];
  const used = adjustStockCommand({id:item.id,revision:1,reason:'used',quantity:2},context,at+1);context = append(context,used);
  const received = adjustStockCommand({id:item.id,revision:2,reason:'received',quantity:5},context,at+2);context = append(context,received);
  const undo = undoStockMoveCommand(used.moves[0],3,context,at+3);context = append(context,undo);expect(context.items[0].onHand).toBe(25);expect(undo.moves[0]).toMatchObject({reason:'undo',delta:2,undoOf:used.moves[0].id});expect(undo.events[0].undoOf).toBe(used.events[0].id);
  expect(() => undoStockMoveCommand(used.moves[0],4,context,at+4)).toThrow(/once/);expect(canUndoStockMove(received.moves[0],context.moves,at+86400003)).toBe(false);
  const count = adjustStockCommand({id:item.id,revision:4,reason:'count',quantity:20},context,at+5);context = append(context,count);expect(canUndoStockMove(received.moves[0],context.moves,at+6)).toBe(false);
  context = append(context,undoStockMoveCommand(count.moves[0],5,context,at+6));expect(context.items[0].lastCountedAt).toBe(at);expect(canUndoStockMove(received.moves[0],context.moves,at+7)).toBe(true);
  context = append(context,undoStockMoveCommand(received.moves[0],6,context,at+7));expect(context.items[0].onHand).toBe(20);expect(activeStockMoves(context.moves).filter(move => move.stockItemId === item.id)).toHaveLength(1);item = context.items[0];expect(item.revision).toBe(7);
});
test('a used receipt cannot be undone into negative stock; archive frees a name and restore checks collision',() => {
  let context = stockFixture();const item = context.items[0], opening = context.moves[0], used = adjustStockCommand({id:item.id,revision:1,reason:'used',quantity:1},context,at+1);context = append(context,used);
  expect(() => undoStockMoveCommand(opening,2,context,at+2)).toThrow(/since been used/);
  const archived = archiveStockItemCommand(context.items[0],true,2,context,at+3);context = append(context,archived);expect(archived.items[0].activeKey).toBeUndefined();expect(() => adjustStockCommand({id:item.id,revision:3,reason:'count',quantity:5},context,at)).toThrow(/Restore/);
  const replacement = saveStockItemCommand(stockInput,context,null,0,at+4);context.items.push(...replacement.items);expect(() => archiveStockItemCommand(archived.items[0],false,3,context,at+5)).toThrow(/already/);
});
test('supplier contacts normalize phone numbers, retain notes and guard scope, revisions and archive',() => {
  const {setup} = stockFixture(), created = saveSupplierCommand({name:'Fresh supply',phone:'০১৭১২৩৪৫৪৮২',note:'Call before noon'},setup,null,0,at);expect(created.supplier.phone).toBe('+8801712345482');
  expect(() => saveSupplierCommand({name:'Fresh supply',phone:'bad',note:''},setup,created.supplier,1,at)).toThrow(/phone/);expect(() => saveSupplierCommand({name:'Fresh supply',phone:'',note:''},setup,created.supplier,0,at)).toThrow(/changed/);
  const archived = archiveSupplierCommand(created.supplier,true,1,setup,at+1);expect(archived.event.command).toBe('supplier.archive');expect(archiveSupplierCommand(archived.supplier,false,2,setup,at+2).supplier.archivedAt).toBeUndefined();
});
