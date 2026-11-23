// Phase 11 tracker helper: where does application code still reach the Supabase Data API?
//
// - "browser": files that create the browser Supabase client (createClientSupabase / createBrowserClient)
//   and query tables or functions with it. These still go to the Data API directly from the browser.
// - "own client": server files that create their own supabase-js client and query with it.
// - "query layer": server files whose .from()/.rpc() run on clients from lib/supabase-server.ts, which
//   go through Prisma (lib/db/query.ts) whenever DATABASE_URL is set. Counted, not a dependency.
//
// Usage: node scripts/migrate/data-api-usage.mjs [--list]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CALL = /\.from\(\s*['"`][a-z_]+['"`]\s*\)|\.rpc\(/g;
const files = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!['generated', 'node_modules'].includes(e.name)) walk(p); }
    else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
  }
};
for (const d of ['app', 'components', 'lib']) walk(path.join(ROOT, d));

const groups = { browser: [], ownClient: [], queryLayer: [] };
for (const file of files) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  if (rel.startsWith('lib/db/')) continue;
  const src = fs.readFileSync(file, 'utf8');
  const calls = (src.match(CALL) || []).length;
  if (!calls) continue;
  const browser = /createClientSupabase\(|createBrowserClient\(/.test(src);
  // lib/supabase-server.ts builds the switched clients; its own queries use them
  const own = rel !== 'lib/supabase-server.ts' && /from '@supabase\/supabase-js'/.test(src) && /createClient\(/.test(src);
  if (browser) groups.browser.push({ rel, calls });
  else if (own) groups.ownClient.push({ rel, calls });
  else groups.queryLayer.push({ rel, calls });
}

const sum = (list) => list.reduce((s, f) => s + f.calls, 0);
console.log(`Data API from the browser:      ${groups.browser.length} files, ${sum(groups.browser)} calls`);
console.log(`Own supabase-js client (server): ${groups.ownClient.length} files, ${sum(groups.ownClient)} calls`);
console.log(`Through the query layer:         ${groups.queryLayer.length} files, ${sum(groups.queryLayer)} calls`);
if (process.argv.includes('--list')) {
  for (const [name, list] of Object.entries(groups)) {
    console.log(`\n${name}:`);
    for (const f of list.sort((a, b) => b.calls - a.calls)) console.log(`  ${String(f.calls).padStart(3)}  ${f.rel}`);
  }
}
