-- Cover the complete tenant keys used by foreign-key checks and scoped probes.
-- Existing shorter unique indexes still enforce identity and one reversal.
create index staff_pins_member_scope_idx on private.staff_pins(business_id,member_id);
create index credit_entries_reversal_scope_idx on public.credit_entries(business_id,outlet_id,account_id,reversal_of);
