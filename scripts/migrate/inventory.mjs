// Read-only inventory of a Project Management database, run before any data migration.
//
// Reports: rows per table, people and test accounts, duplicate emails and department names, permission
// keys the app does not know, pending invitations and stored files. It opens a READ ONLY transaction,
// so it cannot change anything. Each check is skipped (and says so) when its table or column is missing,
// because the database being inventoried may be on an older schema.
//
// Usage: npm run db:inventory                       (DATABASE_URL from the environment or .env.development.local)
//        npm run db:inventory -- --allow-remote     (a non-local database, e.g. the hosted project)
//        npm run db:inventory -- --json --show-emails --schema public
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import pg from 'pg';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
config({ path: path.join(ROOT, '.env.development.local'), quiet: true });

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const schema = option('schema', 'public');
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set.'); process.exit(1); }
const host = new URL(url).hostname;
if (!['127.0.0.1', 'localhost'].includes(host) && !flag('allow-remote')) {
  console.error(`Refusing to read ${host}: pass --allow-remote to inventory a non-local database (read-only).`);
  process.exit(1);
}
if (!/^[a-z_][a-z0-9_]*$/.test(schema)) { console.error('Invalid --schema'); process.exit(1); }

const mask = (email) => {
  if (flag('show-emails')) return email;
  const [user, domain] = String(email).split('@');
  return `${user.slice(0, 2)}***@${domain ?? '?'}`;
};
const knownPermissions = new Set(
  [...fs.readFileSync(path.join(ROOT, 'lib', 'permissions.ts'), 'utf8').matchAll(/^\s+[A-Z_]+ = '([a-z_]+)'/gm)].map((m) => m[1]),
);

const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10000 });
const report = { database: host, schema, at: new Date().toISOString(), checks: {} };
const check = async (name, fn) => {
  try {
    report.checks[name] = await fn();
  } catch (e) {
    report.checks[name] = { skipped: e.message.split('\n')[0] };
    await client.query('rollback to savepoint inv').catch(() => {});
  }
  await client.query('savepoint inv');
};
const q = async (sql, params) => (await client.query(sql, params)).rows;

await client.connect();
try {
  await client.query('begin transaction read only');
  await client.query("set local statement_timeout = '30s'");
  await client.query('savepoint inv');

  await check('rows per table', async () => {
    const tables = await q(`select table_name from information_schema.tables where table_schema = $1 and table_type = 'BASE TABLE' order by 1`, [schema]);
    const out = {};
    for (const { table_name } of tables) {
      out[table_name] = Number((await q(`select count(*) as n from "${schema}"."${table_name.replace(/"/g, '""')}"`))[0].n);
    }
    return out;
  });
  await check('people', async () => {
    const [r] = await q(`select (select count(*) from auth.users) as auth_users,
      (select count(*) from "${schema}".user_profiles) as profiles,
      (select count(*) from auth.users where email ilike '%@example.com' or email ilike '%@test.local') as test_accounts,
      (select count(*) from "${schema}".user_profiles where is_active = false) as deactivated`);
    return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)]));
  });
  await check('duplicate emails (ignoring case and spaces)', async () => {
    const rows = await q(`select lower(trim(email)) as email, count(*) as n from auth.users where email is not null group by 1 having count(*) > 1`);
    return rows.map((r) => `${mask(r.email)} x${r.n}`);
  });
  await check('duplicate department names', async () => {
    const rows = await q(`select lower(trim(name)) as name, count(*) as n from "${schema}".departments group by 1 having count(*) > 1`);
    return rows.map((r) => `${r.name} x${r.n}`);
  });
  await check('permission keys the app does not know', async () => {
    const rows = await q(`select distinct jsonb_object_keys(permissions) as key from "${schema}".roles where jsonb_typeof(permissions) = 'object'`);
    return rows.map((r) => r.key).filter((k) => !knownPermissions.has(k));
  });
  await check('pending invitations', async () => {
    const [r] = await q(`select count(*) as n from "${schema}".user_invitations where accepted_at is null and (expires_at is null or expires_at > now())`);
    return Number(r.n);
  });
  await check('stored files by bucket', async () => {
    const rows = await q(`select bucket_id, count(*) as files, coalesce(sum((metadata->>'size')::bigint), 0) as bytes from storage.objects group by 1 order by 1`);
    return Object.fromEntries(rows.map((r) => [r.bucket_id, { files: Number(r.files), bytes: Number(r.bytes) }]));
  });
  await client.query('rollback');
} finally {
  await client.end();
}

if (flag('json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Inventory of ${report.database}, schema ${schema} (read-only), ${report.at}`);
  for (const [name, value] of Object.entries(report.checks)) {
    console.log(`\n${name}:`);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if ('skipped' in value) { console.log(`  skipped: ${value.skipped}`); continue; }
      if (!Object.keys(value).length) console.log('  none');
      for (const [k, v] of Object.entries(value)) console.log(`  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
    } else if (Array.isArray(value)) {
      console.log(value.length ? value.map((v) => `  ${v}`).join('\n') : '  none');
    } else {
      console.log(`  ${value}`);
    }
  }
}
