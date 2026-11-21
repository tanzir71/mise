-- The receipt history index begins with business/outlet for scoped reads.
-- This separate leading order key also covers the order foreign-key lookup.
create index kitchen_receipt_order_fk_idx on private.kitchen_action_receipts(order_id);
