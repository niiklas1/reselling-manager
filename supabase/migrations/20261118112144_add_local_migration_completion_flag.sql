-- Records that this browser's legacy local inventory has been offered for import.
-- Local browser data is never deleted by this migration.
alter table public.user_settings
  add column if not exists local_migration_completed boolean not null default false;
