// Copies every file in supabase/migrations into lib/server/schema-sql.js, so the app can set up
// and update its own database. Run after adding or changing a migration: node scripts/build-schema.mjs
import fs from 'node:fs';
const dir = new URL('../supabase/migrations/', import.meta.url);
const migrations = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  .map((f) => ({ id: f.replace(/\.sql$/, ''), sql: fs.readFileSync(new URL(f, dir), 'utf8') }));
fs.writeFileSync(new URL('../lib/server/schema-sql.js', import.meta.url),
  `// Generated from supabase/migrations by scripts/build-schema.mjs. Don't edit by hand.\nexport const MIGRATIONS = ${JSON.stringify(migrations, null, 1)};\n`);
console.log(`lib/server/schema-sql.js updated (${migrations.map((m) => m.id).join(', ')})`);
