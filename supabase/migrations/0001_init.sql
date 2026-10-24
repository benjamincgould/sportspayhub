-- Club App: database schema for Supabase (Postgres).
--
-- Paste this whole file into Supabase → SQL Editor → New query → Run (once, on a new project).
--
-- How the data is protected:
--   * Everything lives in its own schema, "app", which Supabase's public Data API does not expose.
--     The browser never talks to the database: only the app's server does, after its own checks.
--   * Row-level security is switched on for every table with no policies, and the public roles
--     (anon, authenticated) have no rights at all. So even if the "app" schema were exposed by
--     mistake, the public API keys would read and write nothing.
--   * Sign-in passwords and two-step secrets are kept by Supabase Auth (auth schema), not here.
--   * Children's contact and medical details are encrypted by the app (AES-256-GCM) before they
--     reach the database (athletes.private_enc), so a database backup alone can't reveal them.

create schema if not exists app;
revoke all on schema app from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on schema app from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on schema app from authenticated'; end if;
end $$;

-- Each sports club on the platform. Everything a club owns hangs off clubs.id.
create table app.clubs (
  id         integer generated always as identity primary key,
  name       text not null,
  sport      text not null default '',
  -- preview: signed up, not paid (look-only) · active: paying · comped: free from the owner
  -- past_due: payment failed, still usable while Stripe retries · canceled: ended · suspended: switched off by the owner
  status     text not null default 'preview' check (status in ('preview', 'active', 'comped', 'past_due', 'canceled', 'suspended')),
  branding   jsonb not null default '{}',   -- words, colour, logo
  settings   jsonb not null default '{}',   -- financial year, reminder templates
  billing    jsonb not null default '{}',   -- platform subscription + Stripe Connect account
  created_at timestamptz not null default now()
);
create index clubs_connect_account on app.clubs ((billing->>'connectAccountId'));
create index clubs_platform_customer on app.clubs ((billing->>'platformCustomerId'));

-- One row per person who can sign in. The id is their Supabase Auth user id.
create table app.profiles (
  id                  uuid primary key references auth.users (id) on delete cascade,
  club_id             integer references app.clubs (id) on delete cascade,  -- null only for the platform owner
  email               text not null unique check (email = lower(email)),
  name                text not null default '',
  role                text not null check (role in ('parent', 'treasurer', 'coach', 'owner')),
  status              text not null default 'invited' check (status in ('invited', 'active', 'disabled')),
  mfa_enabled         boolean not null default false,
  failed_logins       integer not null default 0,
  locked_until        timestamptz,
  password_changed_at timestamptz,
  last_login_at       timestamptz,
  created_at          timestamptz not null default now(),
  check ((role = 'owner') = (club_id is null))
);
create index profiles_club on app.profiles (club_id);

-- Single-use recovery codes for two-step verification (stored as fingerprints only)
create table app.recovery_codes (
  id        integer generated always as identity primary key,
  user_id   uuid not null references app.profiles (id) on delete cascade,
  code_hash text not null,
  used_at   timestamptz
);
create index recovery_codes_user on app.recovery_codes (user_id);

-- The app's own sign-in sessions. The browser's cookie holds a random id; only its fingerprint is
-- stored here, so a copy of the database can't be used to sign in. The Supabase Auth tokens for the
-- session are kept here encrypted, never in the browser.
create table app.sessions (
  id_hash           text primary key,
  user_id           uuid not null references app.profiles (id) on delete cascade,
  stage             text not null check (stage in ('full', 'mfa', 'mfa_setup')),
  sb_tokens_enc     text,
  pending_factor_id text,
  mfa_attempts      integer not null default 0,
  created_at        timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  expires_at        timestamptz not null,
  ip                text,
  user_agent        text
);
create index sessions_user on app.sessions (user_id);

-- One-time invite and password-reset links (fingerprints only)
create table app.tokens (
  hash       text primary key,
  user_id    uuid not null references app.profiles (id) on delete cascade,
  kind       text not null check (kind in ('invite', 'reset')),
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_by uuid
);
create index tokens_user on app.tokens (user_id);

create table app.athletes (
  id          integer generated always as identity primary key,
  club_id     integer not null references app.clubs (id) on delete cascade,
  data        jsonb not null,   -- name, group, plan, regular days (no contact or medical details)
  private_enc text,             -- parent, phone, email, address, emergency contact, allergies, medication (AES-256-GCM)
  created_at  timestamptz not null default now()
);
create index athletes_club on app.athletes (club_id);

-- Which parent accounts can see which children (siblings, two parents)
create table app.user_athletes (
  user_id    uuid not null references app.profiles (id) on delete cascade,
  athlete_id integer not null references app.athletes (id) on delete cascade,
  primary key (user_id, athlete_id)
);
create index user_athletes_athlete on app.user_athletes (athlete_id);

create table app.squads (
  id      integer generated always as identity primary key,
  club_id integer not null references app.clubs (id) on delete cascade,
  data    jsonb not null
);
create index squads_club on app.squads (club_id);

create table app.billing (
  athlete_id integer primary key references app.athletes (id) on delete cascade,
  data       jsonb not null
);
create index billing_customer on app.billing ((data->>'customerId'));

create table app.transactions (
  id      integer generated always as identity primary key,
  club_id integer not null references app.clubs (id) on delete cascade,
  data    jsonb not null,
  ref     text unique
);
create index transactions_club on app.transactions (club_id);

create table app.rsvps (
  athlete_id integer not null references app.athletes (id) on delete cascade,
  series_id  text not null,
  date       text not null check (date ~ '^\d{4}-\d{2}-\d{2}$'),
  attending  boolean not null,
  primary key (athlete_id, series_id, date)
);

create table app.attendance (
  athlete_id integer not null references app.athletes (id) on delete cascade,
  series_id  text not null,
  date       text not null check (date ~ '^\d{4}-\d{2}-\d{2}$'),
  present    boolean not null,
  marked_by  uuid,
  primary key (athlete_id, series_id, date)
);

-- Activity log, kept for one year
create table app.audit_log (
  id      integer generated always as identity primary key,
  club_id integer,
  at      timestamptz not null default now(),
  user_id uuid,
  action  text not null,
  detail  jsonb,
  ip      text
);
create index audit_log_club on app.audit_log (club_id, id desc);
create index audit_log_at on app.audit_log (at);

-- Rate limits (keys are fingerprints, so no emails or addresses are stored here)
create table app.rate_limits (
  key          text primary key,
  window_start timestamptz not null,
  count        integer not null
);

-- Counts one attempt against a limit and says whether it's allowed. Atomic, so it works across
-- many servers at once.
create function app.hit_rate_limit(p_key text, p_window_seconds integer, p_max integer)
returns table (allowed boolean, retry_after integer)
language sql
set search_path = ''
as $$
  insert into app.rate_limits as r (key, window_start, count)
  values (p_key, now(), 1)
  on conflict (key) do update set
    window_start = case when r.window_start + make_interval(secs => p_window_seconds) <= now() then now() else r.window_start end,
    count        = case when r.window_start + make_interval(secs => p_window_seconds) <= now() then 1 else r.count + 1 end
  returning r.count <= p_max,
            greatest(1, ceil(extract(epoch from (r.window_start + make_interval(secs => p_window_seconds) - now()))))::integer;
$$;

-- Lock every table: row-level security on, no policies, and no rights for the public roles.
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'app' loop
    execute format('alter table app.%I enable row level security', t.tablename);
    execute format('revoke all on app.%I from public', t.tablename);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on app.%I from anon', t.tablename);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on app.%I from authenticated', t.tablename);
    end if;
  end loop;
end $$;
revoke all on function app.hit_rate_limit(text, integer, integer) from public;
