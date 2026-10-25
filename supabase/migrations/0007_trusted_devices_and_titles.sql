-- "Remember this device for 8 hours": after a two-step code, a device can skip the code (not the
-- password) for 8 hours. Only a hash of the device's random token is kept.
-- Titles: a club's staff can have their own job title (e.g. "Club Administrator") shown in the app.
-- The app applies this by itself on its next start.

create table app.trusted_devices (
  hash       text primary key,
  user_id    uuid not null references app.profiles (id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  ip         text,
  user_agent text
);
create index trusted_devices_user on app.trusted_devices (user_id);
alter table app.trusted_devices enable row level security;
revoke all on app.trusted_devices from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on app.trusted_devices from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on app.trusted_devices from authenticated'; end if;
end $$;

alter table app.profiles add column title text;
