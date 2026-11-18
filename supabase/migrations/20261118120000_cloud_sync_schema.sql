-- Track the one-time import of the previous browser-local inventory.
-- The browser cache is unscoped, so the app requests explicit consent and keeps a
-- separate browser-level marker to prevent offering the same cache to another account.
alter table public.user_settings
  add column if not exists local_migration_completed boolean not null default false;
