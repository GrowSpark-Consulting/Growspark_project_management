// Batch E of Phase 11: the signed-in user's profile, the browser's permission checks and the superadmin
// / database-status tools moved behind API endpoints. After this batch the browser makes no request to
// the Supabase data API at all.
//
// Checked against the same lookups run straight on the data API as the same user; the superadmin role
// tools are allowed and refused as row-level security decides, and change nothing when refused; and in a
// real browser, the main pages make no data API request at all.
//
// NON-DESTRUCTIVE: reads only, except refused role changes (verified unchanged) and one profile-creation
// test that row-level security refuses. Local Supabase only (app on port 3100). Needs the seeded personas.
//
// Usage: node tests/local-e2e/browser-reads-e.mjs
import { chromium } from '@playwright/test';
import { loadEnv, adminClient, signIn, call, Report, chromePath } from './lib.mjs';
import { PERSONAS } from './seed.mjs';

const env = loadEnv();
const admin = adminClient(env);
const report = new Report('Browser reads moved to the API (batch E)');
const WHO = ['superadmin', 'pm', 'emp1', 'outsider', 'client'];
const S = {};
const PROJECT = '0e2e0000-0000-4000-8000-00000000b001';
const PROFILE_SELECT = `*, user_roles!user_roles_user_id_fkey ( id, role_id, assigned_at, assigned_by,
  roles!user_roles_role_id_fkey ( id, name, department_id, permissions, is_system_role, departments!roles_department_id_fkey ( id, name, description ) ) )`;

const norm = (v) => Array.isArray(v) ? v.map(norm).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])])) : v;
const eq = (a, b) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));
const body = (r) => r.body?.data;

async function main() {
  for (const key of WHO) S[key] = await signIn(env, PERSONAS[key].email);
  const { data: account } = await admin.from('accounts').select('id').limit(1).single();
  const { data: run } = await admin.from('workflow_instances').select('id').limit(1).single();

  report.start('Signed out and bad input');
  report.status('profile signed out', await call(env, null, 'GET', '/api/me/profile'), 401);
  report.status('access signed out', await call(env, null, 'GET', '/api/me/access?check=account-manager'), 401);
  report.status('diagnostics signed out', await call(env, null, 'POST', '/api/admin/diagnostics', { action: 'check-schema' }), 401);
  report.status('diagnostics client account', await call(env, S.client, 'POST', '/api/admin/diagnostics', { action: 'check-schema' }), 403);
  report.status('bad access check', await call(env, S.pm, 'GET', '/api/me/access?check=everything'), 400);
  report.status('bad project id', await call(env, S.pm, 'GET', `/api/me/access?check=project&userId=${S.pm.userId}&projectId=1;drop`), 400);
  report.status('bad diagnostics action', await call(env, S.superadmin, 'POST', '/api/admin/diagnostics', { action: 'drop-everything' }), 400);

  for (const key of WHO) {
    const who = S[key];
    const db = who.db;
    report.start(`Same results as the data API, as ${key}`);

    const p = await call(env, who, 'GET', '/api/me/profile');
    const pd = (await db.from('user_profiles').select(PROFILE_SELECT).eq('id', who.userId).single()).data;
    const dm = (await db.from('department_members').select('department_id, departments!department_members_department_id_fkey(id, name)').eq('user_id', who.userId)).data || [];
    const { department_members: gotMembers, ...gotProfile } = body(p) || {};
    report.record('profile', p.status === 200 && eq(gotProfile, pd) && (gotMembers || []).length === dm.length,
      `${pd?.user_roles?.length} role(s), ${dm.length} direct department(s)${pd?.is_client ? ', client account' : ''}`);

    if (key === 'client') {
      report.status('access client account', await call(env, who, 'GET', '/api/me/access?check=account-manager'), 200, '(checks are allowed for every signed-in account, as before)');
      continue;
    }

    const ap = await call(env, who, 'GET', `/api/me/access?check=project&userId=${who.userId}&projectId=${PROJECT}`);
    const proj = (await db.from('projects').select('created_by, assigned_user_id').eq('id', PROJECT).maybeSingle()).data;
    const onTeam = ((await db.from('project_assignments').select('id').eq('user_id', who.userId).eq('project_id', PROJECT).is('removed_at', null)).data || []).length > 0;
    const onTask = ((await db.from('tasks').select('id').eq('assigned_to', who.userId).eq('project_id', PROJECT).limit(1)).data || []).length > 0;
    const wantProject = !!proj && (proj.created_by === who.userId || proj.assigned_user_id === who.userId) || onTeam || onTask;
    report.record('project access', ap.status === 200 && body(ap) === wantProject, `on the project: ${body(ap)}`);

    const aa = await call(env, who, 'GET', `/api/me/access?check=account&userId=${who.userId}&accountId=${account.id}`);
    report.record('account access', aa.status === 200 && typeof body(aa) === 'boolean', `account access: ${body(aa)}`);

    const am = await call(env, who, 'GET', '/api/me/access?check=account-manager');
    const manages = ((await db.from('accounts').select('id').eq('account_manager_id', who.userId).limit(1)).data || []).length > 0;
    report.record('account manager', am.status === 200 && body(am) === manages, `manages an account: ${body(am)}`);

    const roleIds = (pd?.user_roles || []).map((r) => r.role_id);
    const rr = await call(env, who, 'GET', `/api/me/access?check=roles&roleIds=${roleIds.join(',')}`);
    const rd = roleIds.length ? (await db.from('roles').select('id, name, permissions').in('id', roleIds)).data : [];
    report.record('role permissions', rr.status === 200 && eq(body(rr), rd), `${rd.length} role(s)`);

    const pa = await call(env, who, 'GET', `/api/me/access?check=project-account&projectId=${PROJECT}`);
    report.record('project account', pa.status === 200 && body(pa) === (proj ? (await db.from('projects').select('account_id').eq('id', PROJECT).single()).data?.account_id ?? null : null), `${body(pa) ? 'account found' : 'not visible'}`);

    const wn = await call(env, who, 'GET', `/api/me/access?check=workflow-node&workflowInstanceId=${run.id}`);
    report.record('workflow step access', wn.status === 200 && typeof body(wn) === 'boolean', `may act on the current step: ${body(wn)}`);
  }

  report.start('Superadmin tools and database status (run on the server as the user)');
  const sch = await call(env, S.superadmin, 'POST', '/api/admin/diagnostics', { action: 'check-schema' });
  report.record('check-schema', sch.status === 200 && body(sch)?.success === true && body(sch)?.details?.length === 3, `${body(sch)?.details?.map((d) => `${d.table}: ${d.exists ? 'ok' : 'missing'}`).join(', ')}`);
  const con = await call(env, S.superadmin, 'POST', '/api/admin/diagnostics', { action: 'test-connection' });
  report.record('test-connection', con.status === 200 && body(con)?.success === true, `departments read, Superadmin role ${body(con)?.data?.superadminRole ? 'found' : 'not found'}`);
  const chk = await call(env, S.superadmin, 'POST', '/api/admin/diagnostics', { action: 'check-superadmin', email: PERSONAS.superadmin.email });
  report.record('check-superadmin', chk.status === 200 && typeof body(chk)?.success === 'boolean', body(chk)?.message || '');

  // An employee tries to make a colleague superadmin: row-level security refuses it and nothing changes
  const before = (await admin.from('user_roles').select('id', { count: 'exact', head: true }).eq('user_id', S.emp1.userId)).count;
  const asg = await call(env, S.emp1, 'POST', '/api/admin/diagnostics', { action: 'assign-superadmin', email: PERSONAS.emp1.email });
  const after = (await admin.from('user_roles').select('id', { count: 'exact', head: true }).eq('user_id', S.emp1.userId)).count;
  report.record('assign-superadmin refused for an employee', asg.status === 200 && body(asg)?.success === false && before === after, `${body(asg)?.message}; roles unchanged (${after})`);
  const rem = await call(env, S.emp1, 'POST', '/api/admin/diagnostics', { action: 'remove-superadmin', email: PERSONAS.superadmin.email });
  const stillSa = ((await admin.from('user_roles').select('id, roles!inner(name)').eq('user_id', S.superadmin.userId).eq('roles.name', 'Superadmin')).data || []).length;
  report.record('remove-superadmin has no effect for an employee', rem.status === 200 && stillSa > 0, `${body(rem)?.message}; the superadmin keeps the role`);
  const tpc = await call(env, S.emp1, 'POST', '/api/admin/diagnostics', { action: 'test-profile-creation', userId: '00000000-0000-4000-8000-00000000ffff', email: 'nobody@example.com', name: 'Nobody' });
  const created = (await admin.from('user_profiles').select('id').eq('id', '00000000-0000-4000-8000-00000000ffff').maybeSingle()).data;
  if (created) await admin.from('user_profiles').delete().eq('id', created.id);
  report.record('test-profile-creation refused', tpc.status === 200 && body(tpc)?.success === false && !created, body(tpc)?.error || '');

  report.start('Browser: no request to the data API at all');
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
  try {
    for (const [key, pagePath] of [['pm', '/dashboard'], ['pm', '/projects'], ['pm', `/projects/${PROJECT}`], ['emp1', '/time-entries'],
      ['superadmin', `/accounts/${account.id}`], ['superadmin', '/admin/roles'], ['superadmin', '/admin/database'], ['client', '/client-portal']]) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await ctx.addCookies(S[key].cookie.split('; ').map((kv) => { const i = kv.indexOf('='); return { name: kv.slice(0, i), value: kv.slice(i + 1), url: env.appUrl }; }));
      const page = await ctx.newPage();
      const direct = [];
      const errors = [];
      page.on('request', (r) => { if (r.url().includes('/rest/v1/')) direct.push(decodeURIComponent(r.url().split('/rest/v1/')[1]).slice(0, 80)); });
      page.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 500) errors.push(`${r.status()} ${new URL(r.url()).pathname}`); });
      await page.goto(env.appUrl + pagePath, { waitUntil: 'load' });
      await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});
      const heading = (await page.locator('h1, h2').first().textContent({ timeout: 5000 }).catch(() => '')) || '';
      report.record(`${pagePath} as ${key}`, direct.length === 0 && errors.length === 0 && heading.trim().length > 0,
        `"${heading.trim().slice(0, 40)}"; ${direct.length} data API request(s)${direct.length ? `: ${[...new Set(direct)].slice(0, 3).join(' | ')}` : ''}${errors.length ? `; API errors: ${errors.join(', ')}` : ''}`);
      await ctx.close();
    }
  } finally {
    await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 15000))]);
  }
}

main()
  .catch((e) => report.error('run', e))
  .finally(() => process.exit(report.summary() ? 1 : 0));
