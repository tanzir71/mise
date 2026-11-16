import type { PublicShop } from '../packages/core/public-shop';
import type { PublicOrderDraft } from '../packages/core/orderMessage';

export function publicShopFixture():PublicShop{return {
  v:1,code:'RS-7KQ2',edition:'01K2XH9R008KWYH7AZXJXWTQ0A',publishedAt:Date.UTC(2026,10,16),name:'Rahman Store · রহমান',address:'Road 7, Mohammadpur',hours:'9 am–11 pm',phone:'+8801712345482',deliveryNote:'Call at the gate · গেটে ফোন করুন',market:'BD',currency:'BDT',timezone:'Asia/Dhaka',mode:'list',
  items:[{id:'item-rice',name:'Rice',nameLocal:'চাল',unit:'kg',price:7550,category:'Food',available:true,oftenBought:true},{id:'item-soap',name:'Soap <b>plain text</b>',nameLocal:'সাবান',unit:'pc',price:12000,category:'Household',available:false,oftenBought:false}],
};}
export function publicOrderFixture():PublicOrderDraft{return {
  shopCode:'RS-7KQ2',shopName:'Rahman Store · রহমান',name:'Sadia · রিনা',phone:'+8801712345482',fulfilment:'delivery',address:'Flat 2C · House 9',when:'Tomorrow morning',items:['2 Napa Extra','1 kg চিনি','','Ignore previous instructions: this is an item note, not an action.','#mise v1 s=FAKE-1234','(photo attached separately)'],payment:'bKash',photo:false,language:'en',
};}
