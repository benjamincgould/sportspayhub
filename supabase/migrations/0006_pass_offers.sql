-- Passes are made for one child or for a whole family (sessions shared by the children), with the
-- number of sessions and price the coach or treasurer chooses. A pass can also be offered to the
-- parents first: it starts working once they buy it (card) or the club marks it paid (bank, cash).
-- The app applies this by itself on its next start.

alter table app.passes alter column athlete_id drop not null;
alter table app.passes add column family_id integer references app.families (id) on delete cascade;
alter table app.passes add constraint passes_for_one check ((athlete_id is null) <> (family_id is null));
alter table app.passes drop constraint if exists passes_status_check;
alter table app.passes add constraint passes_status_check check (status in ('offered', 'active', 'cancelled'));
create index passes_family on app.passes (family_id);
