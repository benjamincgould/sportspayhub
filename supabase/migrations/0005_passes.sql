-- Session passes: a set number of sessions for one child, bought by card or issued by the coach
-- or treasurer (paid by bank transfer or cash, or given free). Each session the coach marks the
-- child present at uses one, and unticking them gives it back.
-- The app applies this by itself on its next start.

create table app.passes (
  id         integer generated always as identity primary key,
  club_id    integer not null references app.clubs (id) on delete cascade,
  athlete_id integer not null references app.athletes (id) on delete cascade,
  sessions   integer not null check (sessions between 1 and 500),
  used       integer not null default 0 check (used >= 0),
  price      numeric(10, 2) not null default 0 check (price >= 0),
  paid_by    text not null check (paid_by in ('card', 'bank', 'cash', 'free', 'unpaid')),
  status     text not null default 'active' check (status in ('active', 'cancelled')),
  ref        text unique,                                     -- Stripe checkout id for card passes
  issued_by  uuid,
  created_at timestamptz not null default now()
);
create index passes_athlete on app.passes (athlete_id);
create index passes_club on app.passes (club_id);
alter table app.passes enable row level security;
revoke all on app.passes from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on app.passes from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on app.passes from authenticated'; end if;
end $$;

-- Which pass a present mark used, so unticking it gives the session back
alter table app.attendance add column pass_id integer references app.passes (id) on delete set null;
