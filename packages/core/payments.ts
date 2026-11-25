import {parseMoney} from './money';
import {normalisePhone} from './phone';
import {marketPacks,type MarketCode} from './packs';

export type PaymentTextChannel='bkash'|'nagad'|'bank'|'unknown';
export interface PaymentTextContext {
  receivedAt:number;
  timeZone:string;
  currency:string;
  market?:MarketCode;
  sender?:string;
  dateOrder?:'DMY'|'MDY';
}
export interface ParsedPaymentText {
  parserVersion:1;
  sourceContext:Readonly<PaymentTextContext>;
  /** A recognized grammar is not proof that the message or transfer is genuine. */
  status:'recognized'|'manual';
  channel:PaymentTextChannel;
  direction:'incoming'|'outgoing'|'unknown';
  amount:number|null;
  currency:string;
  reference:string|null;
  fromPhone:string|null;
  receivedAt:number;
  timeSource:'message'|'capture';
  raw:string;
  warnings:string[];
}
export const paymentTextLimit=12000;
const maxTime=253402300799999;
const safeTime=(n:number)=>Number.isSafeInteger(n)&&n>=0&&n<=maxTime;
const digits=(s:string)=>s.replace(/[০-৯]/g,d=>String(d.charCodeAt(0)-0x09e6));
const currencyToken='(?:BDT|TK\\.?|৳|টাকা|USD|\\$|INR|₹|IDR|Rp|KES|KSh)';
const numberToken='[+-]?\\d[\\d.,]*';
const leadingAmount=new RegExp(`^(${currencyToken})\\s*(${numberToken})`,'i');
const currencyCodes:Record<string,string>={BDT:'BDT',TK:'BDT','৳':'BDT','টাকা':'BDT',USD:'USD','$':'USD',INR:'INR','₹':'INR',IDR:'IDR',RP:'IDR',KES:'KES',KSH:'KES'};
function currencyCode(token:string){return currencyCodes[token.replace(/\.$/,'').toUpperCase()];}
type Amount={amount:number|null;currency:string;start:number;end:number};
function amountAt(text:string,start:number):Amount|null {
  const found=leadingAmount.exec(text.slice(start));if(!found)return null;
  const end=start+found[0].length,currency=currencyCode(found[1]);
  // Never accept the numeric prefix of an exponent, glued identifier or malformed amount.
  const badTail=/[\p{L}\p{N}.,]/u.test(text[end]??'');
  const amount=badTail?null:parseMoney(found[2].replace(/\.(?=\s|$)/,''),currency);
  return {amount:amount!==null&&amount>0?amount:null,currency,start,end};
}
function allAmounts(text:string):Amount[]{
  const pattern=new RegExp(`(${currencyToken})\\s*(${numberToken})`,'gi'),result:Amount[]=[];
  let precedingAmountEnd=0;
  for(const match of text.matchAll(pattern)){
    const index=match.index!;
    if(index>0&&/[\p{L}\p{N}]/u.test(text[index-1]))continue;
    const context=text.slice(Math.max(precedingAmountEnd,text.lastIndexOf('\n',index)+1,text.lastIndexOf(';',index)+1),index);
    precedingAmountEnd=index+match[0].length;
    if(/\b(?:balance|available|bal|fees?|charges?)\b|ব্যালেন্স|ব্যালান্স|স্থিতি|চার্জ/iu.test(context))continue;
    const amount=amountAt(text,index);if(amount)result.push(amount);
  }
  return result;
}
const bkashSender=/^(?:bkash|বিকাশ)$/i,nagadSender=/^(?:nagad|নগদ)$/i;
const bankSender=/^(?:bank|dbbl|dutch[ -]bangla(?: bank)?|brac ?bank|ebl|eastern bank|city ?bank|mtb|ucb)$/i;
function channelFromSender(sender:string):PaymentTextChannel{return bkashSender.test(sender)?'bkash':nagadSender.test(sender)?'nagad':bankSender.test(sender)?'bank':'unknown';}
function bodyChannel(text:string,sender:string):{channel:PaymentTextChannel;body:string;conflict:boolean}{
  const prefix=/^(bKash|বিকাশ|Nagad|নগদ|DBBL|Dutch[ -]Bangla(?: Bank)?|BRAC ?Bank|EBL|Eastern Bank|City ?Bank|MTB|UCB|Bank)\s*[:—–-]\s*/i.exec(text);
  const a=channelFromSender(sender),b=prefix?channelFromSender(prefix[1]):'unknown';
  return {channel:b!=='unknown'?b:a,body:prefix?text.slice(prefix[0].length):text,conflict:a!=='unknown'&&b!=='unknown'&&a!==b};
}
function incomingAmount(body:string):{amount:Amount|null;grammar:'wallet'|'bank'|null}{
  const wallet=/^(?:(?:you\s+(?:have\s+)?)?received|(?:money|payment)\s+received)[.!:]?\s*(?:amount\s*[:=]?\s*)?/i.exec(body);
  if(wallet)return {amount:amountAt(body,wallet[0].length),grammar:'wallet'};
  const bangla=/^(?:আপনি\s+)?(?:পেমেন্ট\s+)?(?:পেয়েছেন|পেয়েছেন)\s*[:।]?\s*/u.exec(body);
  if(bangla)return {amount:amountAt(body,bangla[0].length),grammar:'wallet'};
  const trailingBangla=new RegExp(`^(?:আপনি\\s+)?(${numberToken})\\s*(টাকা|৳)\\s*(?:পেয়েছেন|পেয়েছেন)(?:\\s|[।.]|$)`,'u').exec(body);
  if(trailingBangla){const value=parseMoney(trailingBangla[1],'BDT');return {amount:{amount:value!==null&&value>0?value:null,currency:'BDT',start:0,end:trailingBangla[0].length},grammar:'wallet'};}
  const bank=/^(?:dear\s+customer[,\s]+)?(?:(?:your\s+)?(?:a\/?c|account)\s+(?:(?:no\.?|number)\s*[:#]?\s*)?[A-Za-z0-9*Xx.-]{1,40}\s+(?:(?:has\s+been|is|was)\s+)?credited\s*(?:(?:with|by|for)\s+)?|credit\s+alert\s*[:.-]?\s*)/i.exec(body);
  if(bank)return {amount:amountAt(body,bank[0].length),grammar:'bank'};
  const first=amountAt(body,0);
  if(first&&/^\s+(?:has\s+been\s+)?credited\s+to\s+(?:your\s+)?(?:a\/?c|account)\b/i.test(body.slice(first.end)))return {amount:first,grammar:'bank'};
  return {amount:null,grammar:null};
}
type Wall=[number,number,number,number,number,number];
const formatters=new Map<string,Intl.DateTimeFormat>();
function formatter(timeZone:string){let f=formatters.get(timeZone);if(!f){f=new Intl.DateTimeFormat('en-GB',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});if(formatters.size>=32)formatters.delete(formatters.keys().next().value!);formatters.set(timeZone,f);}return f;}
function wallAt(at:number,timeZone:string):Wall {const values=Object.fromEntries(formatter(timeZone).formatToParts(at).map(p=>[p.type,p.value]));return [Number(values.year),Number(values.month),Number(values.day),Number(values.hour),Number(values.minute),Number(values.second)];}
function utc(w:Wall){return Date.UTC(w[0],w[1]-1,w[2],w[3],w[4],w[5]);}
function validWall(w:Wall){const d=new Date(utc(w));return w[0]>=1000&&w[0]<=9999&&[d.getUTCFullYear(),d.getUTCMonth()+1,d.getUTCDate(),d.getUTCHours(),d.getUTCMinutes(),d.getUTCSeconds()].every((n,i)=>n===w[i]);}
/** Both sides of a DST transition are considered. A fold/gap stays ambiguous. */
function localTime(wall:Wall,timeZone:string):number|null {
  if(!validWall(wall))return null;
  const base=utc(wall),offsets=new Set([-36,0,36].map(hours=>{const at=base+hours*3600000;return utc(wallAt(at,timeZone))-at;})),possible=[...offsets].map(offset=>base-offset).filter(at=>safeTime(at)&&wallAt(at,timeZone).every((n,i)=>n===wall[i]));
  return possible.length===1?possible[0]:null;
}
function hours(hour:number,period:string|undefined):number|null{if(!period)return hour>=0&&hour<=23?hour:null;if(hour<1||hour>12)return null;return hour%12+(period.toUpperCase()==='PM'?12:0);}
function messageTime(text:string,context:PaymentTextContext):{at:number|null;mentioned:boolean}{
  const values:(number|null)[]=[];
  const safeUtc=(w:Wall)=>validWall(w)&&safeTime(utc(w))?utc(w):null;
  const printedLocal=(w:Wall,end:number)=>{
    const named=/^\s*(UTC|GMT|BST|EST|EDT|CST|CDT|PST|PDT|IST|CET|CEST)\b/i.exec(text.slice(end));
    return named?/^(UTC|GMT)$/i.test(named[1])?safeUtc(w):null:localTime(w,context.timeZone);
  };
  const iso=/\b(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:?\d{2})?(?![\d:.A-Za-z+-])/gi;
  for(const match of text.matchAll(iso)){
    const w:Wall=[+match[1],+match[2],+match[3],+match[4],+match[5],+(match[6]??0)],zone=match[7];
    if(!validWall(w)){values.push(null);continue;}
    const named=/^\s+(UTC|GMT|BST|EST|EDT|CST|CDT|PST|PDT|IST|CET|CEST)\b/i.exec(text.slice(match.index!+match[0].length));
    if(named){values.push(!zone&&/^(UTC|GMT)$/i.test(named[1])?safeUtc(w):null);continue;}
    if(!zone){values.push(localTime(w,context.timeZone));continue;}
    if(zone.toUpperCase()==='Z'){values.push(safeUtc(w));continue;}
    const parts=/^([+-])(\d{2}):?(\d{2})$/.exec(zone)!,h=+parts[2],m=+parts[3];
    if(h>14||m>59||h===14&&m!==0){values.push(null);continue;}
    const at=utc(w)-(h*60+m)*60000*(parts[1]==='+'?1:-1);values.push(safeTime(at)?at:null);
  }
  const local=/\b(\d{1,2})([/-])(\d{1,2})\2(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?(?![\d:A-Za-z])/gi;
  for(const match of text.matchAll(local)){
    const hour=hours(+match[5],match[8]),order=context.dateOrder??((context.market??'BD')==='BD'?'DMY':null);
    if(hour===null||!order){values.push(null);continue;}
    const w:Wall=[+match[4],+(order==='DMY'?match[3]:match[1]),+(order==='DMY'?match[1]:match[3]),hour,+match[6],+(match[7]??0)];
    values.push(printedLocal(w,match.index!+match[0].length));
  }
  const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const wordDate=/\b(\d{1,2})[ -](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[ -](\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?(?![\d:A-Za-z])/gi;
  for(const match of text.matchAll(wordDate)){
    const hour=hours(+match[4],match[7]);
    values.push(hour===null?null:printedLocal([+match[3],months.findIndex(m=>m.toLowerCase()===match[2].toLowerCase())+1,+match[1],hour,+match[5],+(match[6]??0)],match.index!+match[0].length));
  }
  const mentions=[...text.matchAll(/\b(?:\d{4}-\d{2}-\d{2}[T ]\d|\d{1,2}([/-])\d{1,2}\1\d{2,4}\b|\d{1,2}[ -](?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[ -]\d{2,4}\b)/gi)].length;
  const mentioned=values.length>0||mentions>0||/\b(?:at|on|date\s*:)\s*\d{1,4}[/-]/i.test(text);
  return {at:values.length===1&&mentions===1?values[0]:null,mentioned};
}

/** Read-only extraction. The raw source is never clipped or executed. */
export function parsePaymentText(raw:string,context:PaymentTextContext):ParsedPaymentText {
  if(typeof raw!=='string')throw new Error('Use the original payment text.');
  if(!context||!safeTime(context.receivedAt)||typeof context.currency!=='string'||!/^[A-Z]{3}$/.test(context.currency)||typeof context.timeZone!=='string'||context.timeZone.length>128||context.sender!==undefined&&(typeof context.sender!=='string'||context.sender.length>200)||context.market!==undefined&&(typeof context.market!=='string'||!Object.hasOwn(marketPacks,context.market))||context.dateOrder!==undefined&&!['DMY','MDY'].includes(context.dateOrder))throw new Error('Use the installation’s currency, source timezone and actual capture context.');
  formatter(context.timeZone);
  const savedContext:PaymentTextContext={receivedAt:context.receivedAt,timeZone:context.timeZone,currency:context.currency,...(context.market!==undefined?{market:context.market}:{}),...(context.sender!==undefined?{sender:context.sender}:{}),...(context.dateOrder!==undefined?{dateOrder:context.dateOrder}:{})};
  const result:ParsedPaymentText={parserVersion:1,sourceContext:Object.freeze(savedContext),status:'manual',channel:'unknown',direction:'unknown',amount:null,currency:context.currency,reference:null,fromPhone:null,receivedAt:context.receivedAt,timeSource:'capture',raw,warnings:[]};
  if(raw.length>paymentTextLimit){result.warnings.push('The source is longer than 12,000 characters. Keep it in full and enter the payment by hand.');return result;}
  const text=digits(raw).replace(/\u00a0/g,' ').trim(),scope=bodyChannel(text,(context.sender??'').trim());result.channel=scope.channel;
  const body=scope.body,primary=incomingAmount(body),amounts=allAmounts(body);
  const firstAmount=amountAt(body,0);
  const outgoing=/^(?:dear\s+customer[,\s]+)?(?:you\s+(?:have\s+)?(?:sent|paid)|send\s+money|money\s+sent|cash\s*out|payment\s+(?:of\s+)?(?:Tk\.?|BDT|৳)|(?:your\s+)?(?:a\/?c|account)\b[^\r\n]{0,80}\bdebited\b|debit\s+alert)/i.test(body)||!!firstAmount&&/^\s+(?:has\s+been\s+)?(?:debited|deducted|withdrawn|sent|paid)\b/i.test(body.slice(firstAmount.end));
  const blocked=/\b(?:OTP|one[ -]time\s+(?:password|code)|verification\s+code|reversed|reversal|refunded|refund|failed|unsuccessful|credit\s+limit|loan\s+limit)\b/i.test(body);
  if(primary.grammar==='bank'&&result.channel==='unknown')result.channel='bank';
  const selected=primary.amount??(amounts.length===1?amounts[0]:null);
  if(selected){result.amount=selected.amount;result.currency=selected.currency;}
  const incomingStarts=(body.match(/\b(?:you\s+(?:have\s+)?received|money\s+received|payment\s+received|credited)\b/gi)??[]).length;
  const contradictory=/\b(?:debited|send\s+money|cash\s*out|you\s+(?:have\s+)?sent)\b/i.test(body);
  result.direction=outgoing?'outgoing':primary.grammar?'incoming':'unknown';
  const refs=[...body.matchAll(/\b(?:Trx\s*ID|Txn\s*ID|Tx\s*ID|Transaction\s*ID|Transaction\s*(?:No\.?|Number)|Ref\s*ID)\s*[:#=]?\s*([A-Za-z0-9][A-Za-z0-9_-]{2,63})(?![A-Za-z0-9_-])/gi)];
  const refMentions=[...body.matchAll(/\b(?:Trx\s*ID|Txn\s*ID|Tx\s*ID|Transaction\s*ID|Transaction\s*(?:No\.?|Number)|Ref\s*ID)\b/gi)].length;
  const badReference=refMentions!==refs.length||refs.length>1;
  if(refs.length===1&&!badReference)result.reference=refs[0][1];else if(badReference)result.warnings.push('The transaction reference is invalid or ambiguous. Check the original.');
  const from=/\bfrom\s*:?\s*([^\r\n]{1,150})/i.exec(body)?.[1].split(/\b(?:Ref|Fee|Balance|TrxID|TxnID|TxID|Transaction|Date|at|on)\b/i)[0];
  if(from){
    const masked=[...from.matchAll(/(?<![\p{L}\p{N}])[+\dxX*•●…][\dxX*•●… -]{4,}[\dxX*•●…]/gu)].some(match=>/[xX*•●…]/.test(match[0]));
    const phones=masked?[]:[...from.matchAll(/(?<![\p{L}\p{N}+])(\+?\d{7,15})(?![\p{L}\p{N}])/gu)].map(m=>normalisePhone(m[1],context.market??'BD')).filter((p):p is string=>p!==null);
    if(phones.length===1)result.fromPhone=phones[0];else if(masked)result.warnings.push('The sender number is masked. Enter it yourself if needed.');
  }
  const when=messageTime(body,context);
  if(when.at!==null){result.receivedAt=when.at;result.timeSource='message';}else result.warnings.push(when.mentioned?'The message time is invalid or ambiguous. Check the received time.':'No message time was found. Check the capture time.');
  const future=result.receivedAt>context.receivedAt+5*60000;
  if(future)result.warnings.push('The message time is in the future. Check the received time.');
  const controls=/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(raw);
  if(controls)result.warnings.push('The source contains unsupported control characters. Check the original.');
  const unplacedAmounts=primary.amount?amounts.filter(a=>a.start!==primary.amount!.start):amounts;
  if(primary.amount?unplacedAmounts.length>0:amounts.length>1)result.warnings.push('More than one transfer amount may be present. Check the original.');
  const walletKnown=primary.grammar==='wallet'&&['bkash','nagad'].includes(result.channel),bankKnown=primary.grammar==='bank'&&result.channel==='bank';
  if(!outgoing&&!blocked&&!contradictory&&!scope.conflict&&!controls&&!badReference&&incomingStarts<=1&&unplacedAmounts.length===0&&result.amount!==null&&(walletKnown||bankKnown)&&!future&&(!when.mentioned||when.at!==null))result.status='recognized';
  if(result.status==='manual')result.warnings.push(scope.conflict?'The sender and message provider disagree. Enter the payment by hand.':outgoing||contradictory?'This may describe outgoing money. Check it before recording anything.':blocked?'This is not a supported incoming-payment message.':'This format needs manual entry. Check every field.');
  return result;
}

/** A payment form uses the installation's clock, never the browser's timezone. */
export function paymentWallTime(at:number,timeZone:string):string {
  if(!safeTime(at))throw new Error('Choose a valid received date and time.');
  const w=wallAt(at,timeZone),ms=at%1000;
  return `${String(w[0]).padStart(4,'0')}-${String(w[1]).padStart(2,'0')}-${String(w[2]).padStart(2,'0')}T${String(w[3]).padStart(2,'0')}:${String(w[4]).padStart(2,'0')}:${String(w[5]).padStart(2,'0')}.${String(ms).padStart(3,'0')}`;
}
export function parsePaymentWallTime(value:string,timeZone:string):number {
  const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(value);
  if(!m)throw new Error('Enter the received date and time.');
  const at=localTime([+m[1],+m[2],+m[3],+m[4],+m[5],+(m[6]??0)],timeZone);
  if(at===null)throw new Error('This time is missing or occurs twice in the selected timezone. Check the original and choose an unambiguous time.');
  const result=at+Number((m[7]??'').padEnd(3,'0'));if(!safeTime(result))throw new Error('Choose a valid received date and time.');return result;
}
