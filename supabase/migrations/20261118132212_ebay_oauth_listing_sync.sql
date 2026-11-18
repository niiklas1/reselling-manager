create table if not exists public.ebay_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  ebay_user_id text,
  refresh_token_ciphertext text not null,
  refresh_token_iv text not null,
  refresh_token_expires_at timestamptz,
  scopes text[] not null default '{}',
  connected_at timestamptz not null default now(),
  last_sync_at timestamptz,
  last_sync_error text,
  updated_at timestamptz not null default now()
);

create table if not exists public.ebay_oauth_states (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  state_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists ebay_oauth_states_expires_at_idx
  on public.ebay_oauth_states(expires_at);

create table if not exists public.ebay_listings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  external_listing_id text not null,
  title text not null default '',
  marketplace text not null default 'EBAY_DE',
  status text not null default 'UNKNOWN'
    check (status in ('ACTIVE', 'ENDED', 'SCHEDULED', 'SOLD', 'UNKNOWN')),
  listing_format text,
  price numeric(14,2),
  currency char(3),
  quantity_available integer,
  quantity_sold integer,
  listing_url text,
  started_at timestamptz,
  ended_at timestamptz,
  last_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (user_id, external_listing_id)
);

create index if not exists ebay_listings_user_status_idx
  on public.ebay_listings(user_id, status);

create table if not exists public.ebay_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  external_order_id text not null,
  line_item_id text not null,
  external_listing_id text,
  title text not null default '',
  quantity integer not null default 1,
  amount numeric(14,2),
  currency char(3),
  order_status text not null default '',
  sold_at timestamptz,
  last_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (user_id, external_order_id, line_item_id)
);

alter table public.ebay_connections enable row level security;
alter table public.ebay_oauth_states enable row level security;
alter table public.ebay_listings enable row level security;
alter table public.ebay_orders enable row level security;

revoke all on public.ebay_connections from anon, authenticated;
revoke all on public.ebay_oauth_states from anon, authenticated;
revoke all on public.ebay_listings from anon, authenticated;
revoke all on public.ebay_orders from anon, authenticated;

grant all on public.ebay_connections to service_role;
grant all on public.ebay_oauth_states to service_role;
grant all on public.ebay_listings to service_role;
grant all on public.ebay_orders to service_role;
