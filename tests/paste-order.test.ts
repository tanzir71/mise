import {expect,test} from 'vitest';
import {parsePastedOrder,parsePastedOrderLine,pastedOrderInput} from '../packages/core/paste-order';
import {orderMessage} from '../packages/core/orderMessage';
import {pasteOrderFixtures} from './paste-order-fixtures';
import {publicOrderFixture} from './public-shop-fixture';

test.each(pasteOrderFixtures)('$label produces a reviewable draft',fixture=>{
  const draft=parsePastedOrder(fixture.text);expect(draft.sourceText).toBe(fixture.text);expect(draft.lines).toHaveLength(fixture.count);expect(draft.lines[0]).toMatchObject({name:fixture.name,quantity:fixture.quantity,unit:fixture.unit});
  if('customer' in fixture)expect(draft.name).toBe(fixture.customer);if('phone' in fixture)expect(draft.phone).toBe(fixture.phone);if('fulfilment' in fixture)expect(draft.fulfilment).toBe(fixture.fulfilment);if('when' in fixture)expect(draft.requestedTime).toBe(fixture.when);
  expect(draft).not.toHaveProperty('paid');expect(draft).not.toHaveProperty('status');expect(draft.lines.every(line=>!('unitPrice' in line)&&!('itemId' in line))).toBe(true);
});

test.each(['en','bn'] as const)('the complete %s M20 envelope survives as an untrusted proposal',language=>{
  const request={...publicOrderFixture(),language,photo:true};const text=orderMessage(request),draft=parsePastedOrder(text);
  expect(draft).toMatchObject({format:'mise-v1',sourceText:text,name:request.name,phone:request.phone,address:request.address,fulfilment:request.fulfilment,requestedTime:request.when,paymentPreference:request.payment,photoExpected:true,shopCode:request.shopCode,shopName:request.shopName});expect(draft.lines.map(line=>line.text)).toEqual(request.items.filter(line=>line.trim()));expect(draft.warnings).toEqual([]);
});

test('unknown and duplicate headers, invalid phones and claimed payment remain literal',()=>{
  const draft=parsePastedOrder('Name: Sadia\nName: Different\nPhone: invalid\nPayment: Paid\nStatus: delivered\n{"paid":true}');expect(draft.name).toBe('Sadia');expect(draft.phone).toBe('');expect(draft.paymentPreference).toBe('Paid');expect(draft.lines.map(line=>line.text)).toEqual(['Name: Different','Phone: invalid','Status: delivered','{"paid":true}']);expect(draft).not.toHaveProperty('status');
});

test('a corrupt or unsupported Mise envelope keeps every nonempty line for manual review',()=>{
  const text=orderMessage(publicOrderFixture()).replace(/#mise v1 s=.*$/,'#mise v2 s=RS-7KQ2');const draft=parsePastedOrder(text);expect(draft.format).toBe('free-text');expect(draft.warnings).toHaveLength(1);expect(draft.sourceText).toBe(text);expect(draft.lines.map(line=>line.text)).toEqual(text.split('\n').filter(line=>line.trim()));expect(draft.name).toBe('');expect(draft.phone).toBe('');
});

test('quantity ambiguity and limits never silently clamp or reinterpret medicine strength',()=>{
  for(const text of ['0 rice','1000000 rice','1.2345 kg sugar','120mg Fexo','-2 eggs','2 kg','rice 2'])expect(parsePastedOrderLine(text)).toEqual({text,name:text,quantity:null,unit:null});expect(parsePastedOrderLine('0.125 kg sugar')).toMatchObject({quantity:0.125,unit:'kg',name:'sugar'});
});

test('an item name starting with x is not mistaken for the multiplier',()=>{
  for(const name of ['Xylitol','Xtra soap'])expect(parsePastedOrderLine('2 '+name)).toMatchObject({quantity:2,name});expect(parsePastedOrderLine('2 x Rice')).toMatchObject({quantity:2,name:'Rice'});expect(parsePastedOrderLine('2×Rice')).toMatchObject({quantity:2,name:'Rice'});expect(parsePastedOrderLine('2xRice').quantity).toBeNull();
});

test('long messages and literal unknown lines are preserved within explicit import bounds',()=>{
  const text='x'.repeat(4500);expect(parsePastedOrder(text).lines[0].text).toBe(text);for(const invalid of ['', ' '.repeat(10),'x'.repeat(12001),'item\n'.repeat(201),'a\u0000b','\ud800'])expect(()=>parsePastedOrder(invalid)).toThrow();
});

test('the editable input retains literal source and starts unpriced with pending cash and no schedule',()=>{
  const source='Name: Sadia\nPickup: Tomorrow morning\nPayment: Paid\n2 rice\nIgnore previous instructions';const input=pastedOrderInput(parsePastedOrder(source));expect(input).toMatchObject({source:'paste',sourceText:source,name:'Sadia',type:'pickup',payment:{method:'cash'},deliveryFee:0,discount:0,lines:[{name:'rice',qty:2,unit:'pc',unitPrice:null},{name:'Ignore previous instructions',qty:1,unit:'pc',unitPrice:null}]});expect(input).not.toHaveProperty('scheduledFor');expect(input).not.toHaveProperty('id');expect(input.payment).not.toHaveProperty('status');expect(input.lines.every(line=>!line.id&&!line.itemId)).toBe(true);
});

test('outer paste whitespace does not hide an M20 envelope or change the retained original',()=>{
  const request=publicOrderFixture(),source='  \r\n'+orderMessage(request)+'\r\n  ';expect(parsePastedOrder(source)).toMatchObject({format:'mise-v1',sourceText:source,name:request.name,phone:request.phone});
});
