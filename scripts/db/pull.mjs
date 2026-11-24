// Refresh prisma/schema.prisma from the database, then generate the client.
//
// The schema file has one schema and no auth models: the models follow the connection's schema at run
// time (DB_SCHEMA, see lib/db), so the same client serves `public` locally and `project` on the shared
// database, where user_profiles has no foreign key to auth.users.
//   - DB_SCHEMA=project (the shared-database rehearsal): pulls that schema directly.
//   - otherwise (local Supabase, `public`): Prisma must read `auth` too because of the user_profiles ->
//     auth.users foreign key; everything from `auth` is removed again afterwards.
//
// Usage: npm run db:pull   (settings from .env.development.local, or LOCAL_ENV_FILE)
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCHEMA = path.join(ROOT, 'prisma', 'schema.prisma');
config({ path: path.join(ROOT, process.env.LOCAL_ENV_FILE || '.env.development.local'), quiet: true });
const dbSchema = process.env.DB_SCHEMA || 'public';
const run = (cmd, env = {}) => execSync(cmd, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });
const read = () => fs.readFileSync(SCHEMA, 'utf8').replace(/\r\n/g, '\n');

if (dbSchema !== 'public') {
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set('schema', dbSchema);
  run('npx prisma db pull', { DATABASE_URL: url.toString() });
} else {
  // Let Prisma read auth for the cross-schema foreign key, just for the pull
  fs.writeFileSync(SCHEMA, read().replace(/datasource db \{\n(\s*provider\s*=\s*"postgresql"\n)\}/, 'datasource db {\n$1  schemas  = ["auth", "public"]\n}'));
  run('npx prisma db pull');
  const parts = read().split(/\n(?=(?:\/\/\/[^\n]*\n)*(?:model|enum|view|generator|datasource) \w+ \{)/);
  const isAuth = (block) => /\n\s*@@schema\("auth"\)/.test(block);
  const authNames = new Set(parts.filter(isAuth).map((b) => b.match(/(?:model|enum|view) (\w+) \{/)?.[1]).filter(Boolean));
  const kept = parts.filter((b) => !isAuth(b)).map((block) => block.split('\n').filter((line) => {
    const t = line.trim();
    if (/^@@schema\(/.test(t) || /^schemas\s*=/.test(t)) return false;
    const type = (t.split(/\s+/)[1] || '').replace(/[?[\]]/g, '');
    return !authNames.has(type); // relation fields to auth models
  }).join('\n'));
  fs.writeFileSync(SCHEMA, kept.join('\n'));
}

run('npx prisma format');
run('npx prisma generate');
console.log(`Pulled schema "${dbSchema}" into prisma/schema.prisma (one schema, no auth models).`);
