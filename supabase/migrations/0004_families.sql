-- Families: children who share a parent account are billed together. A family has one schedule
-- (weekly, fortnightly or monthly, chosen by the parents), one way of paying (card or bank
-- transfer, set by the club), one paid/overdue status, one bank reference and, for card, one
-- Stripe subscription with a line for each child at their own group's price.
-- The app applies this by itself on its next start.

create table app.families (
  id         integer generated always as identity primary key,
  club_id    integer not null references app.clubs (id) on delete cascade,
  frequency  text not null default 'weekly' check (frequency in ('weekly', 'fortnightly', 'monthly')),
  pay_method text check (pay_method in ('card', 'bank')),   -- null: the club's default
  status     text not null default 'paid' check (status in ('paid', 'overdue')),
  reference  text not null default '',                      -- bank-transfer reference, e.g. PARKERF12
  billing    jsonb not null default '{}',                    -- Stripe customer and subscription, last paid
  created_at timestamptz not null default now()
);
create index families_club on app.families (club_id);
alter table app.families enable row level security;
revoke all on app.families from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on app.families from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on app.families from authenticated'; end if;
end $$;

alter table app.athletes add column family_id integer references app.families (id) on delete set null;
create index athletes_family on app.athletes (family_id);

-- Existing members: a family each (carrying over their plan and any card details), then children
-- who share a parent account are joined into one family.
do $$
declare
  r record;
  fid integer;
  surname text;
begin
  for r in select a.id, a.club_id, a.data, b.data as billing
           from app.athletes a left join app.billing b on b.athlete_id = a.id
           where a.family_id is null order by a.id loop
    insert into app.families (club_id, frequency, pay_method, status, billing)
    values (
      r.club_id,
      case when r.data->>'frequency' in ('weekly', 'fortnightly', 'monthly') then r.data->>'frequency' else 'weekly' end,
      case when r.data->>'payMethod' in ('card', 'bank') then r.data->>'payMethod' end,
      case when coalesce(r.billing->>'status', r.data->>'status') = 'overdue' then 'overdue' else 'paid' end,
      coalesce(r.billing, '{}'::jsonb)
    ) returning id into fid;
    surname := upper(regexp_replace(coalesce(regexp_replace(r.data->>'name', '^.*\s', ''), ''), '[^A-Za-z]', '', 'g'));
    update app.families set reference = left(surname, 11 - length(fid::text)) || 'F' || fid where id = fid;
    update app.athletes set family_id = fid where id = r.id;
  end loop;

  -- Join brothers and sisters: repeat until no parent account spans more than one family.
  -- The family kept is one with card details if there is one; overdue stays overdue.
  loop
    select ua.user_id into r
    from app.user_athletes ua join app.athletes a on a.id = ua.athlete_id
    group by ua.user_id having count(distinct a.family_id) > 1 limit 1;
    exit when not found;
    select f.id into fid from app.families f
    where f.id in (select a.family_id from app.user_athletes ua join app.athletes a on a.id = ua.athlete_id where ua.user_id = r.user_id)
    order by (f.billing ? 'subscriptionId') desc, (f.billing ? 'customerId') desc, f.id limit 1;
    update app.families set status = 'overdue'
    where id = fid and exists (select 1 from app.families f2 where f2.status = 'overdue'
      and f2.id in (select a.family_id from app.user_athletes ua join app.athletes a on a.id = ua.athlete_id where ua.user_id = r.user_id));
    update app.athletes set family_id = fid
    where family_id in (select a.family_id from app.user_athletes ua join app.athletes a on a.id = ua.athlete_id where ua.user_id = r.user_id);
  end loop;
  delete from app.families f where not exists (select 1 from app.athletes a where a.family_id = f.id);
end $$;
