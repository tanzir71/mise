import {chromium} from '@playwright/test';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';

// Native rendering proof for the public page's modified, budgeted fonts.
// Run alone or through qa:visual; never used by the customer runtime.
const copy=readFileSync('apps/web/src/public-shop/copy.ts','utf8');
const groups=[
  {id:'english',fonts:['packages/ui/assets/public-fonts/geist-source.woff2','packages/ui/assets/public-fonts/geist-public.woff2'],sizes:[[14,400],[14,500],[16,600],[24,600]],samples:['Rahman Store & Pharmacy','What do you need?','Your phone number','Send to shop','Same as last time','Delivery address','1,12,840.50','The shop confirms the final price.']},
  {id:'bengali',fonts:['packages/ui/node_modules/@fontsource/hind-siliguri/files/hind-siliguri-bengali-400-normal.woff','packages/ui/assets/public-fonts/hind-public.woff2'],sizes:[[14,400],[16,400]],samples:['ক্ষ জ্ঞ ষ্ট শ্র স্থ ন্দ্র ক্র র্ক ঙ্গ ঞ্জ ৳','কাচ্চি বিরিয়ানি · চিনি ১ কেজি',...[...copy.matchAll(/'([^']*[\u0980-\u09ff][^']*)'/g)].map(match=>match[1])]},
];
mkdirSync('qa/screens',{recursive:true});
const browser=await chromium.launch();
const proofs=[];
try{
  for(const group of groups){
    const files=group.fonts.map(path=>readFileSync(path));
    const page=await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:2});
    const metrics=await page.evaluate(async({group,fonts})=>{
      document.body.style.cssText='margin:24px;display:flex;gap:32px;background:white;color:#141414';
      const measurements=[];
      for(let index=0;index<fonts.length;index++){
        const face=new FontFace('Proof'+index,new Uint8Array(fonts[index]).buffer,{weight:'400 600'});await face.load();document.fonts.add(face);
        const panel=document.createElement('section');panel.style.cssText='width:680px;flex-shrink:0';document.body.append(panel);
        const title=document.createElement('h1');title.textContent=(index?'Public subset':'Original source')+' · '+group.id;title.style.font='18px sans-serif';panel.append(title);
        const widths=[];
        for(const [size,weight] of group.sizes)for(const text of group.samples){
          const line=document.createElement('div');line.style.cssText=`font:${weight} ${size}px/32px Proof${index},sans-serif;white-space:nowrap;font-synthesis:none`;
          const span=document.createElement('span');span.textContent=text;line.append(span);panel.append(line);widths.push(span.getBoundingClientRect().width);
        }
        measurements.push(widths);
      }
      const delta=measurements[0].map((width,index)=>Math.abs(width-measurements[1][index]));
      return {renderedSamples:delta.length,maxWidthDifference:Math.max(...delta),meanWidthDifference:delta.reduce((a,b)=>a+b,0)/delta.length};
    },{group,fonts:files.map(data=>[...data])});
    const screenshot=`qa/screens/m20-font-proof-${group.id}.png`;await page.screenshot({path:screenshot,fullPage:true});await page.close();
    proofs.push({id:group.id,screenshot,sha256:files.map(data=>createHash('sha256').update(data).digest('hex')),...metrics});
  }
  writeFileSync('qa/screens/m20-font-proof.json',JSON.stringify(proofs,null,2)+'\n');
  console.log('Public font proof:',JSON.stringify(proofs));
}finally{await browser.close();}
