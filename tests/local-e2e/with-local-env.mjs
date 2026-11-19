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
for (const key of ['NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
  if (!vars[key]) { console.error(`Refusing to run: ${key} is missing from .env.development.local.`); process.exit(1); }
}

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) { console.error('Usage: node tests/local-e2e/with-local-env.mjs <command> [args...]'); process.exit(1); }
console.log(`Using local Supabase ${vars.NEXT_PUBLIC_SUPABASE_URL} for: ${[cmd, ...args].join(' ')}`);
const child = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, ...vars } });
child.on('exit', (code) => process.exit(code ?? 1));
