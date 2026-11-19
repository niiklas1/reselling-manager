-- Speed up matching eBay marketplace account deletion events to connected seller accounts.
-- Only non-null immutable eBay user IDs are indexed.
create index if not exists ebay_connections_ebay_user_id_idx
  on public.ebay_connections (ebay_user_id)
  where ebay_user_id is not null;
