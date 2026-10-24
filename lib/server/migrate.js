// Sets up the database on first run: if the app's tables aren't there yet, creates them from the
// same SQL as supabase/migrations/0001_init.sql. Safe with many servers starting at once: a
// database lock lets only one do it, and the others then see the tables already exist.
import { SCHEMA_SQL } from './schema-sql.js';

export async function ensureSchema(sql) {
  const exists = async (q) => (await q`select 1 from information_schema.schemata where schema_name = 'app'`).length > 0;
  if (await exists(sql)) return false;
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(724113)`;
    if (await exists(tx)) return false;
    // .simple(): the file has many statements, which needs Postgres's simple-query mode
    await tx.unsafe(SCHEMA_SQL).simple();
    console.log('Database tables created.');
    return true;
  });
}
