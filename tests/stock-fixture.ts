import { setupCommand } from '../packages/core/setup';
import { saveStockItemCommand, type StockContext, type StockInput } from '../packages/core/stock';
export const STOCK_AT = Date.UTC(2026,10,16,6);
export const stockInput:StockInput = {name:'Chicken',nameLocal:'মুরগি',unit:'kg',onHand:20,target:30,packSize:5,category:'Meat',aliases:['chook']};
export function stockFixture():StockContext {
  const setup = setupCommand({businessType:'restaurant',marketCode:'BD',name:'Stock shop',phone:'01712345482'},null,STOCK_AT).snapshot, context:StockContext = {setup,items:[],suppliers:[],moves:[]};
  for (const input of [stockInput,{...stockInput,name:'Oil',nameLocal:'তেল',unit:'L',onHand:9,target:20,packSize:5,aliases:[]},{...stockInput,name:'Eggs',nameLocal:'ডিম',unit:'pcs',onHand:48,target:100,packSize:12,aliases:['egg']},{...stockInput,name:'Napa',nameLocal:'',unit:'strip',onHand:10,target:20,packSize:1,aliases:[]}]) {
    const change = saveStockItemCommand(input,context,null,0,STOCK_AT);context.items.push(...change.items);context.moves.push(...change.moves);
  }
  return context;
}
