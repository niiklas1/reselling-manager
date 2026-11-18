-- Cloud sync schema and per-account preferences. Existing product RLS policies
-- and private product-invoices Storage policies are preserved.

alter table public.products
  add column if not exists group_id text,
  add column if not exists incoming_carrier text not null default '',
  add column if not exists incoming_tracking_number text not null default '',
  add column if not exists incoming_tracking_url text not null default '',
  add column if not exists outgoing_carrier text not null default '',
  add column if not exists outgoing_tracking_number text not null default '',
  add column if not exists outgoing_tracking_url text not null default '',
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists deleted_at timestamptz;

create index if not exists products_user_updated_at_idx on public.products (user_id, updated_at desc);

create table if not exists public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  currency text not null default 'EUR' check (currency in ('EUR', 'USD', 'GBP', 'CHF')),
  theme text not null default 'dark' check (theme in ('light', 'dark')),
  gmail_client_id text not null default '',
  gmail_learning_hints jsonb not null default '[]'::jsonb check (jsonb_typeof(gmail_learning_hints) = 'array'),
  local_migration_completed boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table public.user_settings add column if not exists local_migration_completed boolean not null default false;
alter table public.user_settings enable row level security;
revoke all on public.user_settings from anon;
grant select, insert, update, delete on public.user_settings to authenticated;
grant select, insert, update, delete on public.products to authenticated;

drop policy if exists "Users can read their own settings" on public.user_settings;
create policy "Users can read their own settings" on public.user_settings for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "Users can insert their own settings" on public.user_settings;
create policy "Users can insert their own settings" on public.user_settings for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "Users can update their own settings" on public.user_settings;
create policy "Users can update their own settings" on public.user_settings for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "Users can delete their own settings" on public.user_settings;
create policy "Users can delete their own settings" on public.user_settings for delete to authenticated using ((select auth.uid()) = user_id);

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='products') then
    alter publication supabase_realtime add table public.products;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='user_settings') then
    alter publication supabase_realtime add table public.user_settings;
  end if;
end $$;
