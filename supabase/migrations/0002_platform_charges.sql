-- Charges from the platform owner to clubs: set-up fees and one-off charges.
-- The app applies this by itself on its next start; it never needs pasting into Supabase.

create table app.platform_charges (
  id                integer generated always as identity primary key,
  club_id           integer not null references app.clubs (id) on delete cascade,
  kind              text not null check (kind in ('setup', 'oneoff')),
  description       text not null,
  amount_cents      integer not null check (amount_cents > 0),
  status            text not null default 'open' check (status in ('open', 'paid', 'void')),
  stripe_ref        text unique,     -- the Stripe invoice (or checkout, for set-up fees paid at subscribe)
  pay_url           text,            -- Stripe's secure payment page for an open charge
  created_by        uuid,
  created_at        timestamptz not null default now(),
  paid_at           timestamptz
);
create index platform_charges_club on app.platform_charges (club_id, id desc);

-- Locked like every other table: row-level security on, no rights for Supabase's public roles
alter table app.platform_charges enable row level security;
revoke all on app.platform_charges from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on app.platform_charges from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on app.platform_charges from authenticated'; end if;
end $$;
