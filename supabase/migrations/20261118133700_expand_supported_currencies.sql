alter table public.user_settings
 drop constraint if exists user_settings_currency_check;
alter table public.user_settings
 add constraint user_settings_currency_check
 check (currency in ('EUR','USD','GBP','CHF','PLN','CZK','JPY','CNY','AUD','CAD'));
