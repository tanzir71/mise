import {backupToken,parseBackup} from './backup';
import {backupTableNames,emptyBackupTables,type BackupTable,type MiseBackup} from './backup-tables';

type FieldMap=Readonly<Record<string,string>>;
interface TableMap {table:string;fields:FieldMap}
// j = serialized JSON (including literal strings); e = JSON-escaped text key;
// n = number; b = boolean. Unmarked fields are canonical strings/IDs/enums.
const entity={id:'id',created_at:'n:createdAt',updated_at:'n:updatedAt'};
const owned={...entity,outlet_id:'outletId'};
const dated={created_by:'createdBy',event_id:'eventId'};
const revision={revision:'n:revision'};
const voided={voided_at:'n:voidedAt'};
export const cloudRecordMaps={
  businesses:{table:'businesses',fields:{...entity,name:'j:name',business_type:'businessType',market_code:'marketCode',languages:'j:languages'}},
  outlets:{table:'outlets',fields:{...entity,business_id:'businessId',name:'j:name',address:'j:address',timezone:'timezone',currency:'currency',shop_link:'shopLink',credit_messaging:'j:creditMessaging',order_warning_minutes:'n:orderWarningMinutes'}},
  members:{table:'members',fields:{...entity,business_id:'businessId',name:'j:name',phone:'phone',role:'role',active:'b:active'}},
  categories:{table:'categories',fields:{...owned,name:'j:name',sort:'n:sort'}},
  items:{table:'items',fields:{...owned,name:'j:name',name_local:'j:nameLocal',category_id:'categoryId',price:'n:price',unit:'j:unit',available:'b:available',is_sample:'b:isSample',often_bought:'b:oftenBought'}},
  customers:{table:'customers',fields:{...entity,business_id:'businessId',name:'j:name',nickname:'j:nickname',phone:'phone',address:'j:address',notes:'j:notes',tags:'j:tags',consent:'j:consent',archived_at:'n:archivedAt'}},
  creditAccounts:{table:'credit_accounts',fields:{...owned,customer_id:'customerId',currency:'currency',allowed:'b:allowed',credit_limit:'n:limit',reminder:'j:reminder'}},
  creditEntries:{table:'credit_entries',fields:{...owned,...dated,account_id:'accountId',customer_id:'customerId',currency:'currency',sequence:'n:sequence',type:'type',amount:'n:amount',note:'j:note',sale_id:'saleId',order_id:'orderId',refund_id:'refundId',returns_charge_id:'returnsChargeId',method_name:'j:methodName',occurred_at:'n:occurredAt',reversal_of:'reversalOf',purpose:'purpose',over_limit:'j:overLimit'}},
  orders:{table:'orders',fields:{...owned,...dated,...revision,business_type:'businessType',sequence:'n:sequence',number:'number',source:'source',source_text:'j:sourceText',customer_id:'customer.id',customer_name:'j:customer.name',customer_phone:'customer.phone',type:'type',status:'status',status_changed_at:'n:statusChangedAt',status_event_id:'statusEventId',lines:'j:lines',subtotal:'n:subtotal',delivery_fee:'n:deliveryFee',discount:'n:discount',total:'n:total',currency:'currency',timezone:'timezone',address:'j:address',table_label:'j:table',scheduled_for:'n:scheduledFor',payment:'j:payment',handled_by:'handledBy'}},
  sales:{table:'sales',fields:{...owned,...dated,...voided,order_id:'orderId',order_number:'orderNumber',closing_id:'closingId',delivery_fee:'n:deliveryFee',discount:'n:discount',expression:'expression',amount:'n:amount',currency:'currency',method:'method',method_name:'j:methodName',given:'n:given',change:'n:change',who:'j:who',customer_id:'customerId',credit_account_id:'creditAccountId',items:'j:items',shop_name:'j:shopName',shop_link:'shopLink',timezone:'timezone',void_reason:'voidReason'}},
  orderNotes:{table:'order_notes',fields:{...owned,...dated,...revision,order_id:'orderId',text:'j:text'}},
  orderCommunications:{table:'order_communications',fields:{...owned,...dated,...revision,order_id:'orderId',purpose:'purpose',channel:'channel',text:'j:text'}},
  orderRefunds:{table:'order_refunds',fields:{...owned,...dated,...voided,order_id:'orderId',sale_id:'saleId',customer_id:'customerId',account_id:'accountId',amount:'n:amount',currency:'currency',method:'method',method_name:'j:methodName',note:'j:note',credit_entry_id:'creditEntryId'}},
  suppliers:{table:'suppliers',fields:{...owned,...revision,name:'j:name',phone:'phone',note:'j:note',archived_at:'n:archivedAt',event_id:'eventId'}},
  stockItems:{table:'stock_items',fields:{...owned,...revision,name:'j:name',name_local:'j:nameLocal',active_key:'e:activeKey',unit:'j:unit',category:'j:category',aliases:'j:aliases',on_hand:'n:onHand',target:'n:target',pack_size:'n:packSize',low_at:'n:lowAt',supplier_id:'supplierId',archived_at:'n:archivedAt',last_counted_at:'n:lastCountedAt',event_id:'eventId'}},
  stockMoves:{table:'stock_moves',fields:{...owned,...dated,...revision,stock_item_id:'stockItemId',name:'j:name',unit:'j:unit',before_quantity:'n:before',after_quantity:'n:after',delta:'n:delta',reason:'reason',source:'source',note:'j:note',count_batch_id:'countBatchId',undo_of:'undoOf'}},
  supplierMessages:{table:'supplier_messages',fields:{...owned,...dated,...voided,supplier_id:'supplierId',supplier_name:'j:supplierName',phone:'phone',text:'j:text',channel:'channel',stock_item_ids:'j:stockItemIds',part:'n:part',parts:'n:parts'}},
  dayClosings:{table:'day_closings',fields:{...owned,...dated,...voided,active_key:'e:activeKey',day:'day',timezone:'timezone',currency:'currency',summary:'j:summary',counted_cash:'n:countedCash',expected_cash:'n:expectedCash',difference:'n:difference',added_walk_in:'n:addedWalkIn',added_sale_id:'addedSaleId',note:'j:note',preview_fingerprint:'previewFingerprint',created_by_name:'j:createdByName'}},
  purchases:{table:'purchases',fields:{...owned,...dated,...voided,supplier_id:'supplierId',supplier_name:'j:supplierName',reference:'j:reference',lines:'j:lines',total:'n:total',currency:'currency',timezone:'timezone',paid:'paid',method_name:'j:methodName',note:'j:note',photo_ref:'photoRef'}},
  inboxItems:{table:'inbox_items',fields:{...owned,...revision,title:'j:title',text:'j:text',url:'j:url',kind:'kind',archived:'b:archived'}},
  events:{table:'events',fields:{id:'id',outlet_id:'outletId',actor_type:'actor.type',actor_id:'actor.id',command:'command',before_data:'j:before',after_data:'j:after',at:'n:at',undo_of:'undoOf',customer_id:'customerId',order_id:'orderId',order_revision:'n:orderRevision',stock_item_id:'stockItemId',stock_revision:'n:stockRevision',supplier_id:'supplierId',closing_id:'closingId',handoff_id:'handoffId',handoff_revision:'n:handoffRevision',handoff_topic:'handoffTopic',inbox_id:'inboxId',inbox_revision:'n:inboxRevision'}},
} as const satisfies Record<BackupTable,TableMap>;

export type CloudValue=string|number|boolean|null;
export interface CloudRecord {table:string;values:Record<string,CloudValue>}
export interface CloudFile {path:string;data:string}
export interface CloudMigration {version:1;exportedAt:number;records:CloudRecord[];files:CloudFile[]}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const field=(spec:string)=>{const colon=spec.indexOf(':');return colon===1?{kind:spec[0],path:spec.slice(2)}:{kind:'s',path:spec};};
function getPath(row:unknown,path:string):unknown {
  let value=row;
  for(const key of path.split('.')){
    if(value===null||typeof value!=='object'||!Object.hasOwn(value,key))return undefined;
    value=(value as Record<string,unknown>)[key];
  }
  return value;
}
function putPath(row:Record<string,unknown>,path:string,value:unknown):void {
  const keys=path.split('.');let target=row;
  for(const key of keys.slice(0,-1))target=(target[key]??={}) as Record<string,unknown>;
  target[keys.at(-1)!]=value;
}
function encodeFields(source:unknown,fields:FieldMap):Record<string,CloudValue>{
  return Object.fromEntries(Object.entries(fields).map(([column,spec])=>{
    const {kind,path}=field(spec),value=getPath(source,path);
    if(value===undefined)return [column,null];
    if(kind==='j'||kind==='e')return [column,JSON.stringify(value)];
    if(value!==null&&!['string','number','boolean'].includes(typeof value))throw new Error(`Unsupported cloud field ${column}.`);
    return [column,value as CloudValue];
  }));
}
function decodeFields(values:Record<string,CloudValue>,fields:FieldMap,table:BackupTable):Record<string,unknown>{
  const row:Record<string,unknown>={};
  for(const [column,spec] of Object.entries(fields)){
    if(!Object.hasOwn(values,column))throw new Error(`Cloud record is missing ${column}.`);
    const {kind,path}=field(spec),value=values[column];
    if(value===null&&!(table==='orders'&&path==='total'))continue;
    let decoded:unknown=value;
    if((kind==='j'||kind==='e')&&value!==null){if(typeof value!=='string')throw new Error(`Invalid cloud JSON field ${column}.`);decoded=JSON.parse(value);}
    else if(kind==='n'&&value!==null)decoded=typeof value==='string'?Number(value):value;
    putPath(row,path,decoded);
  }
  return row;
}
/** Server command transport only: validate and authorize the mutation separately. */
export function encodeCommandRecord(table:BackupTable,row:unknown,businessId:string):CloudRecord {
  const map=cloudRecordMaps[table];return {table:map.table,values:{...encodeFields(row,map.fields),business_id:businessId}};
}
/** SQL row_to_json retains literal JSON; convert it through the same field map. */
export function decodeCommandRecord(table:BackupTable,row:Record<string,unknown>):Record<string,unknown>{
  const map=cloudRecordMaps[table],values:Record<string,CloudValue>={};
  for(const [column,spec] of Object.entries(map.fields)){
    const value=row[column],{kind}=field(spec);
    const auditNull=table==='events'&&(column==='before_data'||column==='after_data')&&value===null;
    values[column]=auditNull?'null':value===null||value===undefined?null:kind==='j'?JSON.stringify(value):value as CloudValue;
  }
  return decodeFields(values,map.fields,table);
}
async function fileHash(data:string):Promise<string>{
  const raw=atob(data),bytes=new Uint8Array(raw.length);
  for(let index=0;index<raw.length;index++)bytes[index]=raw.charCodeAt(index);
  const hash=await crypto.subtle.digest('SHA-256',bytes);
  return Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join('');
}

/** Build an inert upload plan. authUserId must come from verified server Auth, never the backup. */
export async function prepareCloudMigration(source:MiseBackup,authUserId:string):Promise<CloudMigration>{
  if(!uuid.test(authUserId))throw new Error('Use the verified owner Auth identity.');
  // Snapshot before the first async hash so later edits cannot change a reviewed plan.
  parseBackup(source);
  const backup=parseBackup(JSON.stringify(source)),{tables}=backup;
  if(tables.businesses.length!==1||tables.outlets.length!==1||tables.members.length!==1||!tables.members[0].active)
    throw new Error('Set up one local shop and owner before turning on sync.');
  const businessId=tables.businesses[0].id,outlet=tables.outlets[0];
  const result:CloudMigration={version:1,exportedAt:backup.exportedAt,records:[],files:[]};
  for(const name of backupTableNames){
    const map=cloudRecordMaps[name];
    for(const row of tables[name]){
      const values=encodeFields(row,map.fields);
      if(name!=='businesses')values.business_id=businessId;
      if(name==='members')values.auth_user_id=authUserId.toLowerCase();
      result.records.push({table:map.table,values});
      if(name==='members')for(const outletId of tables.members[0].outletIds)
        result.records.push({table:'member_outlets',values:{business_id:businessId,member_id:row.id,outlet_id:outletId}});
      if(name==='customers')result.records.push({table:'customer_outlets',values:{business_id:businessId,outlet_id:outlet.id,customer_id:row.id}});
      if(name==='inboxItems'){
        const item=row as MiseBackup['tables']['inboxItems'][number];
        if(item.outletId===null)throw new Error('Finish setup and claim pending Inbox items before turning on sync.');
        for(const [position,image] of item.images.entries()){
          const path=`${businessId}/${item.outletId}/${item.id}/${image.id}`;
          result.records.push({table:'inbox_images',values:{id:image.id,business_id:businessId,outlet_id:item.outletId,inbox_item_id:item.id,
            position,name:JSON.stringify(image.name),type:image.type,size:image.size,sha256:await fileHash(image.data),
            created_at:item.createdAt,updated_at:item.createdAt,uploaded_at:null}});
          result.files.push({path,data:image.data});
        }
      }
    }
  }
  const recovered=await readCloudMigration(result);
  if(backupToken(recovered)!==backupToken(backup))throw new Error('This app version cannot preserve every local field in a cloud migration. Keep the local backup.');
  return result;
}

/** Reconstruct and validate a complete migration snapshot, including original file hashes. */
export async function readCloudMigration(plan:CloudMigration):Promise<MiseBackup>{
  if(plan.version!==1||!Array.isArray(plan.records)||!Array.isArray(plan.files))throw new Error('Unsupported cloud migration.');
  const tables=emptyBackupTables(),fileMap=new Map<string,string>();
  for(const file of plan.files){if(fileMap.has(file.path))throw new Error('Duplicate cloud file.');fileMap.set(file.path,file.data);}
  const usedFiles=new Set<string>(),extras:CloudRecord[]=[];
  for(const record of plan.records){
    const entry=Object.entries(cloudRecordMaps).find(([,map])=>map.table===record.table);
    if(!entry){
      const columns:Record<string,string[]>={member_outlets:['business_id','member_id','outlet_id'],customer_outlets:['business_id','outlet_id','customer_id'],
        inbox_images:['id','business_id','outlet_id','inbox_item_id','position','name','type','size','sha256','created_at','updated_at','uploaded_at']};
      const allowed=Object.hasOwn(columns,record.table)?columns[record.table]:undefined;
      if(!allowed)throw new Error('Unsupported cloud table.');
      if(Object.keys(record.values).length!==allowed.length||Object.keys(record.values).some(key=>!allowed.includes(key)))throw new Error('Unsupported cloud metadata columns.');
      extras.push(record);continue;
    }
    const [name,map]=entry as [BackupTable,TableMap];
    const allowed=new Set([...Object.keys(map.fields),...(name==='businesses'?[]:['business_id']),...(name==='members'?['auth_user_id']:[])]);
    if(Object.keys(record.values).some(column=>!allowed.has(column)))throw new Error('Unsupported cloud record column.');
    const decoded=decodeFields(record.values,map.fields,name);
    if(name==='members')decoded.outletIds=[];
    if(name==='inboxItems')decoded.images=[];
    (tables[name] as unknown[]).push(decoded);
  }
  const businessId=tables.businesses[0]?.id,outletId=tables.outlets[0]?.id;
  for(const record of plan.records)if(record.table!=='businesses'&&record.values.business_id!==businessId)throw new Error('Cloud record belongs to another business.');
  for(const record of extras){
    const v=record.values;
    if(record.table==='member_outlets'){
      const member=tables.members.find(row=>row.id===v.member_id);
      if(!member||v.outlet_id!==outletId||member.outletIds.includes(v.outlet_id))throw new Error('Invalid cloud member assignment.');
      member.outletIds.push(v.outlet_id);
    }else if(record.table==='customer_outlets'){
      if(v.outlet_id!==outletId||!tables.customers.some(row=>row.id===v.customer_id))throw new Error('Invalid cloud customer assignment.');
    }else{
      const item=tables.inboxItems.find(row=>row.id===v.inbox_item_id);
      if(!item||v.outlet_id!==item.outletId||!Number.isInteger(v.position)||(v.position as number)<0||(v.position as number)>3)throw new Error('Invalid cloud image ownership or order.');
      const path=`${businessId}/${item.outletId}/${item.id}/${v.id}`,data=fileMap.get(path);
      if(data===undefined||usedFiles.has(path)||await fileHash(data)!==v.sha256)throw new Error('A cloud image is missing or has changed.');
      if(typeof v.name!=='string'||typeof v.id!=='string'||typeof v.type!=='string'||typeof v.size!=='number')throw new Error('Invalid cloud image metadata.');
      if(item.images[v.position as number]!==undefined)throw new Error('Duplicate cloud image position.');
      item.images[v.position as number]={id:v.id,name:JSON.parse(v.name),type:v.type as 'image/jpeg'|'image/png'|'image/webp',size:v.size,data};
      usedFiles.add(path);
    }
  }
  for(const item of tables.inboxItems)if(item.images.some(image=>image===undefined)||Object.keys(item.images).length!==item.images.length)throw new Error('Cloud image positions contain a gap.');
  const associations=extras.filter(row=>row.table==='customer_outlets');
  if(associations.length!==tables.customers.length||new Set(associations.map(row=>row.values.customer_id)).size!==tables.customers.length)throw new Error('Cloud customer assignments are incomplete.');
  if(usedFiles.size!==fileMap.size)throw new Error('Cloud files contain an unreferenced image.');
  return parseBackup({format:'mise-backup',formatVersion:1,schemaVersion:10,exportedAt:plan.exportedAt,tables});
}
