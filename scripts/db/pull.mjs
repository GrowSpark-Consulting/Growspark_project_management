// Refresh prisma/schema.prisma from the database, then generate the client.
//
// Prisma has to read the `auth` schema because user_profiles.id references auth.users. Only the id of
// auth.users is kept (and the relations to the app's own tables); Supabase's other internal auth
// tables and enums are dropped, so app code can't query them through Prisma.
//
// Usage: npm run db:pull   (DATABASE_URL from .env.development.local: local Docker Supabase)
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCHEMA = path.join(ROOT, 'prisma', 'schema.prisma');
const run = (cmd) => execSync(cmd, { cwd: ROOT, stdio: 'inherit' });

run('npx prisma db pull');

const text = fs.readFileSync(SCHEMA, 'utf8').replace(/\r\n/g, '\n');
// Split into top-level blocks (model / enum / view / generator / datasource) and the text between them
const parts = text.split(/\n(?=(?:\/\/\/[^\n]*\n)*(?:model|enum|view|generator|datasource) \w+ \{)/);
const isAuth = (block) => /\n\s*@@schema\("auth"\)/.test(block);
const nameOf = (block) => block.match(/(?:model|enum|view) (\w+) \{/)?.[1];

const kept = parts.filter((b) => !isAuth(b) || nameOf(b) === 'users');
const appModels = new Set(kept.filter((b) => !isAuth(b)).map(nameOf).filter(Boolean));

const pruned = kept.map((block) => {
  if (!isAuth(block)) return block;
  // auth.users: keep the id, relations to the app's own models, and the schema attribute
  const lines = block.split('\n').filter((line) => {
    const t = line.trim();
    if (t.startsWith('model ') || t === '}' || t === '@@schema("auth")') return true;
    if (t.startsWith('///') || t.startsWith('@@') || t === '') return false;
    const [field, type = ''] = t.split(/\s+/);
    return field === 'id' || appModels.has(type.replace(/[?[\]]/g, ''));
  });
  return lines.join('\n');
});

fs.writeFileSync(SCHEMA, pruned.join('\n'));
run('npx prisma format');
run('npx prisma generate');
console.log(`Kept ${appModels.size} app models and auth.users (id only).`);
