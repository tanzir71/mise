-- Cover the event FK in hosted advisor order; keep raw receipt access closed.
create index shop_command_receipts_event_idx on private.shop_command_receipts(business_id,outlet_id,id);
