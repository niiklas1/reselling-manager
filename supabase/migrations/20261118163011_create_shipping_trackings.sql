-- Private, per-account tracking state. Only the authenticated owner can read
-- their rows; writes are performed server-side by the Cloudflare Worker.
create table if not exists public.shipping_trackings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  direction text not null check (direction in ('incoming', 'outgoing')),
  tracking_number text not null check (char_length(trim(tracking_number)) between 5 and 120),
  carrier text not null default '',
  tracking_url text not null default '',
  provider text not null default '17track',
  provider_carrier integer,
  provider_registered boolean not null default false,
  tracking_status text not null default 'unknown'
    check (tracking_status in (
      'unknown', 'label_created', 'not_found', 'in_transit',
      'out_for_delivery', 'available_for_pickup', 'attention',
      'stale', 'delivered', 'returned'
    )),
  provider_status text,
  provider_sub_status text,
  latest_event text,
  latest_location text,
  latest_event_at timestamptz,
  estimated_delivery_from timestamptz,
  estimated_delivery_to timestamptz,
  last_synced_at timestamptz,
  tracking_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, product_id, direction)
);

create index if not exists shipping_trackings_user_status_updated_idx
  on public.shipping_trackings (user_id, tracking_status, updated_at desc);

create index if not exists shipping_trackings_product_idx
  on public.shipping_trackings (product_id);

alter table public.shipping_trackings enable row level security;

revoke all on public.shipping_trackings from anon, authenticated;
grant select on public.shipping_trackings to authenticated;
grant all on public.shipping_trackings to service_role;

drop policy if exists "Users can read their own shipping trackings" on public.shipping_trackings;
create policy "Users can read their own shipping trackings"
  on public.shipping_trackings
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'shipping_trackings'
  ) then
    alter publication supabase_realtime add table public.shipping_trackings;
  end if;
end
$$;
