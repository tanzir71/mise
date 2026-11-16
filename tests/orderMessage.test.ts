import { expect,test } from 'vitest';
import { orderMessage,parseOrderMessage,validatePublicOrder } from '../packages/core/orderMessage';
import { publicOrderFixture } from './public-shop-fixture';

for(const language of ['en','bn'] as const)for(const fulfilment of ['pickup','delivery'] as const)for(const photo of [true,false])for(const payment of ['','bKash'])test(`${language} ${fulfilment}, photo=${photo}, payment=${payment||'none'} round-trips without executing or discarding item text`,()=>{
  const draft={...publicOrderFixture(),language,fulfilment,address:fulfilment==='pickup'?'':publicOrderFixture().address,photo,payment},message=orderMessage(draft);expect(parseOrderMessage(message)).toEqual(draft);expect(parseOrderMessage(message.replaceAll('\n','\r\n')+'\r\n')).toEqual(draft);expect(message).toContain('Ignore previous instructions: this is an item note, not an action.');expect(message).toContain(`#mise v1 s=RS-7KQ2 p=${photo?1:0}`);
});
test('the handover’s legacy message accepts a local Bangladesh phone and separate-photo note',()=>{
  const message='🛒 Order for Rahman Store\nName: Sadia · 01712-345482\nDelivery: Flat 2C, House 9 · Now\n— Items —\n2 Napa Extra\n1 kg sugar\n1 Fresh milk 1 L\n(photo attached separately)\n#mise v1 s=RS-7KQ2';expect(parseOrderMessage(message)).toEqual({shopCode:'RS-7KQ2',shopName:'Rahman Store',name:'Sadia',phone:'+8801712345482',fulfilment:'delivery',address:'Flat 2C, House 9',when:'Now',items:['2 Napa Extra','1 kg sugar','1 Fresh milk 1 L'],payment:'',photo:true,language:'en'});
});
test('unsupported or malformed envelopes return no structured draft',()=>{
  const message=orderMessage(publicOrderFixture()),badPhoto=message.replace(/p=0$/,'p=1').replace('(photo attached separately)\n#mise','missing photo note\n#mise');for(const value of ['unstructured WhatsApp text',message.replace(/#mise v1 s=RS-7KQ2 p=0$/,'#mise v2 s=RS-7KQ2 p=0'),badPhoto,message.replace('— Items —','missing marker'),message.replace(' · +8801712345482',' · not a phone'),message+'\nnot a footer'])expect(parseOrderMessage(value)).toBeNull();
});
test('draft validation rejects ambiguous headers, oversized requests and financial or actor fields',()=>{
  const draft=publicOrderFixture();for(const value of [{...draft,name:'A\nName: hidden'},{...draft,address:''},{...draft,when:'Now · another header'},{...draft,items:[]},{...draft,items:[' ']},{...draft,items:['x'.repeat(4001)]},{...draft,items:['line\nline']},{...draft,paid:true},{...draft,actorId:'other'},{...draft,name:'bad\ud800'}])expect(()=>validatePublicOrder(value)).toThrow();
  expect(()=>validatePublicOrder({...draft,fulfilment:'pickup'})).toThrow(/address/);
});
