// Verifies the Project Management setup on the SHARED database (growspark-workspace) through the session
// pooler, signed in as project_app exactly as the app is. Read-only: every check runs in a transaction that
// is rolled back. Proves isolation (nothing outside project; no other role), per-role access, the
// request identity (current_user_id / request_role) and the trust rule. Row-level checks with data are in
// tests/shared-db/security.mjs (rehearsal), because the shared database starts empty.
//
// Usage: PROJECT_APP_URL="postgresql://project_app.<ref>:<password>@<pooler>:5432/postgres" node tests/shared-db/verify-shared.mjs
// (the URL comes from the private credentials file; never commit it)
import pg from 'pg';
import { randomUUID } from 'node:crypto';

const url = process.env.PROJECT_APP_URL;
if (!url || !/^postgres(ql)?:\/\/project_app\./.test(url)) { console.error('Set PROJECT_APP_URL to the project_app pooler URL'); process.exit(1); }
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };
const section = (t) => console.log(`\n▸ ${t}`);

const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
async function attempt(sqls) {
  await c.query('begin');
  try { let r; for (const s of sqls) r = Array.isArray(s) ? await c.query(s[0], s[1]) : await c.query(s); return { ok: true, rows: r?.rows || [] }; }
  catch (e) { return { ok: false, code: e.code, message: e.message }; }
  finally { await c.query('rollback').catch(() => {}); }
}
const claims = (uid, role) => [`select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true), set_config('request.jwt.claim.role', $3, true)`, [JSON.stringify({ sub: uid, role }), uid ?? '', role ?? '']];
const denied = (r) => !r.ok && r.code === '42501';

await c.connect();
const ssl = await c.query("select ssl from pg_stat_ssl where pid = pg_backend_pid()").catch(() => ({ rows: [] }));
console.log(`Connected as project_app through the pooler${ssl.rows[0] ? `, SSL ${ssl.rows[0].ssl}` : ''}`);

section('project_app on its own reaches nothing');
for (const [what, sql] of [['project tables', 'select count(*) from project.projects'], ['auth.users', 'select count(*) from auth.users'],
  ['extensions', 'select extensions.uuid_generate_v4()'], ['sales (another app)', 'select count(*) from sales.companies'],
  ['storage.objects', 'select count(*) from storage.objects'], ['create in project', 'create table project.x (id int)'], ['create in public', 'create table public.x (id int)']]) {
  const r = await attempt([sql]);
  check(`project_app: ${what} refused`, denied(r), r.ok ? 'ALLOWED' : r.code);
}
for (const role of ['postgres', 'authenticated', 'service_role', 'anon', 'project_migrator', 'sales_app']) {
  const r = await attempt([`set local role ${role}`]);
  check(`project_app cannot become ${role}`, !r.ok, r.ok ? 'ALLOWED' : r.code);
}

section('Request roles');
for (const role of ['project_user', 'project_anon', 'project_system']) {
  const r = await attempt([`set local role ${role}`]);
  check(`can switch to ${role}`, r.ok, r.ok ? '' : r.message);
  for (const [what, sql] of [['auth.users', 'select count(*) from auth.users'], ['sales', 'select count(*) from sales.companies'], ['schema change', 'create table project.x (id int)']]) {
    const x = await attempt([`set local role ${role}`, sql]);
    check(`${role}: ${what} refused`, denied(x), x.ok ? 'ALLOWED' : x.code);
  }
}
const sys = await attempt(['set local role project_system', "select (select count(*) from project.roles) roles, (select count(*) from project.app_settings) settings, (select count(*) from project.user_profiles) profiles"]);
check('server job reads the reference data', sys.ok && Number(sys.rows[0].roles) === 8 && Number(sys.rows[0].settings) === 1, sys.ok ? `${sys.rows[0].roles} roles, ${sys.rows[0].settings} settings row, ${sys.rows[0].profiles} profiles` : sys.code);
for (const table of ['projects', 'user_profiles', 'roles']) {
  const r = await attempt(['set local role project_anon', `select count(*) from project.${table}`]);
  check(`signed out: ${table} refused`, denied(r), r.ok ? 'ALLOWED' : r.code);
}
const uid = randomUUID();
const user = await attempt(['set local role project_user', claims(uid, 'authenticated'), 'select project.current_user_id()::text uid, project.request_role() role, (select count(*) from project.projects) projects, (select count(*) from project.roles) roles']);
check('signed-in user: identity from the request, no foreign rows', user.ok && user.rows[0].uid === uid && user.rows[0].role === 'authenticated' && Number(user.rows[0].projects) === 0,
  user.ok ? `uid matches, role ${user.rows[0].role}, ${user.rows[0].projects} projects, ${user.rows[0].roles} roles visible` : user.code);
const other = await attempt(['set local role project_user', claims(uid, 'authenticated'), 'select current_setting(\'request.jwt.claim.sub\', true) s']);
const after = await attempt(['select coalesce(current_setting(\'request.jwt.claim.sub\', true), \'\') s, current_user::text u']);
check('identity is transaction-local (nothing left on the connection)', other.ok && after.ok && after.rows[0].s === '' && after.rows[0].u === 'project_app', after.ok ? `after: sub "${after.rows[0].s}", user ${after.rows[0].u}` : after.code);

section('Trust: a user request never passes as a server job');
const trusted = async (steps) => { const r = await attempt([...steps, 'select project.caller_is_trusted() t, project.request_role() r']); return r.ok ? r.rows[0] : { t: `error ${r.code}` }; };
const tUser = await trusted(['set local role project_user', claims(uid, 'authenticated')]);
check('signed-in user: not trusted', tUser.t === false, `role ${tUser.r}`);
const tForged = await trusted(['set local role project_user', claims(uid, 'service_role')]);
check('user claiming service_role: still not trusted', tForged.t === false, `role ${tForged.r}`);
const tNone = await trusted(['set local role project_user']);
check('user role without claims: not trusted', tNone.t === false, `role ${tNone.r}`);
const tSys = await trusted(['set local role project_system']);
check('server job: trusted', tSys.t === true, `role ${tSys.r}`);

await c.end();
const failed = results.filter((ok) => !ok).length;
console.log(`\nShared database (growspark-workspace) verification: ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
