import Dexie from 'dexie';
import { MiseDatabase } from '../../apps/web/src/data/db';
import { createOperatorRemote } from '../../apps/web/src/data/operator-remote';
import { selectCloudOperator } from '../../apps/web/src/data/operator-state';
import { joinCanonicalDevice } from '../../apps/web/src/data/cloud-sync-join';
import {
  applyCanonicalDownload,
  adoptOwnerUpload,
} from '../../apps/web/src/data/cloud-sync-apply';
import {
  prepareSyncDownload,
  runSyncDownload,
} from '../../apps/web/src/data/cloud-sync-journal';
import { downloadSyncImages } from '../../apps/web/src/data/cloud-sync-images';
import { createCloudSyncRemote } from '../../apps/web/src/data/cloud-sync-remote';
import { createCloudImageRemote } from '../../apps/web/src/data/cloud-image-remote';
import { createCloudCoverageRemote } from '../../apps/web/src/data/cloud-coverage-remote';
import { createCloudUploadCoverageRemote } from '../../apps/web/src/data/cloud-upload-coverage-remote';
import { CloudUploadJournal } from '../../apps/web/src/data/cloud-upload';
import { storedInboxItems } from '../../apps/web/src/data/inbox';
import { runSyncCycle } from '../../apps/web/src/data/sync-cycle';
import {
  ensureSyncSession,
  requestSync,
} from '../../apps/web/src/data/sync-session';
import { createShopCommandRemote } from '../../apps/web/src/data/shop-command-remote';
import {createCloudOrderReviewRemote} from '../../apps/web/src/data/cloud-order-review-remote';
import {prepareOrderReviewSource} from '../../apps/web/src/data/order-review-source';
import {isOrderCommand} from '../../packages/core/shop-commands';
import type {OrderReviewDecision} from '../../packages/core/order-review';
import {
  createPhoneAuth,
  type PhoneAuth,
} from '../../apps/web/src/data/phone-auth';
import { watchOperatorAuth } from '../../apps/web/src/data/operator-auth';
import { lockLocalOperator } from '../../apps/web/src/data/operator-state';
import {
  deliverLocalOutbox,
  beginLocalUpload,
  acceptLocalUpload,
  readLocalActionReviews,
} from '../../apps/web/src/data/local-outbox';
import {
  backupTableNames,
  type MiseBackup,
} from '../../packages/core/backup-tables';
import type { CloudUploadManifest } from '../../packages/core/cloud-upload';
import type { CloudUploadReceipt } from '../../packages/core/cloud-upload-runner';
import {
  cloudConnectionTarget,
  cloudAuthStorageKey,
  saveCloudConnection,
} from '../../packages/core/cloud-connection';
import { operatorAccountHash } from '../../packages/core/operators';
import { newInboxId } from '../../packages/core/inbox';
import { defaultCreditMessaging } from '../../packages/core/khata-messages';
import { defaultCreditTerms } from '../../packages/core/khata';
import { reviewShopLink } from '../../packages/core/shop-links';
import { closingPreview } from '../../packages/core/today';
import { inboxPng } from '../inbox-fixture';
import {createCloudInboxImageUploader} from '../../apps/web/src/data/cloud-inbox-upload';
import {deliverLocalInboxImages} from '../../apps/web/src/data/local-outbox';
interface Config {
  apiUrl: string;
  publishableKey: string;
  userId: string;
  jwt: string;
  businessId: string;
  outletId: string;
  actorId: string;
  stockId: string;
  localBackup?: MiseBackup;
  original?: {
    backup: MiseBackup;
    manifest: CloudUploadManifest;
    chunks: string[];
    receipt: CloudUploadReceipt;
  };
}
interface Wire {
  id: 'wire';
  config: Config;
  scope: string;
  target: Awaited<ReturnType<typeof target>>;
  authKey: string;
  joinId: string;
  pendingRead: string | null;
}
class Receiver extends Dexie {
  wire!: Dexie.Table<Wire, string>;
  constructor(name: string) {
    super(name);
    this.version(1).stores({ wire: 'id' });
  }
}
const connection = (config: Config) => ({
  apiUrl: config.apiUrl,
  publishableKey: config.publishableKey,
});
async function target(
  config: Config,
  scope: string,
  role: 'owner' | 'manager',
) {
  return {
    businessId: config.businessId,
    outletId: config.outletId,
    actorId: config.actorId,
    accountHash: await operatorAccountHash(config.userId),
    targetHash: await cloudConnectionTarget(
      connection(config),
      scope,
      config.userId,
    ),
    role,
  };
}
async function use<T>(
  run: (db: MiseDatabase, receiver: Receiver) => Promise<T>,
) {
  const base = location.pathname.replace(/\/app\/.*$/, '/app/'),
    db = new MiseDatabase('mise-local:' + base),
    receiver = new Receiver('mise-native-sync:' + base);
  try {
    return await run(db, receiver);
  } finally {
    db.close();
    receiver.close();
  }
}
function clients(w: Wire) {
  const auth = async () => ({ jwt: w.config.jwt, userId: w.config.userId }),
    c = connection(w.config);
  return {
    operator: createOperatorRemote(c, auth),
    read: createCloudSyncRemote(c, async () => w.config.jwt),
    images: createCloudImageRemote(c, w.scope, auth),
    coverage: createCloudCoverageRemote(c, w.scope, auth),
    uploadCoverage: createCloudUploadCoverageRemote(c, w.scope, auth),
  };
}
const phoneClients = new Map<string, Promise<PhoneAuth>>();
async function commandClient(w: Wire) {
  let promise = phoneClients.get(w.authKey);
  if (!promise) {
    promise = createPhoneAuth(connection(w.config), w.scope, {
      storage: localStorage,
    });
    phoneClients.set(w.authKey, promise);
  }
  const auth = await promise;
  await auth.check();
  return {
    auth,
    remote: createShopCommandRemote(w.config.apiUrl, w.config.publishableKey, {
      scope: w.scope,
      accountHash: w.target.accountHash,
      targetHash: w.target.targetHash,
      getAuth: () => auth.commandAuthorization(),
      assertCurrent: (value) => auth.assertCommandAuthorization(value),
    }),
  };
}
function session(config: Config) {
  return {
    access_token: config.jwt,
    refresh_token: 'synthetic-native-refresh',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    expires_in: 3600,
    token_type: 'bearer',
    user: {
      id: config.userId,
      aud: 'authenticated',
      role: 'authenticated',
      phone: config.userId.endsWith('1') ? '14155550101' : '14155550102',
      phone_confirmed_at: '2026-11-01T00:00:00Z',
      created_at: '2026-11-01T00:00:00Z',
      is_anonymous: false,
      app_metadata: { provider: 'phone' },
      user_metadata: { role: 'owner' },
    },
  };
}
function switchSession(w: Wire, config: Config) {
  const oldValue = localStorage.getItem(w.authKey),
    newValue = JSON.stringify(session(config));
  localStorage.setItem(w.authKey, newValue);
  window.dispatchEvent(
    new StorageEvent('storage', {
      key: w.authKey,
      oldValue,
      newValue,
      storageArea: localStorage,
    }),
  );
}
async function deliverCommands(
  db: MiseDatabase,
  w: Wire,
  switchOnReceipt?: Config,
) {
  const c = await commandClient(w),
    unwatch = watchOperatorAuth(db, localStorage, () => {});
  let switched = false;
  const reading = (row: unknown) => {
    if (
      switchOnReceipt &&
      !switched &&
      Dexie.currentTransaction?.mode === 'readwrite'
    ) {
      switched = true;
      switchSession(w, switchOnReceipt);
    }
    return row;
  };
  if (switchOnReceipt) db.outbox.hook('reading', reading);
  try {
    const result=await deliverLocalOutbox(db, w.target.targetHash, (command,currency) =>
      c.remote.apply(command,currency),
    );
    await deliverLocalInboxImages(db,w.target.targetHash,createCloudInboxImageUploader(connection(w.config),{scope:w.scope,accountHash:w.target.accountHash,targetHash:w.target.targetHash,getAuth:()=>c.auth.commandAuthorization(),assertCurrent:value=>c.auth.assertCommandAuthorization(value)}));
    return result;
  } finally {
    unwatch();
    if (switchOnReceipt) db.outbox.hook('reading').unsubscribe(reading);
  }
}
async function wire(receiver: Receiver) {
  const w = await receiver.wire.get('wire');
  if (!w) throw Error('Initialize native sync first');
  return w;
}
function ownerJournal(w: Wire) {
  return new CloudUploadJournal(
    'mise-cloud-uploads:' + w.scope.slice(0, -w.config.businessId.length),
  );
}
async function ownerPlan(w: Wire) {
  if (!w.config.original) throw Error('No original owner upload');
  const journal = ownerJournal(w);
  try {
    const row = await journal.readSnapshot(w.config.original.manifest.id);
    return { manifest: row.manifest, chunks: row.chunks };
  } finally {
    journal.close();
  }
}
async function preparePull(db: MiseDatabase, receiver: Receiver) {
  const w = await wire(receiver),
    c = clients(w);
  if (!w.pendingRead) {
    const base = await db.syncCanonical.get('active');
    w.pendingRead = base ? newInboxId() : w.joinId;
    await prepareSyncDownload(db, {
      id: w.pendingRead,
      target: w.target,
      previousCursor: base?.snapshot.cursor ?? null,
    });
    await receiver.wire.put(w);
  }
  await runSyncDownload(db, w.pendingRead, w.target, c.read);
  await downloadSyncImages(db, w.pendingRead, w.target, c.images);
  return { w, c };
}
async function finishPull(
  db: MiseDatabase,
  receiver: Receiver,
  prepared: Awaited<ReturnType<typeof preparePull>>,
  lostReply = false,
) {
  const { w, c } = prepared,
    selected = (await db.operatorState.get('active'))!,
    input = {
      readId: w.pendingRead!,
      target: w.target,
      authKey: w.authKey,
      expectedOperatorRevision: selected.revision,
    },
    base = await db.syncCanonical.get('active'),
    admission = await db.syncAdmissions.get('owner-upload');
  const result =
    w.config.original && (!base || admission?.source.readId === w.pendingRead)
      ? await adoptOwnerUpload(
          db,
          input,
          await ownerPlan(w),
          c.uploadCoverage,
          c.coverage,
          (context) => c.operator.select(context),
        )
      : await applyCanonicalDownload(db, input, c.coverage, (context) =>
          c.operator.select(context),
        );
  if (lostReply) throw Error('The local adoption reply was lost.');
  await receiver.wire.put({ ...w, pendingRead: null });
  return result;
}
async function cycleOnce(
  db: MiseDatabase,
  w: Wire,
  loseFinish = false,
  switchOnFinish?: Config,
) {
  const { auth } = await commandClient(w),
    operator = (await db.operatorState.get('active'))!;
  if (!operator.connection) throw Error('Select actual cloud operator');
  await ensureSyncSession(
    db,
    {
      target: w.target,
      authKey: w.authKey,
      operatorRevision: operator.revision,
      epoch: operator.connection.epoch,
      scopeVersion: operator.connection.scopeVersion,
    },
    newInboxId(),
  );
  await requestSync(db, true);
  const journal = ownerJournal(w),
    unwatch = watchOperatorAuth(db, localStorage, () => {});
  let failed = false;
  const finish = (changes: object) => {
    if (
      (loseFinish || switchOnFinish) &&
      !failed &&
      'lastConfirmedAt' in changes &&
      changes.lastConfirmedAt != null
    ) {
      failed = true;
      if (switchOnFinish) {
        switchSession(w, switchOnFinish);
        return;
      }
      throw new DOMException(
        'Local completion write failed',
        'QuotaExceededError',
      );
    }
  };
  if (loseFinish || switchOnFinish) db.syncSessions.hook('updating', finish);
  try {
    return await runSyncCycle(db, {
      config: connection(w.config),
      scope: w.scope,
      auth,
      journal,
      random: () => 0,
    });
  } finally {
    unwatch();
    if (loseFinish || switchOnFinish)
      db.syncSessions.hook('updating').unsubscribe(finish);
    journal.close();
  }
}
let ownerFaultTriggered=false;
const api = {
  armOwnerSelectionSwitch: (config:Config) => use(async(_db,receiver)=>{
    const w=await wire(receiver),put=IDBObjectStore.prototype.put;ownerFaultTriggered=false;
    IDBObjectStore.prototype.put=function(value:unknown,key?:IDBValidKey){
      if(this.name==='operatorState'&&value&&typeof value==='object'&&'phase'in value&&value.phase==='active'){
        IDBObjectStore.prototype.put=put;ownerFaultTriggered=true;switchSession(w,config);
      }
      return key===undefined?put.call(this,value):put.call(this,value,key);
    };
  }),
  armOwnerReadyLoss: () => {
    const put=IDBObjectStore.prototype.put;ownerFaultTriggered=false;
    IDBObjectStore.prototype.put=function(value:unknown,key?:IDBValidKey){
      if(this.name==='scopeRecoveries'&&value&&typeof value==='object'&&'id'in value&&value.id==='owner:active'&&'phase'in value&&value.phase==='ready'){
        IDBObjectStore.prototype.put=put;ownerFaultTriggered=true;throw new DOMException('Lost completion','QuotaExceededError');
      }
      return key===undefined?put.call(this,value):put.call(this,value,key);
    };
  },
  ownerFaultTriggered:()=>ownerFaultTriggered,
  armInboxClaimLoss:(itemId:string)=>{
    ownerFaultTriggered=false;const add=IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add=function(value,key){
      if(this.name==='events'&&value?.inboxId===itemId&&value?.command==='inbox.capture'){
        IDBObjectStore.prototype.add=add;ownerFaultTriggered=true;throw new DOMException('Claim audit full','QuotaExceededError');
      }
      return key===undefined?add.call(this,value):add.call(this,value,key);
    };
  },
  initializeLocal: (config: Config) =>
    use(async (db, receiver) => {
      if (!config.localBackup) throw Error('No original local shop');
      const scope =
          location.pathname.replace(/\/app\/.*$/, '/app/') + config.businessId,
        authKey = await cloudAuthStorageKey(connection(config), scope),
        t = await target(config, scope, 'owner');
      await db.transaction('rw', db.tables, async () => {
        if ((await db.businesses.count()) || (await db.cloudState.count()))
          throw Error('Keep existing shop');
        for (const table of backupTableNames)
          await db
            .table(table)
            .bulkPut(
              table === 'inboxItems'
                ? storedInboxItems(config.localBackup!.tables.inboxItems)
                : config.localBackup!.tables[table],
            );
      });
      localStorage.setItem(authKey, JSON.stringify(session(config)));
      saveCloudConnection(localStorage, connection(config));
      await receiver.wire.put({
        id: 'wire',
        config,
        scope,
        target: t,
        authKey,
        joinId: newInboxId(),
        pendingRead: null,
      });
    }),
  review: () =>
    use(async (db, receiver) => {
      const journal = ownerJournal(await wire(receiver));
      try {
        return await journal.review(db);
      } finally {
        journal.close();
      }
    }),
  initialize: (config: Config) =>
    use(async (db, receiver) => {
      const scope =
          location.pathname.replace(/\/app\/.*$/, '/app/') + config.businessId,
        operator = createOperatorRemote(connection(config), async () => ({
          jwt: config.jwt,
          userId: config.userId,
        })),
        page = await operator.list(),
        context = page.contexts.find(
          (c) =>
            c.businessId === config.businessId &&
            c.outletId === config.outletId &&
            c.actorId === config.actorId,
        );
      if (!context) throw Error('No actual permitted outlet');
      const t = await target(config, scope, context.role),
        authKey = await cloudAuthStorageKey(connection(config), scope);
      localStorage.setItem(authKey, JSON.stringify(session(config)));
      saveCloudConnection(localStorage, connection(config));
      const w: Wire = {
        id: 'wire',
        config,
        scope,
        target: t,
        authKey,
        joinId: newInboxId(),
        pendingRead: null,
      };
      if (config.original) {
        await db.transaction('rw', db.tables, async () => {
          if (
            (await db.businesses.count()) ||
            (await db.cloudState.count()) ||
            (await db.outbox.count())
          )
            throw Error('Keep existing local work');
          for (const table of backupTableNames)
            await db
              .table(table)
              .bulkPut(
                table === 'inboxItems'
                  ? storedInboxItems(config.original!.backup.tables.inboxItems)
                  : config.original!.backup.tables[table],
              );
        });
        const journal = ownerJournal(w);
        try {
          const plan = {
              manifest: config.original.manifest,
              chunks: config.original.chunks.map(
                (value) =>
                  new Blob(
                    [Uint8Array.from(atob(value), (c) => c.charCodeAt(0))],
                    { type: 'application/gzip' },
                  ),
              ),
            },
            stored = await journal.addSnapshot(plan);
          await beginLocalUpload(db, plan, t.targetHash);
          await journal.acknowledge(stored.id, {
            id: stored.id,
            manifestHash: stored.manifestHash,
            received: stored.manifest.chunks.map((p) => p.index),
            receipt: config.original.receipt,
          });
          await acceptLocalUpload(
            db,
            plan,
            t.targetHash,
            config.original.receipt,
          );
        } finally {
          journal.close();
        }
      }
      const selected = await selectCloudOperator(
        db,
        context,
        { authKey, targetHash: t.targetHash },
        null,
        (c) => operator.select(c),
      );
      await receiver.wire.put(w);
      if (config.original)
        return {
          originalUploadId: config.original.manifest.id,
          operatorRevision: selected.revision,
        };
      const c = clients(w);
      await prepareSyncDownload(db, {
        id: w.joinId,
        target: t,
        previousCursor: null,
      });
      await runSyncDownload(db, w.joinId, t, c.read);
      await downloadSyncImages(db, w.joinId, t, c.images);
      return joinCanonicalDevice(
        db,
        {
          readId: w.joinId,
          target: t,
          authKey,
          expectedOperatorRevision: selected.revision,
        },
        (context) => operator.select(context),
      );
    }),
  cycle: () => use(async (db, receiver) => cycleOnce(db, await wire(receiver))),
  cycleWithLostFinish: () =>
    use(async (db, receiver) => cycleOnce(db, await wire(receiver), true)),
  cycleWithFinishSwitch: (config: Config) =>
    use(async (db, receiver) =>
      cycleOnce(db, await wire(receiver), false, config),
    ),
  cycleInspect: () =>
    use(async (db) => ({
      state: await db.syncSessions.get('active'),
      reads: await db.syncReads.toArray(),
    })),
  leaveExpiredPausedLease: () =>
    use(async (db) => {
      const state = await db.syncSessions.get('active');
      if (!state?.paused)
        throw Error('Pause before simulating an interrupted runner');
      await db.syncSessions.put({
        ...state,
        lease: { id: newInboxId(), until: Date.now() - 1 },
      });
    }),
  customer: (name: string) =>
    use((db) =>
      db.saveCustomer({
        name,
        nickname: '',
        phone: '',
        address: '',
        notes: '',
        tags: [],
      }),
    ),
  captureImage: () => use(db=>db.captureInbox({title:'Original offline capture',text:'Literal\0\ud800',files:[new File([new Uint8Array(inboxPng)],'তালিকা.png',{type:'image/png'})]})),
  imageHashes:()=>use(async db=>Promise.all((await db.inboxItems.toArray()).flatMap(item=>item.images.map(async image=>({id:image.id,bytes:image.blob.size,sha256:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await image.blob.arrayBuffer())),byte=>byte.toString(16).padStart(2,'0')).join('')}))))),
  deliver: () =>
    use(async (db, receiver) => deliverCommands(db, await wire(receiver))),
  deliverWithReceiptSwitch: (config: Config) =>
    use(async (db, receiver) =>
      deliverCommands(db, await wire(receiver), config),
    ),
  switchAccount: (config: Config) =>
    use(async (_db, receiver) => {
      const w = await wire(receiver);
      switchSession(w, config);
      const current = phoneClients.get(w.authKey);
      if (current) await (await current).check();
    }),
  reselect: () =>
    use(async (db, receiver) => {
      const w = await wire(receiver),
        { auth } = await commandClient(w),
        remote = createOperatorRemote(connection(w.config), () =>
          auth.commandAuthorization(),
        ),
        page = await remote.list(),
        context = page.contexts.find(
          (c) =>
            c.businessId === w.target.businessId &&
            c.outletId === w.target.outletId &&
            c.actorId === w.target.actorId,
        );
      if (!context) throw Error('No actual original operator');
      const selected = await db.operatorState.get('active');
      return selectCloudOperator(
        db,
        context,
        { authKey: w.authKey, targetHash: w.target.targetHash },
        selected?.revision ?? null,
        (c) => remote.select(c),
      );
    }),
  lock: () =>
    use(async (db) => {
      const selected = (await db.operatorState.get('active'))!;
      return lockLocalOperator(db, selected.revision);
    }),
  pull: () =>
    use(async (db, receiver) =>
      finishPull(db, receiver, await preparePull(db, receiver)),
    ),
  freezePull: () => use(async (db, receiver) => {
    const {w}=await preparePull(db,receiver);return w.pendingRead;
  }),
  seedConcurrentSupplier: () => use(db=>db.saveSupplier({name:'Shared original supplier',phone:'',note:'Original supplier note'})),
  concurrentOrder: (action:'price'|'payment') => use(async db=>{
    const order=(await db.orders.toArray())[0];
    if(action==='payment')return db.settleOrder(order.id,{method:'cash'},order.revision);
    return db.saveOrder({source:order.source,sourceText:order.sourceText,customerId:order.customer.id,name:order.customer.name,phone:order.customer.phone??'',type:order.type,address:order.address,table:order.table,scheduledFor:order.scheduledFor,lines:order.lines.map(line=>({...line,unitPrice:(line.unitPrice??0)+100})),deliveryFee:order.deliveryFee,discount:order.discount,payment:{method:order.payment.method,wallet:order.payment.wallet}},{id:order.id,revision:order.revision});
  }),
  queueNewOrder:()=>use(db=>db.saveOrder({source:'phone',sourceText:'Original BDT order · বাংলা',name:'Rina',phone:'01712345483',type:'pickup',address:'',table:'',lines:[{name:'Tea',unit:'cup',qty:2,unitPrice:1250}],deliveryFee:0,discount:0,payment:{method:'cash'}})),
  queuePurchase:()=>use(db=>db.recordPurchase({supplierName:'Original supplier',reference:'Original BDT invoice · বাংলা',lines:[{name:'Rice',unit:'kg',qty:2.5,unitPrice:12001}],paid:'due',note:'Keep invoice\0\ud800'})),
  stockEdit:(supplierName:string,quantity:number)=>use(async(db,receiver)=>{const w=await wire(receiver),item=(await db.stockItems.get(w.config.stockId))!,supplier=await db.saveSupplier({name:supplierName,phone:'',note:''});return db.saveStockItem({...item,supplierId:supplier.id,onHand:quantity},{id:item.id,revision:item.revision});}),
  renameStockSupplier:(name:string)=>use(async(db,receiver)=>{const w=await wire(receiver),item=(await db.stockItems.get(w.config.stockId))!,supplier=item.supplierId?await db.suppliers.get(item.supplierId):null;if(!supplier)throw Error('Choose the original stock supplier');return db.saveSupplier({name,phone:supplier.phone??'',note:supplier.note??''},{id:supplier.id,revision:supplier.revision});}),
  queueCustomerOpening:()=>use(async db=>{
    const customer=await db.saveCustomer({name:'Original customer',nickname:'',phone:'',address:'',notes:'Original opening · বাংলা\0\ud800',tags:[]},{credit:{allowed:true,limit:50000,reminder:{enabled:false,dayOfMonth:1,tone:'gentle',channel:'whatsapp'}},opening:{amount:12345,occurredAt:1}}),account=(await db.creditAccounts.toArray()).find(a=>a.customerId===customer.id)!,entry=(await db.creditEntries.toArray()).find(e=>e.accountId===account.id)!;
    return {customerId:customer.id,accountId:account.id,entryId:entry.id};
  }),
  setOriginalKhataLimit:(accountId:string,limit:number)=>use(async db=>{const account=await db.creditAccounts.get(accountId);if(!account)throw Error('Choose the original account');return db.saveCreditTerms(account.customerId,{allowed:account.allowed,limit,reminder:account.reminder},account.id);}),
  editOriginalCustomer:(customerId:string,name:string,limit:number|null)=>use(async db=>{const customer=await db.customers.get(customerId),account=(await db.creditAccounts.toArray()).find(a=>a.customerId===customerId);if(!customer||!account)throw Error('Choose the original customer and khata');return db.saveCustomer({name,nickname:customer.nickname,phone:customer.phone??'',address:customer.address,notes:customer.notes,tags:customer.tags},{id:customerId,...(limit===null?{}:{credit:{allowed:account.allowed,limit,reminder:account.reminder}})});}),
  undoOriginalPurchase:(id:string)=>use(db=>db.undoPurchase(id)),
  setCurrency:(currency:string)=>use(async db=>{const setup=await db.setup();if(!setup)throw Error('Choose the original shop');return db.saveSetup({businessType:setup.business.businessType,marketCode:setup.business.marketCode,name:setup.business.name,phone:setup.owner.phone??'',outletName:setup.outlet.name,address:setup.outlet.address,language:setup.business.languages.length===2?'both':setup.business.languages[0],timezone:setup.outlet.timezone,currency});}),
  setTimezone:(timezone:string)=>use(async db=>{const setup=await db.setup();if(!setup)throw Error('Choose the original shop');return db.saveSetup({businessType:setup.business.businessType,marketCode:setup.business.marketCode,name:setup.business.name,phone:setup.owner.phone??'',outletName:setup.outlet.name,address:setup.outlet.address,language:setup.business.languages.length===2?'both':setup.business.languages[0],timezone,currency:setup.outlet.currency});}),
  actionReviews: () => use(async db=>(await readLocalActionReviews(db)).map(({review,command,entry})=>({review,command,entryId:entry.id,changes:entry.changes,receipts:entry.receipts}))),
  prepareFinancialReview:()=>use(async(db,receiver)=>{
    const w=await wire(receiver),client=await commandClient(w),row=(await db.outbox.where('status').equals('pending').sortBy('sequence'))[0],command=row?.commands[row.receipts.length];if(!row||!command||!isOrderCommand(command))throw Error('Expected the first retained original order action.');
    const packet=await prepareOrderReviewSource(row,row.receipts.length,newInboxId(),newInboxId());
    const remote=createCloudOrderReviewRemote(connection(w.config),{scope:w.scope,accountHash:w.target.accountHash,targetHash:w.target.targetHash,getAuth:()=>client.auth.commandAuthorization(),assertCurrent:value=>client.auth.assertCommandAuthorization(value)},w.target),result=await remote.prepare(packet);
    if(result.done)throw Error('Expected an explicit current-value review.');return {packet,review:result.review};
  }),
  resolveFinancialReview:(decision:OrderReviewDecision)=>use(async(_db,receiver)=>{
    const w=await wire(receiver),client=await commandClient(w);return createCloudOrderReviewRemote(connection(w.config),{scope:w.scope,accountHash:w.target.accountHash,targetHash:w.target.targetHash,getAuth:()=>client.auth.commandAuthorization(),assertCurrent:value=>client.auth.assertCommandAuthorization(value)},w.target).resolve(decision);
  }),
  editConcurrentSources: (label:'Owner'|'Manager') => use(async db=>{
    const order=(await db.orders.toArray())[0],supplier=(await db.suppliers.toArray())[0],inbox=(await db.inboxItems.toArray())[0];
    await db.addOrderNote(order.id,label+' original note · বাংলা',order.revision);
    await db.saveSupplier({name:label+' supplier',phone:'',note:label+' literal note'},{id:supplier.id,revision:supplier.revision});
    await db.changeInbox(inbox.id,inbox.revision,label==='Owner'?{kind:'order'}:{archived:true});
    let handoffId:string|null=null;
    if(label==='Manager'){
      const current=(await db.orders.get(order.id))!,message=await db.prepareHandoff({source:{kind:'order',id:order.id},purpose:'quote',target:'copy',text:'Original manager quote · বাংলা',part:1,parts:1});
      await db.changeHandoff(message.id,1,{type:'sent'},undefined,{kind:'order',revision:current.revision});handoffId=message.id;
    }
    return {orderId:order.id,supplierId:supplier.id,inboxId:inbox.id,handoffId};
  }),
  editPendingFamilies: (label:string) => use(async db=>{
    const setup=(await db.setup())!;
    const item=await db.saveItem({name:label,nameLocal:'বাংলা',price:3700,unit:'pc',category:label,available:true,oftenBought:false});
    await db.setItemAvailable(item.id,false);
    const customer=await db.saveCustomer({name:label,nickname:'',phone:'',address:'',notes:'Literal\0\ud800',tags:[]},{credit:{...defaultCreditTerms,allowed:true,limit:100000}});
    const account=(await db.creditAccounts.where('customerId').equals(customer.id).toArray())[0];
    const supplier=await db.saveSupplier({name:label,phone:'',note:'Original supplier note'});
    const purchase=await db.recordPurchase({supplierId:supplier.id,supplierName:label,reference:label,lines:[{name:'Chicken',unit:'kg',qty:1.5,unitPrice:12001}],paid:'due',note:'Keep invoice'});
    const order=await db.saveOrder({source:'phone',sourceText:'Literal\0\ud800',customerId:customer.id,name:label,phone:'',type:'pickup',address:'',table:'',lines:[{name:'Tea',unit:'cup',qty:2,unitPrice:750}],deliveryFee:0,discount:0,payment:{method:'credit'}},{settlement:{method:'credit',accountId:account.id}});
    await db.addOrderNote(order.id,'Keep the original note',order.revision);
    await db.saveCreditMessaging({...defaultCreditMessaging,paymentNote:label});
    await db.recordPreparedExport({outletId:setup.outlet.id,actorId:setup.owner.id,format:'json',datasets:[],rows:3,filename:'mise-backup.json',capturedAt:Date.now(),from:null,to:null,includePhones:true});
    const message=await db.prepareHandoff({source:{kind:'credit',id:account.id},purpose:'reminder',target:'copy',text:'Please pay at the counter.',part:1,parts:1});
    await db.changeHandoff(message.id,1,{type:'sent'},undefined,{kind:'credit'});
    const inbox=await db.captureInbox({title:label,text:'Literal\0\ud800',url:'',files:[new File([new Uint8Array(inboxPng)],'তালিকা.png',{type:'image/png'})]});
    await db.changeInbox(inbox.id,inbox.revision,{kind:'order'});
    const confirmation=newInboxId();await db.recordSupplierMessage({id:confirmation,supplierId:supplier.id,supplierName:label,text:'Original supplier confirmation\0\ud800',channel:'manual',stockItemIds:[(await db.stockItems.toArray())[0].id],part:1,parts:1});
    if(setup.owner.role==='owner'){
      await db.saveSetup({name:label,phone:setup.owner.phone??'01712345482',businessType:setup.business.businessType,marketCode:setup.business.marketCode,outletName:label,address:'Road 13'});
      const current=(await db.setup())!,items=await db.items.toArray(),review=reviewShopLink({setup:current,items,categories:await db.categories.toArray()},items.map(item=>item.id));
      await db.generateShopLink({phone:current.owner.phone!,hours:'9–5',deliveryNote:'',mode:'menu',itemIds:items.map(item=>item.id)},review,'https://shop.test/app/');
    }
    const preview=closingPreview(await db.readToday()),closing=await db.closeDay({id:newInboxId(),day:preview.summary.day,fingerprint:preview.fingerprint,countedCash:preview.summary.expectedCash,note:'',addDifference:false});
    return {itemId:item.id,customerId:customer.id,accountId:account.id,supplierId:supplier.id,purchaseId:purchase.id,orderId:order.id,handoffId:message.id,inboxId:inbox.id,confirmationId:confirmation,closingId:closing.id};
  }),
  adoptWithoutReply: () =>
    use(async (db, receiver) =>
      finishPull(db, receiver, await preparePull(db, receiver), true),
    ),
  stock: (reason: 'used' | 'received' | 'count', quantity: number) =>
    use(async (db, receiver) => {
      const w = await wire(receiver),
        item = (await db.stockItems.get(w.config.stockId))!;
      return db.adjustStock({
        id: item.id,
        revision: item.revision,
        reason,
        quantity,
      });
    }),
  cash: (expression: string) =>
    use((db) => db.recordSale({ expression, method: 'cash' })),
  credit: (expression: string) => use(async db=>{
    const account=(await db.creditAccounts.toArray())[0];
    if(!account)throw Error('Use the original customer khata');
    return db.recordCreditSale({expression,accountId:account.id,customerId:account.customerId});
  }),
  payOriginalKhata: (amount: number) => use(async db=>{
    const account=(await db.creditAccounts.toArray())[0];
    if(!account)throw Error('Use the original account');
    return db.recordCreditPayment(account.id,amount,'cash',undefined,'Original BDT payment · বাংলা');
  }),
  undoOriginalKhataPayment: (id:string) => use(db=>db.undoCreditEntry(id)),
  inspect: () =>
    use(async (db) => ({
      backup: await db.readBackup(),
      queue: await db.outbox.toArray(),
      binding: await db.cloudState.get('binding'),
      base: await db.syncCanonical.get('active'),
      applications: await db.syncApplications.toArray(),
      admissions: await db.syncAdmissions.toArray(),
      operator: await db.operatorState.get('active'),
      recoveries: await db.scopeRecoveries.toArray(),
      actionReviews: await db.syncActionReviews.toArray(),
      orderReviews: await db.orderReviews.toArray(),
      moneyReviews: await db.moneyReviews.toArray(),
      purchaseReviews: await db.purchaseReviews.toArray(),
      stockReviews: await db.stockReviews.toArray(),
      syncSession: await db.syncSessions.get('active'),
      imageSizes: await Promise.all(
        (await db.inboxItems.toArray()).flatMap((item) =>
          item.images.map(
            async (image) => (await image.blob.arrayBuffer()).byteLength,
          ),
        ),
      ),
    })),
  quota: () =>
    use(async (db, receiver) => {
      const prepared = await preparePull(db, receiver),
        table =
          prepared.w.config.original && !(await db.syncAdmissions.count())
            ? db.syncAdmissions
            : db.syncApplications,
        fail = () => {
          throw new DOMException('Storage full', 'QuotaExceededError');
        };
      table.hook('creating', fail);
      try {
        await finishPull(db, receiver, prepared);
        return { rejected: false };
      } catch {
        return {
          rejected: true,
          applications: await db.syncApplications.count(),
          queue: await db.outbox.count(),
          base: await db.syncCanonical.get('active'),
        };
      } finally {
        table.hook('creating').unsubscribe(fail);
      }
    }),
};
declare global {
  interface Window {
    miseSyncApplyTest: typeof api;
  }
}
window.miseSyncApplyTest = api;
