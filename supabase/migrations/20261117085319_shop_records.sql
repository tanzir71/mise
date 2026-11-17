-- M30 shop records. Browser writes remain closed until audited commands exist.
create domain public.minor_units as bigint
  check (value between -9007199254740991 and 9007199254740991);
create domain public.ordinal as bigint check (value between 1 and 9007199254740991);
create domain public.stock_quantity as numeric
  check (value between -1000000000 and 1000000000 and value * 1000 = trunc(value * 1000));

-- JSON preserves escaped source characters (including NUL/surrogates) that jsonb
-- and PostgreSQL text cannot represent. Never extract or execute source instructions.
create domain public.literal_text as json check (json_typeof(value) = 'string');
create domain public.record_array as json check (json_typeof(value) = 'array');

-- Existing identity names/addresses use the same literal representation. Drop the
-- old text-length checks; command validation keeps their UTF-16 limits before writes.
alter table public.businesses drop constraint businesses_name_check,
  drop constraint businesses_languages_check, alter column languages drop default,
  alter column name type public.literal_text using to_json(name),
  alter column languages type public.record_array using array_to_json(languages),
  alter column languages set default '["en"]'::json;
alter table public.outlets drop constraint outlets_name_check, drop constraint outlets_address_check,
  alter column address drop default,
  alter column name type public.literal_text using to_json(name),
  alter column address type public.literal_text using to_json(address),
  alter column address set default '""'::json;
alter table public.members drop constraint members_name_check, drop constraint members_name_local_check,
  alter column name_local drop default,
  alter column name type public.literal_text using to_json(name),
  alter column name_local type public.literal_text using to_json(name_local),
  alter column name_local set default '""'::json;

alter table public.outlets add column shop_link text,
  add column credit_messaging json,
  add column order_warning_minutes integer check (order_warning_minutes between 1 and 1440);

create table public.customers (
  id public.ulid primary key,
  business_id public.ulid not null references public.businesses(id),
  name public.literal_text not null, nickname public.literal_text not null default '""',
  phone text check (phone ~ '^\+[1-9][0-9]{6,14}$'),
  address public.literal_text not null default '""', notes public.literal_text not null default '""',
  tags public.record_array not null default '[]', consent json not null,
  archived_at public.utc_ms,
  created_at public.utc_ms not null, updated_at public.utc_ms not null check (updated_at >= created_at),
  unique (business_id, id), unique (business_id, phone)
);
-- Contacts are business-level identities, explicitly shared with an outlet. This
-- retains contacts without transactions while preventing another outlet's PII leak.
create table public.customer_outlets (
  business_id public.ulid not null, outlet_id public.ulid not null, customer_id public.ulid not null,
  primary key (business_id, outlet_id, customer_id),
  foreign key (business_id, outlet_id) references public.outlets(business_id,id),
  foreign key (business_id, customer_id) references public.customers(business_id,id)
);
create index customer_outlets_customer_idx on public.customer_outlets(business_id, customer_id, outlet_id);

create table public.categories (
  id public.ulid primary key, business_id public.ulid not null, outlet_id public.ulid not null,
  name public.literal_text not null, sort bigint not null check (sort >= 0)
);
create table public.items (
  id public.ulid primary key, business_id public.ulid not null, outlet_id public.ulid not null,
  name public.literal_text not null, name_local public.literal_text not null default '""',
  category_id public.ulid, price public.minor_units not null check (price >= 0),
  unit public.literal_text not null, available boolean not null, is_sample boolean not null default false,
  often_bought boolean, variants public.record_array not null default '[]', photo_ref text
);
create table public.credit_accounts (
  id public.ulid primary key, business_id public.ulid not null, outlet_id public.ulid not null,
  customer_id public.ulid not null, currency text not null check (currency ~ '^[A-Z]{3}$'),
  allowed boolean not null, credit_limit public.minor_units not null check (credit_limit >= 0),
  reminder json not null, notes public.literal_text not null default '""',
  unique (business_id,outlet_id,customer_id,currency),
  unique (business_id,outlet_id,id,customer_id,currency)
);
create table public.orders (
  id public.ulid primary key, business_id public.ulid not null, outlet_id public.ulid not null,
  business_type text not null check (business_type in ('restaurant','online_shop','food_stall','corner_shop')),
  sequence public.ordinal not null, number text not null check (length(number) between 1 and 64), revision public.ordinal not null,
  source text not null check (source in ('counter','phone','walk_in','table','link','paste','whatsapp','messenger','foodpanda','pathao','other')),
  source_text public.literal_text not null default '""',
  customer_id public.ulid, customer_name public.literal_text not null, customer_phone text check (customer_phone ~ '^\+[1-9][0-9]{6,14}$'),
  type text not null check (type in ('delivery','pickup','dine_in','counter')),
  status text not null check (status in ('new','confirmed','kitchen_seen','cooking','ready','out','delivered','to_confirm','packed','booked','with_courier','returning','returned','ordered','making','ready_called','collected','requested','priced','accepted','packing','delivering','done','cancelled')),
  status_changed_at public.utc_ms not null, status_event_id public.ulid not null,
  lines public.record_array not null, fees public.record_array not null default '[]',
  subtotal public.minor_units not null check (subtotal >= 0), delivery_fee public.minor_units not null check (delivery_fee >= 0),
  discount public.minor_units not null check (discount >= 0), total public.minor_units check (total >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'), timezone text not null,
  address public.literal_text not null default '""', table_label public.literal_text not null default '""', scheduled_for public.utc_ms,
  payment json not null check (json_typeof(payment)='object'),
  handled_by public.ulid not null, created_by public.ulid not null, event_id public.ulid not null,
  unique (business_id,outlet_id,sequence), unique (business_id,outlet_id,number)
);
create table public.sales (
  id public.ulid primary key, business_id public.ulid not null, outlet_id public.ulid not null,
  order_id public.ulid, order_number text, closing_id public.ulid,
  delivery_fee public.minor_units check (delivery_fee >= 0), discount public.minor_units check (discount >= 0),
  expression text not null, amount public.minor_units not null check (amount > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  method text not null check (method in ('cash','wallet','card','credit')), method_name public.literal_text not null,
  given public.minor_units check (given >= 0), change public.minor_units check (change >= 0),
  who public.literal_text not null, customer_id public.ulid, credit_account_id public.ulid,
  items public.record_array not null, shop_name public.literal_text not null, shop_link text, timezone text not null,
  created_by public.ulid not null, event_id public.ulid not null, voided_at public.utc_ms,
  void_reason text check (void_reason in ('undo','order-cancel')),
  check ((voided_at is null) = (void_reason is null)),
  check (method <> 'credit' or (customer_id is not null and credit_account_id is not null)),
  check (given is null or given >= amount), check (change is null or (given is not null and change = given-amount))
);
create table public.credit_entries (
  id public.ulid primary key, business_id public.ulid not null, outlet_id public.ulid not null,
  account_id public.ulid not null, customer_id public.ulid not null, currency text not null check (currency ~ '^[A-Z]{3}$'),
  sequence public.ordinal not null, type text not null check (type in ('charge','payment','adjustment','reminder','refund')),
  amount public.minor_units not null,
  note public.literal_text not null, created_by public.ulid not null, event_id public.ulid not null,
  sale_id public.ulid, order_id public.ulid, refund_id public.ulid, returns_charge_id public.ulid,
  method_name public.literal_text, occurred_at public.utc_ms, reversal_of public.ulid,
  purpose text check (purpose in ('reminder','receipt','call')), over_limit json,
  check ((type='reminder' and amount=0) or (type in ('charge','payment','refund') and amount>0) or type='adjustment'),
  unique (business_id,outlet_id,account_id,sequence), unique (business_id,outlet_id,reversal_of),
  unique (business_id,outlet_id,account_id,id)
);
create table public.order_notes (
  id public.ulid primary key, business_id public.ulid not null, outlet_id public.ulid not null,
  order_id public.ulid not null, revision public.ordinal not null, text public.literal_text not null,
  created_by public.ulid not null, event_id public.ulid not null, unique (business_id,outlet_id,order_id,revision)
);
create table public.order_communications (
  id public.ulid primary key, business_id public.ulid not null, outlet_id public.ulid not null,
  order_id public.ulid not null, revision public.ordinal not null,
  purpose text not null check (purpose in ('quote','message','call')), channel text not null check (channel in ('whatsapp','manual','call')),
  text public.literal_text not null, created_by public.ulid not null, event_id public.ulid not null,
  unique (business_id,outlet_id,order_id,revision)
);
create table public.order_refunds (
  id public.ulid primary key, business_id public.ulid not null, outlet_id public.ulid not null,
  order_id public.ulid not null, sale_id public.ulid not null, customer_id public.ulid, account_id public.ulid,
  amount public.minor_units not null check (amount > 0), currency text not null check (currency ~ '^[A-Z]{3}$'),
  method text not null check (method in ('cash','wallet','card')), method_name public.literal_text not null,
  note public.literal_text not null, created_by public.ulid not null, event_id public.ulid not null,
  credit_entry_id public.ulid, voided_at public.utc_ms
);
create table public.suppliers (
  id public.ulid primary key, business_id public.ulid not null, outlet_id public.ulid not null,
  revision public.ordinal not null, name public.literal_text not null,
  phone text check (phone ~ '^\+[1-9][0-9]{6,14}$'), note public.literal_text not null,
  archived_at public.utc_ms, event_id public.ulid not null
);
create table public.stock_items (
  id public.ulid primary key, business_id public.ulid not null, outlet_id public.ulid not null,
  revision public.ordinal not null, name public.literal_text not null, name_local public.literal_text not null,
  active_key text, unit public.literal_text not null, category public.literal_text not null, aliases public.record_array not null,
  on_hand public.stock_quantity not null check (on_hand >= 0), target public.stock_quantity not null check (target >= 0),
  pack_size public.stock_quantity not null check (pack_size > 0), low_at public.stock_quantity not null check (low_at >= 0),
  supplier_id public.ulid, archived_at public.utc_ms, last_counted_at public.utc_ms, event_id public.ulid not null,
  unique (business_id,outlet_id,active_key)
);
create table public.stock_moves (
  id public.ulid primary key, business_id public.ulid not null, outlet_id public.ulid not null,
  stock_item_id public.ulid not null, revision public.ordinal not null, name public.literal_text not null, unit public.literal_text not null,
  before_quantity public.stock_quantity not null check (before_quantity >= 0),
  after_quantity public.stock_quantity not null check (after_quantity >= 0), delta public.stock_quantity not null,
  reason text not null check (reason in ('used','received','count','waste','undo')),
  source text not null check (source in ('manual','quick_update','count')),
  note public.literal_text not null, created_by public.ulid not null, event_id public.ulid not null,
  count_batch_id public.ulid, undo_of public.ulid,
  check (after_quantity-before_quantity=delta),
  unique (business_id,outlet_id,stock_item_id,revision), unique (business_id,outlet_id,undo_of)
);
create table public.supplier_messages (
  id public.ulid primary key, business_id public.ulid not null, outlet_id public.ulid not null,
  supplier_id public.ulid, supplier_name public.literal_text not null, phone text check (phone ~ '^\+[1-9][0-9]{6,14}$'),
  text public.literal_text not null, channel text not null check (channel in ('whatsapp','manual')),
  stock_item_ids public.record_array not null, part public.ordinal not null, parts public.ordinal not null check (part <= parts),
  created_by public.ulid not null, event_id public.ulid not null, voided_at public.utc_ms
);
create table public.day_closings (
  id public.ulid primary key, business_id public.ulid not null, outlet_id public.ulid not null,
  active_key text, day date not null, timezone text not null, currency text not null check (currency ~ '^[A-Z]{3}$'),
  summary json not null check (json_typeof(summary)='object'),
  counted_cash public.minor_units not null check (counted_cash >= 0), expected_cash public.minor_units not null,
  difference public.minor_units not null, added_walk_in public.minor_units not null check (added_walk_in >= 0), added_sale_id public.ulid,
  note public.literal_text not null, preview_fingerprint text not null, created_by public.ulid not null,
  created_by_name public.literal_text not null, event_id public.ulid not null, voided_at public.utc_ms,
  check (difference=counted_cash-expected_cash), unique (business_id,outlet_id,active_key)
);
create table public.purchases (
  id public.ulid primary key, business_id public.ulid not null, outlet_id public.ulid not null,
  supplier_id public.ulid, supplier_name public.literal_text not null, reference public.literal_text not null,
  lines public.record_array not null, total public.minor_units not null check (total >= 0), currency text not null check (currency ~ '^[A-Z]{3}$'),
  timezone text not null, paid text not null check (paid in ('cash','wallet','card','due')), method_name public.literal_text not null,
  note public.literal_text not null, photo_ref text, created_by public.ulid not null, event_id public.ulid not null, voided_at public.utc_ms
);
create table public.inbox_items (
  id public.ulid primary key, business_id public.ulid not null, outlet_id public.ulid not null,
  revision public.ordinal not null, title public.literal_text not null, text public.literal_text not null, url public.literal_text not null,
  kind text not null check (kind in ('unclassified','order','payment','stock','question','other')), archived boolean not null,
  image_bytes bigint not null default 0 check (image_bytes between 0 and 10485760)
);
create table public.inbox_images (
  id public.ulid primary key, business_id public.ulid not null, outlet_id public.ulid not null, inbox_item_id public.ulid not null,
  position smallint not null check (position between 0 and 3), name public.literal_text not null,
  type text not null check (type in ('image/jpeg','image/png','image/webp')), size integer not null check (size between 1 and 5242880),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  storage_path text generated always as (business_id||'/'||outlet_id||'/'||inbox_item_id||'/'||id) stored,
  uploaded_at public.utc_ms, unique (business_id,outlet_id,inbox_item_id,position), unique (storage_path)
);
create table public.events (
  id public.ulid primary key, business_id public.ulid not null, outlet_id public.ulid not null,
  actor_type text not null check (actor_type in ('member','system','agent')), actor_id text not null,
  actor_member_id public.ulid generated always as (case when actor_type='member' then actor_id::public.ulid end) stored,
  command text not null check (length(command) between 1 and 120), before_data json not null, after_data json not null, at public.utc_ms not null,
  undo_of public.ulid, customer_id public.ulid, order_id public.ulid, order_revision public.ordinal,
  stock_item_id public.ulid, stock_revision public.ordinal, supplier_id public.ulid, closing_id public.ulid,
  handoff_id public.ulid, handoff_revision public.ordinal, handoff_topic text,
  inbox_id public.ulid, inbox_revision public.ordinal,
  unique (business_id,outlet_id,handoff_id,handoff_revision), unique (business_id,outlet_id,inbox_id,inbox_revision)
);

-- The remaining data-model entities are schema only; their later interfaces and
-- command handlers are not enabled by adding these tables.
create table public.payments (
  id public.ulid primary key, business_id public.ulid not null, outlet_id public.ulid not null,
  method text not null check (method in ('cash','wallet','card')), amount public.minor_units not null check (amount > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'), reference public.literal_text not null,
  from_phone text check (from_phone ~ '^\+[1-9][0-9]{6,14}$'), received_at public.utc_ms not null,
  order_id public.ulid, credit_entry_id public.ulid, sale_id public.ulid,
  source text not null check (source in ('manual','sms','notification')),
  check (num_nonnulls(order_id,credit_entry_id,sale_id) <= 1)
);
create table public.shifts (
  id public.ulid primary key, business_id public.ulid not null, outlet_id public.ulid not null,
  day date not null, slot public.literal_text not null, need json not null, member_ids public.record_array not null
);
create table public.check_ins (
  id public.ulid primary key, business_id public.ulid not null, outlet_id public.ulid not null,
  member_id public.ulid not null, at public.utc_ms not null,
  type text not null check (type in ('in','out','break')), method text not null check (method in ('order_phone','link','group','manual')),
  recorded_by public.ulid not null
);
create table public.captures (
  id public.ulid primary key, business_id public.ulid not null, outlet_id public.ulid not null,
  kind text not null check (kind in ('screenshot','photo','text','notification','portal')), payload_ref text not null,
  parsed json not null, confidence numeric check (confidence between 0 and 1),
  status text not null check (status in ('new','applied','ignored')), result_ref json
);
create table public.tasks (
  id public.ulid primary key, business_id public.ulid not null, outlet_id public.ulid not null,
  kind text not null check (kind in ('question','failure','chat','check')), title public.literal_text not null, body public.literal_text not null,
  actions public.record_array not null, assignee text not null, status text not null, due_at public.utc_ms
);

-- Every outlet record has the same enforced scope and read boundary. Foreign keys
-- between records below carry all scope columns, even when both outlets have one owner.
do $$
declare table_name text;
begin
  foreach table_name in array array['categories','items','credit_accounts','orders','sales','credit_entries',
    'order_notes','order_communications','order_refunds','suppliers','stock_items','stock_moves','supplier_messages',
    'day_closings','purchases','inbox_items','inbox_images','events','payments','shifts','check_ins','captures','tasks']
  loop
    execute format('alter table public.%I add unique (business_id,outlet_id,id),
      add foreign key (business_id,outlet_id) references public.outlets(business_id,id)',table_name);
    if table_name <> 'events' then
      execute format('alter table public.%I add created_at public.utc_ms not null,
        add updated_at public.utc_ms not null check (updated_at >= created_at)',table_name);
    end if;
    execute format('create index %I on public.%I (outlet_id,%I,id)',table_name||'_outlet_cursor_idx',table_name,
      case when table_name='events' then 'at' else 'updated_at' end);
    execute format('alter table public.%I enable row level security',table_name);
    execute format('alter table public.%I force row level security',table_name);
    execute format('revoke all on public.%I from public,anon,authenticated,service_role',table_name);
    execute format('grant select on public.%I to authenticated',table_name);
    execute format('create policy %I on public.%I for select to authenticated
      using (outlet_id in (select unnest(a.outlet_ids) from private.current_access() a))',table_name||'_read',table_name);
  end loop;
end $$;

alter table public.customers enable row level security;
alter table public.customers force row level security;
alter table public.customer_outlets enable row level security;
alter table public.customer_outlets force row level security;
revoke all on public.customers,public.customer_outlets from public,anon,authenticated,service_role;
grant select on public.customers,public.customer_outlets to authenticated;
create policy customer_outlets_read on public.customer_outlets for select to authenticated
  using (outlet_id in (select unnest(a.outlet_ids) from private.current_access() a));
create policy customers_read on public.customers for select to authenticated using (
  business_id in (select a.business_id from private.current_access() a where a.role='owner')
  or id in (select co.customer_id from public.customer_outlets co
    where co.outlet_id in (select unnest(a.outlet_ids) from private.current_access() a))
);

-- Normal same-outlet references. Deferred checks permit the existing record/event
-- cycles to be uploaded or created in a single audited transaction.
do $$
declare link record;
begin
  for link in select * from (values
    ('items','category_id','categories'),
    ('orders','event_id','events'),('orders','status_event_id','events'),
    ('sales','order_id','orders'),('sales','closing_id','day_closings'),('sales','event_id','events'),
    ('credit_entries','sale_id','sales'),('credit_entries','order_id','orders'),('credit_entries','refund_id','order_refunds'),('credit_entries','event_id','events'),
    ('order_notes','order_id','orders'),('order_notes','event_id','events'),
    ('order_communications','order_id','orders'),('order_communications','event_id','events'),
    ('order_refunds','order_id','orders'),('order_refunds','credit_entry_id','credit_entries'),('order_refunds','event_id','events'),
    ('suppliers','event_id','events'),('stock_items','supplier_id','suppliers'),('stock_items','event_id','events'),
    ('stock_moves','stock_item_id','stock_items'),('stock_moves','event_id','events'),
    ('supplier_messages','supplier_id','suppliers'),('supplier_messages','event_id','events'),
    ('day_closings','event_id','events'),('purchases','supplier_id','suppliers'),('purchases','event_id','events'),
    ('inbox_images','inbox_item_id','inbox_items'),
    ('events','undo_of','events'),('events','order_id','orders'),('events','stock_item_id','stock_items'),
    ('events','supplier_id','suppliers'),('events','closing_id','day_closings'),('events','handoff_id','events'),('events','inbox_id','inbox_items'),
    ('payments','order_id','orders'),('payments','credit_entry_id','credit_entries'),('payments','sale_id','sales')
  ) as refs(child,column_name,parent)
  loop
    execute format('alter table public.%I add foreign key (business_id,outlet_id,%I)
      references public.%I(business_id,outlet_id,id) deferrable initially deferred',link.child,link.column_name,link.parent);
    execute format('create index %I on public.%I (business_id,outlet_id,%I)',link.child||'_'||link.column_name||'_idx',link.child,link.column_name);
  end loop;
end $$;

do $$
declare table_name text;
begin
  foreach table_name in array array['credit_accounts','orders','sales','credit_entries','order_refunds','events'] loop
    execute format('alter table public.%I add foreign key (business_id,outlet_id,customer_id)
      references public.customer_outlets(business_id,outlet_id,customer_id) deferrable initially deferred',table_name);
    execute format('create index %I on public.%I (business_id,outlet_id,customer_id)',table_name||'_customer_idx',table_name);
  end loop;
  foreach table_name in array array['orders','sales','credit_entries','order_notes','order_communications','order_refunds',
    'stock_moves','supplier_messages','day_closings','purchases'] loop
    execute format('alter table public.%I add foreign key (business_id,created_by)
      references public.members(business_id,id) deferrable initially deferred',table_name);
    execute format('create index %I on public.%I (business_id,created_by)',table_name||'_created_by_idx',table_name);
  end loop;
end $$;

alter table public.sales add constraint sales_credit_customer check (credit_account_id is null or customer_id is not null),
  add foreign key (business_id,outlet_id,credit_account_id,customer_id,currency)
    references public.credit_accounts(business_id,outlet_id,id,customer_id,currency) deferrable initially deferred,
  add unique (business_id,outlet_id,order_id,id), add unique (business_id,outlet_id,closing_id,id);
alter table public.credit_entries
  add foreign key (business_id,outlet_id,account_id,customer_id,currency)
    references public.credit_accounts(business_id,outlet_id,id,customer_id,currency) deferrable initially deferred,
  add foreign key (business_id,outlet_id,account_id,reversal_of)
    references public.credit_entries(business_id,outlet_id,account_id,id) deferrable initially deferred,
  add foreign key (business_id,outlet_id,account_id,returns_charge_id)
    references public.credit_entries(business_id,outlet_id,account_id,id) deferrable initially deferred,
  add check (reversal_of <> id), add check (returns_charge_id <> id);
alter table public.order_refunds
  add check (account_id is null or customer_id is not null),
  add foreign key (business_id,outlet_id,account_id,customer_id,currency)
    references public.credit_accounts(business_id,outlet_id,id,customer_id,currency) deferrable initially deferred,
  add foreign key (business_id,outlet_id,order_id,sale_id)
    references public.sales(business_id,outlet_id,order_id,id) deferrable initially deferred;
alter table public.stock_moves add unique (business_id,outlet_id,stock_item_id,id), add check (undo_of <> id),
  add foreign key (business_id,outlet_id,stock_item_id,undo_of)
    references public.stock_moves(business_id,outlet_id,stock_item_id,id) deferrable initially deferred;
alter table public.day_closings
  add foreign key (business_id,outlet_id,id,added_sale_id)
    references public.sales(business_id,outlet_id,closing_id,id) deferrable initially deferred;
alter table public.orders add foreign key (business_id,handled_by) references public.members(business_id,id) deferrable initially deferred;
alter table public.check_ins add foreign key (business_id,member_id) references public.members(business_id,id) deferrable initially deferred,
  add foreign key (business_id,recorded_by) references public.members(business_id,id) deferrable initially deferred;
alter table public.events add foreign key (business_id,actor_member_id) references public.members(business_id,id) deferrable initially deferred,
  add check (undo_of <> id);

create index sales_credit_account_idx on public.sales(business_id,outlet_id,credit_account_id,customer_id,currency);
create index credit_entries_account_idx on public.credit_entries(business_id,outlet_id,account_id,customer_id,currency);
create index credit_entries_returns_charge_idx on public.credit_entries(business_id,outlet_id,account_id,returns_charge_id);
create index order_refunds_account_idx on public.order_refunds(business_id,outlet_id,account_id,customer_id,currency);
create index order_refunds_sale_idx on public.order_refunds(business_id,outlet_id,order_id,sale_id);
create index day_closings_added_sale_idx on public.day_closings(business_id,outlet_id,id,added_sale_id);
create index stock_moves_undo_idx on public.stock_moves(business_id,outlet_id,stock_item_id,undo_of);
create index orders_handled_by_idx on public.orders(business_id,handled_by);
create index check_ins_member_idx on public.check_ins(business_id,member_id);
create index check_ins_recorded_by_idx on public.check_ins(business_id,recorded_by);
create index events_actor_member_idx on public.events(business_id,actor_member_id);
create index events_order_revision_idx on public.events(business_id,outlet_id,order_id,order_revision);
create index events_stock_revision_idx on public.events(business_id,outlet_id,stock_item_id,stock_revision);

-- Serialize image-byte reservations through the parent row. An atomic UPDATE plus
-- its CHECK cannot overbook the limit, even when separate requests arrive together.
-- Bytes themselves belong in the private Storage bucket, not in a public JSON row.
create function private.reserve_inbox_image_bytes() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op='UPDATE' then
    if row(new.id,new.business_id,new.outlet_id,new.inbox_item_id,new.position,new.name::text,new.type,new.size,new.sha256)
      is distinct from row(old.id,old.business_id,old.outlet_id,old.inbox_item_id,old.position,old.name::text,old.type,old.size,old.sha256) then
      raise check_violation using message='Original image metadata is immutable.';
    end if;
    return new;
  end if;
  if tg_op='INSERT' then
    update public.inbox_items set image_bytes=image_bytes+new.size
      where business_id=new.business_id and outlet_id=new.outlet_id and id=new.inbox_item_id;
    if not found then raise foreign_key_violation using message='Save the Inbox item before its images.'; end if;
    return new;
  end if;
  update public.inbox_items set image_bytes=image_bytes-old.size
    where business_id=old.business_id and outlet_id=old.outlet_id and id=old.inbox_item_id;
  return old;
end $$;
revoke all on function private.reserve_inbox_image_bytes() from public,anon,authenticated,service_role;
create trigger inbox_image_budget before insert or update or delete on public.inbox_images
  for each row execute function private.reserve_inbox_image_bytes();
