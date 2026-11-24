// Security checks for the shared-database setup, run against the local REHEARSAL database only
// (db/shared/rehearsal, port 56322). Connects as project_app, the app's own login, exactly as the app
// would on the shared database, and checks what it can and cannot reach:
//   - project_app alone: nothing in project, auth, extensions, sales, storage or public; no other roles
//   - request roles: no other app's schema; no schema changes
//   - row-level security per role: signed-in users see their own and shared rows only, across users and
//     across client accounts (the closest boundary to organizations until organization_id exists);
//     signed out sees no table; server jobs see everything
//   - trust: a user request cannot pass as a server job, even with forged claims
// Needs the rehearsal database rebuilt and the e2e personas seeded:
//   node scripts/shared-db/rehearse.mjs --rebuild && LOCAL_ENV_FILE=.env.rehearsal.local npm run e2e:local:seed
// Usage: node tests/shared-db/security.mjs
import pg from 'pg';

const HOST = '127.0.0.1', PORT = 56322;
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };
const section = (t) => console.log(`\n▸ ${t}`);

async function connect(user, password) {
  const c = new pg.Client({ host: HOST, port: PORT, database: 'postgres', user, password });
  await c.connect();
  return c;
}

/** Run fn inside a transaction that is always rolled back; returns { ok, rows, code, message }. */
async function attempt(c, sqls) {
  await c.query('begin');
  try {
    let res;
    for (const s of [].concat(sqls)) res = await (Array.isArray(s) ? c.query(s[0], s[1]) : c.query(s));
    return { ok: true, rows: res?.rows || [], count: res?.rowCount };
  } catch (e) {
    return { ok: false, code: e.code, message: e.message };
  } finally {
    await c.query('rollback').catch(() => {});
  }
}

const asRole = (role, userId, claimsRole) => [
  `set local role ${role}`,
  ...(userId !== undefined || claimsRole ? [[`select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true), set_config('request.jwt.claim.role', $3, true)`,
    [JSON.stringify({ sub: userId ?? undefined, role: claimsRole }), userId ?? '', claimsRole ?? '']]] : []),
];
const denied = (r) => !r.ok && r.code === '42501';

async function main() {
  const admin = await connect('postgres', 'postgres');
  const app = await connect('project_app', 'rehearsal-only');
  const id = async (email) => (await admin.query('select id from project.user_profiles where email = $1', [email])).rows[0]?.id;
  const P = {
    superadmin: await id('e2e.superadmin@example.com'), pm: await id('e2e.pm@example.com'), emp1: await id('e2e.emp1@example.com'),
    emp2: await id('e2e.emp2@example.com'), outsider: await id('e2e.outsider@example.com'),
    client: await id('e2e.client@example.com'), client2: await id('e2e.client2@example.com'),
  };
  if (Object.values(P).some((v) => !v)) throw new Error('Seed the e2e personas first (LOCAL_ENV_FILE=.env.rehearsal.local npm run e2e:local:seed)');

  section('project_app on its own reaches nothing');
  for (const [what, sql] of [
    ['project tables', 'select count(*) from project.projects'],
    ['project functions', 'select project.user_is_superadmin()'],
    ['auth.users', 'select count(*) from auth.users'],
    ['extensions', 'select extensions.uuid_generate_v4()'],
    ['sales (another app)', 'select count(*) from sales.companies'],
    ['storage.objects', 'select count(*) from storage.objects'],
    ['create in project', 'create table project.x (id int)'],
    ['create in public', 'create table public.x (id int)'],
  ]) {
    const r = await attempt(app, sql);
    check(`project_app: ${what} refused`, denied(r), r.ok ? 'ALLOWED' : r.code);
  }
  for (const role of ['postgres', 'authenticated', 'service_role', 'anon', 'project_migrator', 'sales_app', 'supabase_admin']) {
    const r = await attempt(app, `set local role ${role}`);
    check(`project_app cannot become ${role}`, !r.ok, r.ok ? 'ALLOWED' : r.code);
  }
  for (const role of ['project_user', 'project_anon', 'project_system']) {
    const r = await attempt(app, `set local role ${role}`);
    check(`project_app can switch to ${role}`, r.ok, r.ok ? '' : r.message);
  }

  section('Request roles stay inside project');
  for (const role of ['project_user', 'project_anon', 'project_system']) {
    for (const [what, sql] of [['auth.users', 'select count(*) from auth.users'], ['sales', 'select count(*) from sales.companies'], ['extensions', 'select extensions.uuid_generate_v4()'], ['schema change', 'create table project.x (id int)']]) {
      const r = await attempt(app, [...asRole(role, role === 'project_user' ? P.emp1 : undefined), sql]);
      check(`${role}: ${what} refused`, denied(r), r.ok ? 'ALLOWED' : r.code);
    }
  }

  section('Row-level security: signed-in users (project_user)');
  const total = async (table) => Number((await admin.query(`select count(*) from project.${table}`)).rows[0].count);
  const seen = async (userId, sql, params = []) => {
    const r = await attempt(app, [...asRole('project_user', userId, 'authenticated'), [sql, params]]);
    if (!r.ok) throw new Error(`${sql}: ${r.message}`);
    return r.rows;
  };
  // Own notifications only
  const notesAll = await total('notifications');
  const notesEmp1 = await seen(P.emp1, 'select user_id from project.notifications');
  check('notifications: only the user\'s own', notesEmp1.every((n) => n.user_id === P.emp1), `${notesEmp1.length} of ${notesAll} visible, all the user's own`);
  // Own time entries unless allowed to see others
  const teOther = await seen(P.emp1, 'select count(*)::int n from project.time_entries where user_id <> $1', [P.emp1]);
  check("time entries: an employee sees nobody else's", teOther[0].n === 0, `${teOther[0].n} others' entries visible`);
  // Projects: an outsider sees none of the e2e projects; superadmin sees all
  const projAll = await total('projects');
  const projOutsider = await seen(P.outsider, 'select count(*)::int n from project.projects');
  const projSuper = await seen(P.superadmin, 'select count(*)::int n from project.projects');
  check('projects: outsider sees none, superadmin sees all', projOutsider[0].n === 0 && projSuper[0].n === projAll, `outsider ${projOutsider[0].n}, superadmin ${projSuper[0].n} of ${projAll}`);
  // Cross-account (client accounts are the tenant-like boundary today)
  const accounts = (await admin.query("select id, name from project.accounts where name ilike any (array['%acme%','%globex%'])")).rows;
  const acme = accounts.find((a) => /acme/i.test(a.name)), globex = accounts.find((a) => /globex/i.test(a.name));
  const c1 = await seen(P.client, 'select distinct account_id from project.projects');
  const c2 = await seen(P.client2, 'select distinct account_id from project.projects');
  check('client of Acme sees no Globex project', acme && globex && !c1.some((r) => r.account_id === globex.id), `${c1.length} account(s) visible`);
  check('client of Globex sees no Acme project', acme && globex && !c2.some((r) => r.account_id === acme.id), `${c2.length} account(s) visible`);
  const crossAccounts = await seen(P.client, 'select count(*)::int n from project.accounts where id = $1', [globex?.id]);
  check("client of Acme cannot read Globex's account", crossAccounts[0].n === 0, `${crossAccounts[0].n} row(s)`);
  // Writes on someone else's rows change nothing
  const upd = await attempt(app, [...asRole('project_user', P.emp1, 'authenticated'), ["update project.user_profiles set name = 'hacked' where id = $1", [P.emp2]]]);
  check("cannot rename another user's profile", upd.ok ? upd.count === 0 : denied(upd), upd.ok ? `${upd.count} row(s) changed` : upd.code);
  const delNote = await attempt(app, [...asRole('project_user', P.emp1, 'authenticated'), ['delete from project.notifications where user_id <> $1', [P.emp1]]]);
  check("cannot delete another user's notifications", delNote.ok ? delNote.count === 0 : denied(delNote), delNote.ok ? `${delNote.count} row(s) deleted` : delNote.code);
  const projIns = await attempt(app, [...asRole('project_user', P.outsider, 'authenticated'), ["insert into project.projects (name, account_id, created_by, status) values ('x', $1, $2, 'planning')", [acme?.id, P.outsider]]]);
  check('an outsider cannot create a project in an account', !projIns.ok, projIns.ok ? 'ALLOWED' : projIns.code);
  // Privileged profile columns
  const priv = await attempt(app, [...asRole('project_user', P.emp1, 'authenticated'), ['update project.user_profiles set is_superadmin = true where id = $1', [P.emp1]], ['select is_superadmin from project.user_profiles where id = $1', [P.emp1]]]);
  check('cannot make themselves superadmin', priv.ok ? priv.rows[0]?.is_superadmin !== true : true, priv.ok ? `is_superadmin now ${priv.rows[0]?.is_superadmin}` : priv.code);
  // No claims: sees nothing private (fails closed)
  const noClaims = await attempt(app, ['set local role project_user', 'select count(*)::int n from project.time_entries']);
  check('a request without a user sees no time entries', noClaims.ok && noClaims.rows[0].n === 0, noClaims.ok ? `${noClaims.rows[0].n} rows` : noClaims.code);

  section('Signed out (project_anon) and server jobs (project_system)');
  for (const table of ['projects', 'user_profiles', 'time_entries', 'roles']) {
    const r = await attempt(app, [...asRole('project_anon', undefined, 'anon'), `select count(*) from project.${table}`]);
    check(`signed out: ${table} refused`, denied(r), r.ok ? 'ALLOWED' : r.code);
  }
  for (const table of ['projects', 'user_profiles', 'time_entries', 'notifications']) {
    const r = await attempt(app, ['set local role project_system', `select count(*)::int n from project.${table}`]);
    const t = await total(table);
    check(`server job sees all ${table}`, r.ok && r.rows[0].n === t, r.ok ? `${r.rows[0].n} of ${t}` : r.code);
  }

  section('Trust: a user request never passes as a server job');
  const trusted = async (steps) => { const r = await attempt(app, [...steps, 'select project.caller_is_trusted() t, project.request_role() r']); return r.ok ? r.rows[0] : { t: `error ${r.code}` }; };
  const tUser = await trusted(asRole('project_user', P.emp1, 'authenticated'));
  check('signed-in user: not trusted', tUser.t === false, `role ${tUser.r}`);
  const tForged = await trusted(asRole('project_user', P.emp1, 'service_role'));
  check('signed-in user claiming service_role: still not trusted', tForged.t === false, `role ${tForged.r}`);
  const tNoClaims = await trusted(['set local role project_user']);
  check('user role without claims: not trusted (fails closed)', tNoClaims.t === false, `role ${tNoClaims.r}`);
  const tAnon = await trusted(asRole('project_anon', undefined, 'anon'));
  check('signed out: not trusted', tAnon.t === false, `role ${tAnon.r}`);
  const tSystem = await trusted(['set local role project_system']);
  check('server job: trusted', tSystem.t === true, `role ${tSystem.r}`);
  // request_role() keeps the caller's role inside SECURITY DEFINER functions too
  const inDefiner = await attempt(app, [...asRole('project_user', P.emp1, 'authenticated'), 'select project.user_is_superadmin() s, current_setting(\'role\') r']);
  check('security-definer functions still see the user role', inDefiner.ok && inDefiner.rows[0].r === 'project_user', inDefiner.ok ? `role setting ${inDefiner.rows[0].r}` : inDefiner.code);

  await app.end(); await admin.end();
  const failed = results.filter((r) => !r.ok);
  console.log(`\nShared-database security (rehearsal): ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
