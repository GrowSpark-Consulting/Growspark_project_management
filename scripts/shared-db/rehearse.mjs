// Local rehearsal of the shared-database setup (Stage A). Uses ONLY the separate local Supabase stack in
// db/shared/rehearsal (project_id pm-shared-rehearsal, ports 563xx); never the developer's own local stack,
// never the shared database.
//
//   node scripts/shared-db/rehearse.mjs --rebuild         fresh database: mirror of today's shared state,
//                                                        roles.sql, the baseline (prisma migrate deploy as
//                                                        project_migrator), test-harness grants, file bucket
//   node scripts/shared-db/rehearse.mjs --rollback-test   rebuild, then prove rollback-baseline.sql and
//                                                        rollback-roles.sql return exactly to the mirror state,
//                                                        and that a failing baseline leaves nothing behind;
//                                                        ends rebuilt
// The stack must be running: npx supabase start --workdir db/shared/rehearsal -x studio,logflare,vector,edge-runtime,realtime,postgres-meta
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKDIR = 'db/shared/rehearsal';
const CONTAINER = 'supabase_db_pm-shared-rehearsal';
const API = 'http://127.0.0.1:56321';
const DB_PORT = 56322;
export const REHEARSAL = {
  api: API,
  migratorPassword: 'rehearsal-migrator',
  appPassword: 'rehearsal-only',
  bucket: 'pm-files',
  // Local Supabase CLI defaults (same for every local stack; not secrets)
  serviceKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU',
};
const log = (...a) => console.log(...a);
const sqlFile = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * Run SQL in the rehearsal database as a role, through psql inside the container. Stops on the first error.
 * Connects over the container's bridge address, not localhost, so the password is really checked
 * (local connections are trusted in the Supabase image).
 */
export function psql(sql, { role = 'postgres', password = 'postgres', quiet = true } = {}) {
  const host = execFileSync('docker', ['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', CONTAINER], { encoding: 'utf8' }).trim();
  const url = `postgresql://${role}:${encodeURIComponent(password)}@${host}:5432/postgres`;
  return execFileSync('docker', ['exec', '-i', CONTAINER, 'psql', url, '-v', 'ON_ERROR_STOP=1', '-X', '-At', ...(quiet ? ['-q'] : []), '-f', '-'],
    { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function resetStack() {
  log('Fresh database (supabase db reset on the rehearsal stack)…');
  execSync(`npx supabase db reset --workdir ${WORKDIR}`, { cwd: ROOT, stdio: 'ignore' });
}

async function waitForServices() {
  const admin = createClient(API, REHEARSAL.serviceKey, { auth: { persistSession: false } });
  for (let i = 0; i < 60; i++) {
    const [auth, storage] = await Promise.all([
      admin.auth.admin.listUsers({ perPage: 1 }).catch((e) => ({ error: e })),
      admin.storage.listBuckets().catch((e) => ({ error: e })),
    ]);
    if (!auth.error && !storage.error) return admin;
    if (i === 15) execSync('docker restart supabase_kong_pm-shared-rehearsal', { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('Auth or Storage did not come back after the reset');
}

function applyRoles() {
  const sql = sqlFile('db/shared/roles.sql').replaceAll('__MIGRATOR_PASSWORD__', REHEARSAL.migratorPassword);
  if (sql.includes('__MIGRATOR_PASSWORD__')) throw new Error('roles.sql: the password placeholder was not replaced');
  psql(sql);
}

function applyBaseline() {
  // The same command Stage B would run on the shared database, here against the rehearsal database
  execSync('npx prisma migrate deploy', {
    cwd: ROOT, stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: `postgresql://project_migrator:${REHEARSAL.migratorPassword}@127.0.0.1:${DB_PORT}/postgres?schema=project` },
  });
}

async function finish(admin) {
  psql(sqlFile('db/shared/rehearsal/harness.sql'));
  const { error } = await admin.storage.createBucket(REHEARSAL.bucket, { public: false });
  if (error && !/exists/i.test(error.message)) throw error;
  // PostgREST must see the new schema
  psql("NOTIFY pgrst, 'reload schema';");
}

export async function rebuild() {
  resetStack();
  const admin = await waitForServices();
  psql(sqlFile('db/shared/rehearsal/mirror.sql'));
  applyRoles();
  applyBaseline();
  await finish(admin);
  log('Rehearsal database ready: mirror + roles.sql + baseline + harness grants + private bucket');
}

/** What rollback must restore: roles and their attributes, memberships, schema rights, project's contents, sales. */
function snapshot() {
  return psql(`
    select 'role ' || rolname || ' login=' || rolcanlogin || ' bypassrls=' || rolbypassrls || ' connlimit=' || rolconnlimit || ' config=' || coalesce(array_to_string(rolconfig, ','), '')
      from pg_roles where rolname like 'project%' or rolname like 'sales%'
    union all select 'member ' || r.rolname || ' in ' || g.rolname from pg_auth_members m join pg_roles r on r.oid = m.member join pg_roles g on g.oid = m.roleid
      where r.rolname like 'project%' or g.rolname like 'project%'
    union all select 'schema ' || nspname || ' acl=' || coalesce(nspacl::text, '') from pg_namespace where nspname in ('project', 'sales')
    union all select 'project objects=' || count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'project'
    union all select 'project functions=' || count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'project'
    union all select 'project default acls=' || count(*) from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace where n.nspname = 'project'
    union all select 'sales rows=' || count(*) from sales.companies
    order by 1;`).trim();
}

const counts = () => psql(`select (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='project' and c.relkind='r' and c.relname <> '_prisma_migrations')
  || ' tables, ' || (select count(*) from pg_policies where schemaname='project') || ' policies, '
  || (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='project') || ' functions, '
  || (select count(*) from project.roles) || ' roles';`).trim();

export async function rollbackTest() {
  const results = [];
  const check = (name, ok, detail) => { results.push({ name, ok }); log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };

  resetStack();
  const admin = await waitForServices();
  psql(sqlFile('db/shared/rehearsal/mirror.sql'));
  const before = snapshot();

  // 1. A baseline that fails part-way leaves nothing behind (one transaction)
  applyRoles();
  const broken = sqlFile('prisma/migrations/20261124000000_project_baseline/migration.sql').replace(/\nCOMMIT;\s*$/, "\nSELECT 1 / 0; -- deliberate failure before COMMIT\nCOMMIT;\n");
  let failed = false;
  try { psql(broken, { role: 'project_migrator', password: REHEARSAL.migratorPassword }); } catch { failed = true; }
  const leftAfterFailure = psql("select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='project';").trim();
  check('failing baseline leaves nothing', failed && leftAfterFailure === '0', `failed: ${failed}, objects left in project: ${leftAfterFailure}`);

  // 2. The real baseline applies
  applyBaseline();
  const applied = counts();
  check('baseline applies', /^48 tables, 202 policies, 51 functions, 8 roles$/.test(applied), applied);

  // 3. rollback-baseline.sql (as project_migrator) empties project and keeps the roles
  psql(sqlFile('db/shared/rollback-baseline.sql'), { role: 'project_migrator', password: REHEARSAL.migratorPassword });
  const leftAfterBaselineRollback = psql("select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='project';").trim();
  const rolesKept = psql("select count(*) from pg_roles where rolname in ('project_migrator','project_user','project_anon','project_system');").trim();
  check('rollback-baseline empties project', leftAfterBaselineRollback === '0' && rolesKept === '4', `objects left: ${leftAfterBaselineRollback}, roles kept: ${rolesKept}`);

  // 4. The baseline can be applied again after its rollback (Prisma's history went with it)
  applyBaseline();
  check('baseline re-applies after rollback', counts() === applied, counts());

  // 5. Full rollback: baseline, then roles -> exactly the mirror state
  psql(sqlFile('db/shared/rollback-baseline.sql'), { role: 'project_migrator', password: REHEARSAL.migratorPassword });
  psql(sqlFile('db/shared/rollback-roles.sql'));
  const after = snapshot();
  check('full rollback returns to the starting state', after === before, after === before ? 'roles, memberships, schema rights, project and sales identical' : `before:\n${before}\nafter:\n${after}`);

  // Ready for the test suites again
  applyRoles();
  applyBaseline();
  await finish(admin);
  log(`Rollback test: ${results.filter((r) => r.ok).length}/${results.length} passed; rehearsal database rebuilt`);
  return results.every((r) => r.ok);
}

/**
 * Write .env.rehearsal.local (gitignored): the developer's local settings, pointed at the rehearsal stack and
 * set up as on the shared database: project_app login, project schema, the three request roles, an 8 s
 * statement timeout, and files through the R2 code path against the stack's S3-compatible storage endpoint.
 */
export function writeEnv() {
  const status = execSync(`npx supabase status --workdir ${WORKDIR} -o env`, { cwd: ROOT, encoding: 'utf8' });
  const s = Object.fromEntries([...status.matchAll(/^([A-Z0-9_]+)="?(.*?)"?$/gm)].map((m) => [m[1], m[2]]));
  const base = fs.readFileSync(path.join(ROOT, '.env.development.local'), 'utf8').split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l));
  const set = {
    NEXT_PUBLIC_SUPABASE_URL: API, SUPABASE_URL: API,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY: s.PUBLISHABLE_KEY, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: s.PUBLISHABLE_KEY,
    SUPABASE_SERVICE_ROLE_KEY: s.SERVICE_ROLE_KEY,
    DATABASE_URL: `postgresql://project_app:${REHEARSAL.appPassword}@127.0.0.1:${DB_PORT}/postgres`,
    DB_SCHEMA: 'project', DB_USER_ROLE: 'project_user', DB_ANON_ROLE: 'project_anon', DB_SYSTEM_ROLE: 'project_system',
    DB_STATEMENT_TIMEOUT_MS: '8000',
    R2_ENDPOINT: `${API}/storage/v1/s3`, R2_REGION: s.S3_PROTOCOL_REGION || 'local', R2_BUCKET: REHEARSAL.bucket,
    R2_ACCESS_KEY_ID: s.S3_PROTOCOL_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY: s.S3_PROTOCOL_ACCESS_KEY_SECRET,
    REHEARSAL: '1',
  };
  for (const [k, v] of Object.entries(set)) if (!v) throw new Error(`Rehearsal setting ${k} is empty (is the rehearsal stack running?)`);
  const lines = base.filter((l) => !(l.split('=')[0] in set)).concat(Object.entries(set).map(([k, v]) => `${k}=${v}`));
  fs.writeFileSync(path.join(ROOT, '.env.rehearsal.local'), `# Shared-database rehearsal (local only). Written by scripts/shared-db/rehearse.mjs --env\n${lines.join('\n')}\n`);
  log('Wrote .env.rehearsal.local');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (process.argv.includes('--env')) { writeEnv(); process.exit(0); }
  const run = process.argv.includes('--rollback-test') ? rollbackTest() : rebuild().then(() => true);
  run.then((ok) => process.exit(ok ? 0 : 1)).catch((e) => { console.error(e.stderr?.toString() || e.message || e); process.exit(1); });
}
