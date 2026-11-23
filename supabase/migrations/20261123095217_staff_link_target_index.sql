-- Cover the member foreign key independently of the outlet-specific reader.
-- The already applied staff-link migration remains immutable.
create index staff_links_target on private.staff_links(business_id,member_id);
