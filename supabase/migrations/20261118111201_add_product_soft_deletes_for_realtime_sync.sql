-- Use tombstones for product deletion. UPDATE events include user_id and can
-- therefore be safely filtered in Supabase Realtime; DELETE events cannot.
alter table public.products
  add column if not exists deleted_at timestamptz;

create index if not exists products_user_active_updated_at_idx
  on public.products (user_id, updated_at desc)
  where deleted_at is null;
