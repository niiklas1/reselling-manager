-- Initial account-owned inventory schema.
-- Existing Supabase project uses RLS policies that limit products to auth.uid().

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (char_length(trim(name)) > 0),
  category text not null default '',
  platform text not null default '',
  purchase_price numeric not null default 0 check (purchase_price >= 0),
  sale_price numeric not null default 0 check (sale_price >= 0),
  shipping numeric not null default 0 check (shipping >= 0),
  fees numeric not null default 0 check (fees >= 0),
  purchase_date date,
  sale_date date,
  status text not null default 'Auf Lager' check (status in ('Auf Lager', 'Verkauft')),
  created_at timestamptz not null default now(),
  quantity integer not null default 1 check (quantity > 0),
  image_url text,
  receipt_path text,
  image_attribution text,
  image_license text
);

alter table public.products enable row level security;
revoke all on public.products from anon;
grant select, insert, update, delete on public.products to authenticated;

drop policy if exists "Users can read their own products" on public.products;
create policy "Users can read their own products"
  on public.products for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert their own products" on public.products;
create policy "Users can insert their own products"
  on public.products for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own products" on public.products;
create policy "Users can update their own products"
  on public.products for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete their own products" on public.products;
create policy "Users can delete their own products"
  on public.products for delete to authenticated
  using ((select auth.uid()) = user_id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'product-invoices',
  'product-invoices',
  false,
  10485760,
  array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic']::text[]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Users upload own product invoices" on storage.objects;
create policy "Users upload own product invoices"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'product-invoices'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Users read own product invoices" on storage.objects;
create policy "Users read own product invoices"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'product-invoices'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Users delete own product invoices" on storage.objects;
create policy "Users delete own product invoices"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'product-invoices'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
