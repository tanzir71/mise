import { publicOrderRecords } from '../packages/core/public-order-projection';
import { createPairingDatabase, deviceId } from './device-pairing-fixture';
import { decodeCommandRecord, encodeCommandRecord } from '../packages/core/cloud-records';
import { newInboxId } from '../packages/core/inbox';
import { generateShopLinkCommand, reviewShopLink } from '../packages/core/shop-links';
import { publicOrderAttemptIdFromHash, publicOrderHash, publicOrderIntentJson, type PublicOrderIntent } from '../packages/core/public-order-submission';
import type { Business, Outlet, SetupSnapshot, Item, Category } from '../packages/core/models';
export async function createPublicOrderDatabase() {
  const f=await createPairingDatabase();
  let setup:SetupSnapshot,shop:ReturnType<typeof generateShopLinkCommand>['shop'],sourceUrl:string;
  const item:Item={id:deviceId(1001),outletId:deviceId(11),name:'Rice',nameLocal:'চাল',categoryId:deviceId(501),price:10000,unit:'kg',available:true,isSample:false,oftenBought:true,createdAt:1,updatedAt:1},
    category:Category={id:deviceId(501),outletId:deviceId(11),name:'Staples',sort:0,createdAt:1,updatedAt:1},
    shopSecret='S'.repeat(43);
  async function seed() {
    await f.seed();await f.db.exec('update private.public_order_budget set window_at=0,requests=0');
    const business=decodeCommandRecord('businesses',(await f.db.query<{data:Record<string,unknown>}>('select row_to_json(b) data from public.businesses b where id=$1',[deviceId(1)])).rows[0].data as Record<string,unknown>) as unknown as Business,
      outlet=decodeCommandRecord('outlets',(await f.db.query<{data:Record<string,unknown>}>('select row_to_json(o) data from public.outlets o where id=$1',[deviceId(11)])).rows[0].data as Record<string,unknown>) as unknown as Outlet;
    setup={business,outlet,owner:{id:deviceId(101),businessId:business.id,outletIds:[outlet.id],name:'Owner',role:'owner',active:true,createdAt:1,updatedAt:1}};
    for (const [table,row] of [['categories',category],['items',item]] as const) {
      const r=encodeCommandRecord(table,row,business.id);
      await f.db.query(`insert into public.${r.table}(${Object.keys(r.values).join(',')}) values(${Object.keys(r.values).map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(r.values));
    }
    const context={setup,items:[item],categories:[category]},change=generateShopLinkCommand({phone:'+14155550199',hours:'10 am–10 pm',deliveryNote:'Confirm delivery with the shop.',mode:'menu',itemIds:[item.id]},context,reviewShopLink(context,[item.id]),'https://shop.example.invalid/mise/app/');
    shop=change.shop;sourceUrl=change.outlet.shopLink!;setup={...setup,outlet:change.outlet};
    await f.db.query('update public.outlets set shop_link=$1,updated_at=$2 where id=$3',[sourceUrl,change.outlet.updatedAt,setup.outlet.id]);
  }
  async function publish(n=1,id=newInboxId(),eventId=newInboxId(),table:string|null=null,secret=shopSecret) {
    const args=[id,eventId,setup.outlet.id,sourceUrl,JSON.stringify(shop),await publicOrderHash(secret),table,null];
    const result=await f.asRole<Record<string,unknown>>(n,'authenticated','select public.publish_public_shop($1,$2,$3,$4,$5,$6,$7,$8) data',args);
    return {id,eventId,args,result};
  }
  async function intent(trackingToken='T'.repeat(43)):Promise<{trackingToken:string;source:PublicOrderIntent}> {
    return {trackingToken,source:{v:1,id:publicOrderAttemptIdFromHash(await publicOrderHash(trackingToken)),orderId:newInboxId(),eventId:newInboxId(),linkId:newInboxId(),linkEventId:newInboxId(),lineIds:[newInboxId()],
      shop:structuredClone(shop),name:'Sadia',phone:'+14155550150',fulfilment:'pickup',address:'',when:'Now',scheduledFor:null,selections:[{itemId:item.id,qty:2}],text:'',paymentPreference:'Cash',language:'en'}};
  }
  async function prepare(request:Awaited<ReturnType<typeof intent>>,operation='submit',global=1000,limit=30) {
    return f.asRole<Record<string,unknown>>(null,'service_role','select public.prepare_public_order($1,$2,$3,$4,$5,$6) data',
      [shopSecret,await publicOrderHash(request.trackingToken),publicOrderIntentJson(request.source),operation,global,limit]);
  }
  async function finish(request:Awaited<ReturnType<typeof intent>>,prepared:Record<string,unknown>,records=publicOrderRecords(prepared,request.source)) {
    return f.asRole<Record<string,unknown>>(null,'service_role','select public.finish_public_order($1,$2,$3) data',[request.source.id,prepared.ticketToken,JSON.stringify(records)]);
  }
  return {...f,seed,publish,intent,prepare,finish,shopSecret,item,get setup(){return setup;},get shop(){return shop;},get sourceUrl(){return sourceUrl;}};
}
