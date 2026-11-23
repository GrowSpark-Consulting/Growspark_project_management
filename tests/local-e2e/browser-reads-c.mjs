// Batch C of Phase 11: accounts, departments, org chart, projects list and admin time tracking moved
// behind API endpoints.
//
// Each endpoint runs the lookups the browser used to run, as the signed-in user, so row-level security
// still decides. Checked here by running the same lookups straight against the Supabase data API as the
// same user and comparing, for several personas; the writes are checked to be allowed and refused
// exactly as the data API allows and refuses them; and in a real browser, that the pages make no direct
// database requests for these tables.
//
// NON-DESTRUCTIVE: a temporary department with roles, a project issue and milestones are created and
// removed. Local Supabase only (app on port 3100). Needs the seeded personas: npm run e2e:local:seed
//
// Usage: node tests/local-e2e/browser-reads-c.mjs
import { chromium } from '@playwright/test';
import { loadEnv, adminClient, signIn, call, Report, chromePath } from './lib.mjs';
import { PERSONAS } from './seed.mjs';

const env = loadEnv();
const admin = adminClient(env);
const report = new Report('Browser reads moved to the API (batch C)');
const WHO = ['superadmin', 'pm', 'emp1', 'outsider'];
const S = {};
const RUN = `brc-${Date.now().toString(36)}`;
const made = { departments: [], roles: [], issues: [], milestones: [] };

// Compared without regard to key order inside objects (the data API orders some nested keys differently)
const norm = (v) => Array.isArray(v) ? v.map(norm) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])])) : v;
const eq = (a, b) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));
const canon = (rows) => JSON.stringify((rows || []).map((r) => JSON.stringify(norm(r))).sort());
const same = (a, b) => canon(a) === canon(b);
const body = (r) => r.body?.data;
const ISSUE_SELECT = '*, user_profiles:created_by(id, name, email, image), resolver_profiles:resolved_by(id, name, email, image)';

async function setUp() {
  const { data: dept, error } = await admin.from('departments').insert({ name: `Dept ${RUN}`, description: 'temporary' }).select().single();
  if (error) throw new Error(`department: ${error.message}`);
  made.departments.push(dept.id);
  const { data: role, error: rErr } = await admin.from('roles').insert({ name: `Role ${RUN}`, department_id: dept.id, permissions: { view_projects: true } }).select().single();
  if (rErr) throw new Error(`role: ${rErr.message}`);
  made.roles.push(role.id);
  await admin.from('user_roles').insert({ user_id: S.emp1.userId, role_id: role.id });
  const { data: project } = await admin.from('projects').select('id').eq('id', '0e2e0000-0000-4000-8000-00000000b001').maybeSingle();
  const { data: anyProject } = await admin.from('projects').select('id').neq('status', 'complete').limit(1).single();
  const { data: issue, error: iErr } = await admin.from('project_issues')
    .insert({ project_id: (project || anyProject).id, content: `Issue ${RUN}`, created_by: S.pm.userId, status: 'open' }).select('id').single();
  if (iErr) throw new Error(`issue: ${iErr.message}`);
  made.issues.push(issue.id);
  return { dept, role };
}

async function cleanUp() {
  const problems = [];
  if (made.issues.length) { const { error } = await admin.from('project_issues').delete().in('id', made.issues); if (error) problems.push(error.message); }
  { const { error } = await admin.from('milestones').delete().like('name', `${RUN}%`); if (error) problems.push(error.message); }
  const { data: roles } = await admin.from('roles').select('id').in('department_id', made.departments.length ? made.departments : ['00000000-0000-0000-0000-000000000000']);
  const roleIds = [...new Set([...made.roles, ...(roles || []).map((r) => r.id)])];
  if (roleIds.length) {
    await admin.from('user_roles').delete().in('role_id', roleIds);
    const { error } = await admin.from('roles').delete().in('id', roleIds); if (error) problems.push(error.message);
  }
  if (made.departments.length) { const { error } = await admin.from('departments').delete().in('id', made.departments); if (error) problems.push(error.message); }
  const left = [
    (await admin.from('departments').select('id', { count: 'exact', head: true }).like('name', `%${RUN}%`)).count,
    (await admin.from('roles').select('id', { count: 'exact', head: true }).like('name', `%${RUN}%`)).count,
    (await admin.from('milestones').select('id', { count: 'exact', head: true }).like('name', `${RUN}%`)).count,
    (await admin.from('project_issues').select('id', { count: 'exact', head: true }).like('content', `%${RUN}%`)).count,
  ];
  report.record('cleanup', problems.length === 0 && left.every((n) => n === 0), problems.join('; ') || 'temporary department, roles, issue and milestones removed');
}

async function main() {
  for (const key of [...WHO, 'client']) S[key] = await signIn(env, PERSONAS[key].email);
  const temp = await setUp();
  try { await checks(temp); } finally { await cleanUp(); }
}

// The account page's issue lookup, run straight on the data API as the user
async function accountIssuesDirect(db, accountId) {
  const { data: projects } = await db.from('projects').select('id, name').eq('account_id', accountId);
  if (!projects?.length) return [];
  const { data } = await db.from('project_issues').select(ISSUE_SELECT).in('project_id', projects.map((p) => p.id)).in('status', ['open', 'in_progress']).order('created_at', { ascending: false });
  return (data || []).map((i) => ({ ...i, project: projects.find((p) => p.id === i.project_id) }));
}

// The department page's issue lookup, run straight on the data API as the user
async function departmentIssuesDirect(db, departmentId) {
  const { data: roles } = await db.from('roles').select('id').eq('department_id', departmentId);
  if (!roles?.length) return [];
  const { data: ur } = await db.from('user_roles').select('user_id').in('role_id', roles.map((r) => r.id));
  const userIds = [...new Set((ur || []).map((u) => u.user_id))];
  if (!userIds.length) return [];
  const { data: pa } = await db.from('project_assignments').select('project_id, projects ( id, name )').in('user_id', userIds).is('removed_at', null);
  const projects = new Map();
  for (const a of pa || []) if (a.projects && !projects.has(a.projects.id)) projects.set(a.projects.id, a.projects);
  if (!projects.size) return [];
  const { data } = await db.from('project_issues').select(ISSUE_SELECT).in('project_id', [...projects.keys()]).in('status', ['open', 'in_progress']).order('created_at', { ascending: false });
  return (data || []).map((i) => { const p = projects.get(i.project_id); return { ...i, project: p ? { id: p.id, name: p.name } : undefined }; });
}

async function checks({ dept, role }) {
  const { data: accounts } = await admin.from('accounts').select('id');
  const { data: departments } = await admin.from('departments').select('id');
  const { data: roles } = await admin.from('roles').select('id');

  report.start('Signed out, client accounts and bad input');
  const reads = [`/api/accounts/${accounts[0].id}/issues`, `/api/departments/${dept.id}/issues`, `/api/accounts/${accounts[0].id}/finished-projects`, '/api/milestones',
    '/api/projects/list', '/api/org-structure/chart?view=hierarchy', `/api/roles/${role.id}`, `/api/departments/${dept.id}`, '/api/admin/time-tracking/filters'];
  for (const url of reads) report.status(`signed-out ${url.split('?')[0]}`, await call(env, null, 'GET', url), 401);
  for (const url of reads.filter((u) => !u.startsWith('/api/roles/'))) report.status(`client ${url.split('?')[0]}`, await call(env, S.client, 'GET', url), 403);
  report.status('bad-account-id', await call(env, S.pm, 'GET', '/api/accounts/not-a-uuid/issues'), 400);
  report.status('bad-chart-view', await call(env, S.pm, 'GET', '/api/org-structure/chart?view=everything'), 400);
  report.status('bad-milestone', await call(env, S.superadmin, 'POST', '/api/milestones', { name: '', date: 'tomorrow' }), 400);
  report.status('bad-department-name', await call(env, S.superadmin, 'PATCH', `/api/departments/${dept.id}`, { name: '   ' }), 400);

  for (const key of WHO) {
    const who = S[key];
    const db = who.db;
    report.start(`Same results as the data API, as ${key}`);

    let okAccounts = true, okFinished = true;
    for (const a of accounts) {
      const r = await call(env, who, 'GET', `/api/accounts/${a.id}/issues`);
      if (r.status !== 200 || !same(body(r), await accountIssuesDirect(db, a.id))) okAccounts = false;
      const f = await call(env, who, 'GET', `/api/accounts/${a.id}/finished-projects`);
      const fd = await db.from('projects').select('*, account:accounts(id, name)').eq('account_id', a.id).eq('status', 'complete').order('updated_at', { ascending: false });
      if (f.status !== 200 || JSON.stringify(body(f)) !== JSON.stringify(fd.data)) okFinished = false;
    }
    report.record('account-issues', okAccounts, `${accounts.length} account(s)`);
    report.record('finished-projects', okFinished, `${accounts.length} account(s), same order`);

    let okDept = true, n = 0;
    for (const d of departments) {
      const r = await call(env, who, 'GET', `/api/departments/${d.id}/issues`);
      const want = await departmentIssuesDirect(db, d.id);
      n += want.length;
      if (r.status !== 200 || !same(body(r), want)) okDept = false;
    }
    report.record('department-issues', okDept, `${departments.length} department(s), ${n} issue(s)`);

    const ms = await call(env, who, 'GET', '/api/milestones');
    const msd = await db.from('milestones').select('*').order('date', { ascending: true });
    report.record('milestones', ms.status === 200 && same(body(ms), msd.data), `${body(ms)?.length} milestone(s)`);

    const tt = await call(env, who, 'GET', '/api/admin/time-tracking/filters');
    const [ttu, ttp] = await Promise.all([db.from('user_profiles').select('id, name').order('name'), db.from('projects').select('id, name').order('name')]);
    report.record('time-tracking-filters', tt.status === 200 && JSON.stringify(body(tt)?.users) === JSON.stringify(ttu.data) && JSON.stringify(body(tt)?.projects) === JSON.stringify(ttp.data), `${body(tt)?.users?.length} people, ${body(tt)?.projects?.length} projects`);

    // Projects page: visible open projects (all of them with view-all, else created/lead/assigned/tasks)
    const list = await call(env, who, 'GET', '/api/projects/list');
    const visible = (await db.from('projects').select('id').neq('status', 'complete').is('archived_at', null)).data.map((p) => p.id);
    const [d1, d2, d3] = await Promise.all([
      db.from('projects').select('id').or(`created_by.eq.${who.userId},assigned_user_id.eq.${who.userId}`),
      db.from('project_assignments').select('project_id').eq('user_id', who.userId).is('removed_at', null),
      db.from('tasks').select('project_id').eq('assigned_to', who.userId),
    ]);
    const mine = new Set([...(d1.data || []).map((p) => p.id), ...(d2.data || []).map((p) => p.project_id), ...(d3.data || []).map((t) => t.project_id)]);
    const got = (body(list) || []).map((p) => p.id).sort();
    const ownList = visible.filter((id) => mine.has(id)).sort();
    const matches = JSON.stringify(got) === JSON.stringify(visible.sort()) ? 'all visible (view-all)' : JSON.stringify(got) === JSON.stringify(ownList) ? 'own projects' : null;
    const team = (await db.from('project_assignments').select('project_id, user_id').in('project_id', got).is('removed_at', null)).data || [];
    const teamOk = (body(list) || []).every((p) => JSON.stringify(p.assigned_users.map((u) => u.id).sort()) === JSON.stringify([...new Set(team.filter((t) => t.project_id === p.id).map((t) => t.user_id))].sort()));
    report.record('projects-list', list.status === 200 && !!matches && teamOk, `${got.length} project(s): ${matches || 'MISMATCH'}; teams match`);

    // Org chart
    let okRoleUsers = true;
    for (const r of roles.slice(0, 12)) {
      const a = await call(env, who, 'GET', `/api/org-structure/chart?view=role-users&roleId=${r.id}`);
      const dd = await db.from('user_roles').select('user_profiles!user_roles_user_id_fkey(*)').eq('role_id', r.id);
      if (a.status !== 200 || !same(body(a), (dd.data || []).map((x) => x.user_profiles).filter(Boolean))) okRoleUsers = false;
    }
    report.record('org-role-users', okRoleUsers, `${Math.min(roles.length, 12)} role(s)`);
    const st = await call(env, who, 'GET', '/api/org-structure/chart?view=structure');
    const sd = await db.from('departments').select('id').order('name');
    report.record('org-structure', st.status === 200 && JSON.stringify((body(st)?.departments || []).map((d) => d.id)) === JSON.stringify((sd.data || []).map((d) => d.id)), `${body(st)?.departments?.length} department(s)`);
    const hv = await call(env, who, 'GET', '/api/org-structure/chart?view=hierarchy');
    report.record('org-hierarchy', hv.status === 200 && Array.isArray(body(hv)?.nodes), `${body(hv)?.nodes?.length} top-level node(s)`);

    // The role panel's lookups, straight on the data API (the role lookup fails there too: known issue)
    const rd = await call(env, who, 'GET', `/api/roles/${role.id}`);
    const rdUsers = (await db.from('user_roles').select('user_id').eq('role_id', role.id)).data || [];
    const rdRole = await db.from('roles').select('*, department:departments!roles_department_id_fkey(id, name), reporting_role:roles!roles_reporting_role_id_fkey(id, name)').eq('id', role.id).single();
    const roleOk = rdRole.error ? body(rd)?.role === null : body(rd)?.role?.id === role.id;
    report.record('role-details', rd.status === 200 && roleOk && (body(rd)?.users || []).length === rdUsers.length,
      `role ${rdRole.error ? `not loaded on either path (${rdRole.error.code})` : 'loaded'}, ${rdUsers.length} person(s)`);

    const da = await call(env, who, 'GET', `/api/departments/${dept.id}`);
    const [dr, du, dd] = await Promise.all([
      db.from('roles').select('*, user_roles!user_roles_role_id_fkey(count)').eq('department_id', dept.id).order('name'),
      db.from('user_profiles').select('id, name, email, image, user_roles!user_roles_user_id_fkey ( id, role_id, roles!user_roles_role_id_fkey ( id, name, department_id ) )').order('name'),
      db.from('departments').select('*').eq('id', dept.id).maybeSingle(),
    ]);
    report.record('department-admin-data', da.status === 200 && eq(body(da)?.roles, dr.data) && eq(body(da)?.users, du.data) && eq(body(da)?.department, dd.data),
      `${body(da)?.roles?.length} role(s), ${body(da)?.users?.length} people`);
  }

  report.start('Writes: allowed and refused as row-level security decides');
  for (const key of ['emp1', 'superadmin']) {
    const who = S[key];
    // Department rename: would the data API let this user update the row? (no-op update, nothing changes)
    const may = ((await who.db.from('departments').update({ description: 'temporary' }).eq('id', dept.id).select('id')).data || []).length === 1;
    const r = await call(env, who, 'PATCH', `/api/departments/${dept.id}`, { name: `Dept ${RUN} ${key}`, description: 'temporary' });
    report.record(`department-rename ${key}`, may ? r.status === 200 && body(r)?.name === `Dept ${RUN} ${key}` : [403, 404].includes(r.status), may ? 'renamed' : `refused (${r.status})`);

    const probe = await who.db.from('roles').insert({ name: `Probe ${RUN} ${key}`, department_id: dept.id, permissions: {} }).select('id');
    if (probe.data?.length) { made.roles.push(probe.data[0].id); }
    const mayRole = !probe.error && probe.data?.length === 1;
    const cr = await call(env, who, 'POST', `/api/departments/${dept.id}/roles`, { name: `Made ${RUN} ${key}`, permissions: { view_projects: true } });
    if (body(cr)?.id) made.roles.push(body(cr).id);
    report.record(`department-role-create ${key}`, mayRole ? cr.status === 201 && body(cr)?.department_id === dept.id : cr.status === 403, mayRole ? 'created' : `refused (${cr.status})`);
    if (cr.status === 201) {
      const up = await call(env, who, 'PATCH', `/api/departments/${dept.id}/roles`, { roleId: body(cr).id, name: `Made ${RUN} ${key} 2`, permissions: { view_projects: false } });
      report.record(`department-role-update ${key}`, up.status === 200 && body(up)?.name === `Made ${RUN} ${key} 2`, 'renamed');
    }

    const pr = await call(env, who, 'PATCH', `/api/roles/${role.id}`, { name: `Role ${RUN} ${key}`, is_system_role: true, hierarchy_level: 3 });
    const after = (await admin.from('roles').select('name, is_system_role, hierarchy_level').eq('id', role.id).single()).data;
    report.record(`role-update ${key}`, key === 'superadmin' ? pr.status === 200 && after.name === `Role ${RUN} ${key}` && after.is_system_role === false && after.hierarchy_level === 3 : pr.status === 403,
      key === 'superadmin' ? `renamed; is_system_role ignored (${after.is_system_role})` : `refused (${pr.status})`);

    const msProbe = await who.db.from('milestones').insert({ name: `${RUN} probe ${key}`, date: new Date().toISOString() }).select('id');
    const mayMs = !msProbe.error && msProbe.data?.length === 1;
    const mc = await call(env, who, 'POST', '/api/milestones', { name: `${RUN} ${key}`, description: 'temporary', date: new Date(Date.now() + 86400000).toISOString(), color: '#123456' });
    report.record(`milestone-create ${key}`, mayMs ? mc.status === 201 && body(mc)?.name === `${RUN} ${key}` : mc.status === 403, mayMs ? 'added to the timeline' : `refused (${mc.status})`);
  }

  // Deleting the department: refused for an employee, allowed for a superadmin
  await admin.from('user_roles').delete().in('role_id', made.roles);
  const { data: deptRoles } = await admin.from('roles').select('id').eq('department_id', dept.id);
  await admin.from('user_roles').delete().in('role_id', (deptRoles || []).map((r) => r.id));
  await admin.from('roles').delete().eq('department_id', dept.id);
  const delEmp = await call(env, S.emp1, 'DELETE', `/api/departments/${dept.id}`);
  const still = !!(await admin.from('departments').select('id').eq('id', dept.id).maybeSingle()).data;
  report.record('department-delete emp1', [403, 404].includes(delEmp.status) && still, `refused (${delEmp.status}), department still there`);
  const delSa = await call(env, S.superadmin, 'DELETE', `/api/departments/${dept.id}`);
  const gone = !(await admin.from('departments').select('id').eq('id', dept.id).maybeSingle()).data;
  report.record('department-delete superadmin', delSa.status === 200 && gone, 'deleted');

  report.start('Time entries API (fixed: its service had no database client on the server)');
  const { data: task } = await admin.from('tasks').select('id, project_id').limit(1).single();
  report.status('time-entries by task', await call(env, S.pm, 'GET', `/api/time-entries?taskId=${task.id}`), 200);
  report.status('time-entries by project', await call(env, S.pm, 'GET', `/api/time-entries?projectId=${task.project_id}`), 200);
  report.status('time-entries own', await call(env, S.pm, 'GET', '/api/time-entries'), 200);

  report.start('Browser makes no direct database requests for these');
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
  try {
    const { data: acmeProject } = await admin.from('projects').select('account_id').not('account_id', 'is', null).limit(1).single();
    // The requests each page used to make for the moved lookups (decoded data API paths). Profile loading
    // and permission checks still query directly until batch E; they are listed, not failed.
    for (const [key, pagePath, moved] of [
      ['superadmin', `/accounts/${acmeProject.account_id}`, [/^project_issues/, /^milestones/, /^account_kanban_configs/, /^tasks\?select=project_id,remaining_hours/, /^projects\?select=\*,account:accounts/, /^projects\?select=id,name&account_id/]],
      ['pm', '/projects', [/^projects\?select=\*,account:accounts/, /^projects\?select=id&or=/, /^project_assignments/, /^user_roles\?select=user_id,roles/, /^workflow_instances/, /^tasks\?select=project_id/]],
      ['superadmin', `/departments/${departments[0].id}`, [/^project_issues/, /^roles\?select=id&department_id/, /^project_assignments\?select=project_id,projects/]],
      ['superadmin', `/departments/${departments[0].id}/admin`, [/^roles\?select=\*,user_roles/, /^user_profiles\?select=id,name,email,image,user_roles/, /^departments\?select=\*&id=/]],
      ['superadmin', '/admin/roles', [/^user_roles\?select=user_profiles/, /^roles\?select=\*,department:/, /^departments\?select=\*&order=name/, /^roles\?select=\*&department_id/, /^user_roles\?select=\*&role_id/]],
      ['superadmin', '/admin/time-tracking', [/^user_profiles\?select=id,name&order=name/, /^projects\?select=id,name&order=name/]],
    ]) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await ctx.addCookies(S[key].cookie.split('; ').map((kv) => { const i = kv.indexOf('='); return { name: kv.slice(0, i), value: kv.slice(i + 1), url: env.appUrl }; }));
      const page = await ctx.newPage();
      const direct = [];
      const errors = [];
      page.on('request', (r) => { if (r.url().includes('/rest/v1/')) direct.push(decodeURIComponent(r.url().split('/rest/v1/')[1])); });
      page.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 500) errors.push(`${r.status()} ${new URL(r.url()).pathname}`); });
      await page.goto(env.appUrl + pagePath, { waitUntil: 'load' });
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      const bad = direct.filter((u) => moved.some((re) => re.test(u)));
      report.record(`${pagePath}-no-direct`, bad.length === 0 && errors.length === 0, `${bad.length} direct request(s) for the moved lookups${bad.length ? `: ${bad.map((u) => u.slice(0, 60)).join(' | ')}` : ''}${errors.length ? `; API errors: ${errors.join(', ')}` : ''}`);
      if (direct.length) console.log(`    (still direct on ${pagePath}, for batch E: ${[...new Set(direct.map((u) => u.split('?')[0]))].join(', ')})`);
      await ctx.close();
    }
  } finally {
    await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 15000))]);
  }
}

main()
  .catch((e) => report.error('run', e))
  .finally(() => process.exit(report.summary() ? 1 : 0));
