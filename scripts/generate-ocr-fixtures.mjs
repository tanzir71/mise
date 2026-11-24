import sharp from 'sharp';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

// Synthetic receipts only. Expected text is written before running the reader;
// generated pixels, original expected rows and generator stay in the repository.
const invoices=[
 ['Rahim Traders',[['Chicken','20 kg','240.00','4800.00'],['Oil','10 L','235.00','2350.00'],['Yogurt','5 kg','120.00','600.00']]],
 ['Morning Supplies',[['Rice','12 kg','80.00','960.00'],['Sugar','4 kg','125.00','500.00'],['Salt','6 pc','40.00','240.00']]],
 ['Green Market',[['Potato','10 kg','35.00','350.00'],['Onion','5 kg','90.00','450.00'],['Tomato','4 kg','70.00','280.00']]],
 ['City Wholesale',[['Milk','12 L','95.00','1140.00'],['Butter','2 kg','600.00','1200.00'],['Cream','3 L','250.00','750.00']]],
 ['Station Road Foods',[['Flour','25 kg','50.00','1250.00'],['Eggs','60 pc','12.00','720.00'],['Tea','2 kg','450.00','900.00']]],
 ['Metro Grocery',[['Soap','24 pc','45.00','1080.00'],['Shampoo','6 pc','220.00','1320.00'],['Tissue','10 pc','80.00','800.00']]],
 ['North Paper House',[['Notebook','12 pc','75.00','900.00'],['Pen','30 pc','10.00','300.00'],['Tape','4 pc','55.00','220.00']]],
 ['River Fish Depot',[['Rui fish','6 kg','320.00','1920.00'],['Prawn','2 kg','750.00','1500.00'],['Ice','10 kg','15.00','150.00']]],
 ['East Bakery Supply',[['Yeast','2 kg','480.00','960.00'],['Cocoa','1 kg','850.00','850.00'],['Vanilla','4 pc','125.00','500.00']]],
 ['Central Spice Shop',[['Turmeric','3 kg','280.00','840.00'],['Cumin','2 kg','650.00','1300.00'],['Chilli','4 kg','350.00','1400.00']]],
 ['Harbour Packaging',[['Paper bag','100 pc','3.50','350.00'],['Lunch box','40 pc','12.50','500.00'],['Cup','50 pc','4.25','212.50']]],
 ['West Hardware',[['Nail','4 kg','180.00','720.00'],['Brush','6 pc','95.00','570.00'],['Paint','5 L','420.00','2100.00']]],
 ['Garden Fresh',[['Apple','5 kg','240.00','1200.00'],['Banana','24 pc','8.00','192.00'],['Orange','3 kg','280.00','840.00']]],
 ['Daily Essentials',[['Lentil','7.5 kg','140.00','1050.00'],['Chickpea','2.5 kg','120.00','300.00'],['Peanut','1.5 kg','260.00','390.00']]],
 ['Sunrise Supplies',[['Basmati rice','8 kg','175.00','1400.00'],['Soybean oil','5 L','180.00','900.00'],['Semolina','3 kg','95.00','285.00']]],
];
const folder=resolve('tests/fixtures/ocr');mkdirSync(folder,{recursive:true});
const escape=value=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const fixtures=[];
for(const [index,[supplier,rows]] of invoices.entries()){
 const reference=`INV-${String(index+1).padStart(3,'0')}`,total=rows.reduce((sum,row)=>sum+Math.round(Number(row[3])*100),0)/100;
 const lines=[supplier,`Invoice ${reference}`,'Item Quantity Unit price Amount',...rows.map(row=>row.join(' ')),`Total BDT ${total.toFixed(2)}`,'Payment Due'];
 const texts=[`<text x="56" y="72" font-size="36">${escape(supplier)}</text>`,`<text x="56" y="126">Invoice ${reference}</text>`,...['Item','Quantity','Unit price','Amount'].map((text,i)=>`<text x="${[56,470,650,890][i]}" y="200">${text}</text>`),...rows.flatMap((row,i)=>row.map((text,j)=>`<text x="${[56,470,650,890][j]}" y="${270+i*68}">${escape(text)}</text>`)),`<text x="56" y="530">Total BDT ${total.toFixed(2)}</text>`,`<text x="56" y="592">Payment Due</text>`];
 const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1160" height="660"><rect width="1160" height="660" fill="${index%3===0?'#f8f7f3':'white'}"/><g fill="#171717" font-family="${index%2?'Arial':'Verdana'}" font-size="28">${texts.join('')}</g></svg>`;
 const file=`invoice-${String(index+1).padStart(2,'0')}.${index%3===1?'jpg':'png'}`;
 const image=sharp(Buffer.from(svg));await (file.endsWith('.jpg')?image.jpeg({quality:90}):image.png()).toFile(resolve(folder,file));
 fixtures.push({id:`invoice-${index+1}`,file,kind:'printed-invoice',supplier,reference,currency:'BDT',lines,itemLines:rows.map(row=>row.join(' ')),itemValues:rows.map(([name,quantity,price,amount])=>{const [qty,unit]=quantity.split(' ');return {name,quantity:Number(qty),unit:unit==='pc'?'pcs':unit,unitPrice:Math.round(Number(price)*100),printedAmount:Math.round(Number(amount)*100)};}),totalMinor:Math.round(total*100)});
}
// Separate language coverage; no claim that this measures handwritten accuracy.
const bangla=['রহিম ট্রেডার্স','চাল ৫ কেজি ৪০০','চিনি ২ কেজি ২৫০','লবণ ৩ প্যাকেট ১২০','মোট ৭৭০ টাকা'];
await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1160" height="580"><rect width="1160" height="580" fill="white"/><g fill="black" font-family="Nirmala UI" font-size="42">${bangla.map((text,i)=>`<text x="56" y="${90+i*92}">${text}</text>`).join('')}</g></svg>`)).png().toFile(resolve(folder,'bangla-list.png'));
writeFileSync(resolve(folder,'expected.json'),JSON.stringify({version:1,fixtures,languageFixture:{file:'bangla-list.png',lines:bangla}},null,2)+'\n');
console.log(`Generated ${fixtures.length} printed invoices and one Bangla language fixture.`);
