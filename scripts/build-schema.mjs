// Copies supabase/migrations/0001_init.sql into lib/server/schema-sql.js, so the app can set up
// its own database on first run. Run after changing the SQL: node scripts/build-schema.mjs
import fs from 'node:fs';
const sql = fs.readFileSync(new URL('../supabase/migrations/0001_init.sql', import.meta.url), 'utf8');
fs.writeFileSync(new URL('../lib/server/schema-sql.js', import.meta.url),
  `// Generated from supabase/migrations/0001_init.sql by scripts/build-schema.mjs. Don't edit by hand.\nexport const SCHEMA_SQL = ${JSON.stringify(sql)};\n`);
console.log('lib/server/schema-sql.js updated');
