// Keeps the database up to date by itself: creates the app's tables on a brand-new database, and
// applies any newer changes (supabase/migrations) once each. Safe with many servers starting at
// once: a database lock lets only one do it, and the others then find nothing left to do.
import { MIGRATIONS } from './schema-sql.js';

const BOOKKEEPING = `
create schema if not exists app;
create table if not exists app.schema_migrations (id text primary key, applied_at timestamptz not null default now());
alter table app.schema_migrations enable row level security;
revoke all on app.schema_migrations from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on app.schema_migrations from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on app.schema_migrations from authenticated'; end if;
end $$;`;

export async function ensureSchema(sql) {
  const latest = MIGRATIONS[MIGRATIONS.length - 1].id;
  try {
    if ((await sql`select 1 from app.schema_migrations where id = ${latest}`).length) return false; // already up to date
  } catch { /* not set up yet */ }

  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(724113)`;
    const hadTables = (await tx`select 1 from information_schema.tables where table_schema = 'app' and table_name = 'clubs'`).length > 0;
    await tx.unsafe(BOOKKEEPING).simple();
    const done = new Set((await tx`select id from app.schema_migrations`).map((r) => r.id));
    // A database set up before this bookkeeping existed already has the first migration
    if (hadTables && !done.has(MIGRATIONS[0].id)) {
      await tx`insert into app.schema_migrations (id) values (${MIGRATIONS[0].id})`;
      done.add(MIGRATIONS[0].id);
    }
    const applied = [];
    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue;
      await tx.unsafe(m.sql).simple(); // .simple(): each file has several statements
      await tx`insert into app.schema_migrations (id) values (${m.id})`;
      applied.push(m.id);
    }
    if (applied.length) console.log(`Database updated: ${applied.join(', ')}`);
    return applied.length > 0;
  });
}
