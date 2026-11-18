-- Keep the repository migration history aligned with the migration already
-- applied to the connected Supabase project (version 20261118112304).
-- The prior migration may already have added this column, so this is idempotent.
alter table public.user_settings
  add column if not exists local_migration_completed boolean not null default false;
