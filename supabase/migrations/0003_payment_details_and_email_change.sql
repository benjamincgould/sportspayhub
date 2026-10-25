-- How clubs pay the platform owner (card through Stripe and/or bank transfer), and email changes.
-- The app applies this by itself on its next start.

-- The owner's own settings, e.g. bank account details shown on payment requests
create table app.platform_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
alter table app.platform_settings enable row level security;
revoke all on app.platform_settings from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on app.platform_settings from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on app.platform_settings from authenticated'; end if;
end $$;

-- Charges: a reference for bank transfers, and how each was paid
alter table app.platform_charges add column reference text;
alter table app.platform_charges add column paid_method text check (paid_method in ('card', 'bank', 'other'));

-- Email-change confirmation links live alongside invite and reset links
alter table app.tokens drop constraint if exists tokens_kind_check;
alter table app.tokens add constraint tokens_kind_check check (kind in ('invite', 'reset', 'email'));
alter table app.tokens add column data jsonb;
