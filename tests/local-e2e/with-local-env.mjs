// Run a command with the local Docker Supabase settings from .env.development.local.
//
// Why: `next build` / `next start` (production mode) read .env.local, which may point at a
// hosted database. Process environment variables always win over .env files in Next.js,
// so loading the local values here keeps a production-mode test run on local Docker only.
//
// Usage: node tests/local-e2e/with-local-env.mjs npm run build
//        node tests/local-e2e/with-local-env.mjs npm start
// The output of a build made this way talks to local Supabase: rebuild before deploying.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT } from './lib.mjs';

const file = path.join(ROOT, '.env.development.local');
if (!fs.existsSync(file)) {
  console.error('Missing .env.development.local (see tests/local-e2e/README.md).');
  process.exit(1);
}
const vars = {};
for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) vars[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_URL']) {
  const host = vars[key] ? new URL(vars[key]).hostname : '';
  if (!['127.0.0.1', 'localhost'].includes(host)) {
    console.error(`Refusing to run: ${key} in .env.development.local is not local (${vars[key] || 'missing'}).`);
    process.exit(1);
  }
}
// The direct database connection (lib/db) must be local too; its host is shown, never its password
if (vars.DATABASE_URL) {
  const host = new URL(vars.DATABASE_URL).hostname;
  if (!['127.0.0.1', 'localhost'].includes(host)) {
    console.error(`Refusing to run: DATABASE_URL in .env.development.local is not local (${host}).`);
    process.exit(1);
  }
}
// Optional: reach Supabase through another local address, e.g. the proxy that switches the Data API off
// (tests/local-e2e/data-api-off-proxy.mjs). Local addresses only.
if (process.env.SUPABASE_URL_VIA) {
  const via = new URL(process.env.SUPABASE_URL_VIA);
  if (!['127.0.0.1', 'localhost'].includes(via.hostname)) {
    console.error(`Refusing to run: SUPABASE_URL_VIA is not local (${via.hostname}).`);
    process.exit(1);
  }
  vars.NEXT_PUBLIC_SUPABASE_URL = vars.SUPABASE_URL = via.origin;
}
for (const key of ['NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
  if (!vars[key]) { console.error(`Refusing to run: ${key} is missing from .env.development.local.`); process.exit(1); }
}

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) { console.error('Usage: node tests/local-e2e/with-local-env.mjs <command> [args...]'); process.exit(1); }
console.log(`Using local Supabase ${vars.NEXT_PUBLIC_SUPABASE_URL} for: ${[cmd, ...args].join(' ')}`);
const child = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, ...vars } });
child.on('exit', (code) => process.exit(code ?? 1));
