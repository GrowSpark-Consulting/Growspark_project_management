// Departments: people join a department directly, whatever their role.
//
// Reported: a superadmin created departments, but a Project Manager saw none of them. Membership
// came only from roles created inside a department; the ready-made roles belong to no department,
// and the invitation's Department choice was ignored. Now: the invitation's department is applied
// on acceptance, and departments can be set per person on the Users page (PUT /api/users/[id]/departments).
//
// NON-DESTRUCTIVE: no reset, no seed. Temporary @example.com users and a temporary department,
// all deleted at the end. Local Supabase only.
//
// Usage: node tests/local-e2e/department-members.mjs   (app running on port 3100)
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { loadEnv, adminClient, signIn, call, Report, ROOT, chromePath } from './lib.mjs';

const env = loadEnv();
const admin = adminClient(env);
const report = new Report('Department membership');
const OUT = path.join(ROOT, 'tests', 'local-e2e', 'output');
fs.mkdirSync(OUT, { recursive: true });
const RUN = Date.now().toString(36);
const DIRECTOR = { email: `dept.pd.${RUN}@example.com`, password: 'Director2026x', name: 'E2E Temp Director' };
const MANAGER = { email: `dept.pm.${RUN}@example.com`, password: 'Manager2026x', name: 'E2E Temp Manager' };
const DEPT = `E2E Dept ${RUN}`;
const made = { users: [], departments: [] };

async function login(page, u) {
  await page.goto(`${env.appUrl}/login?email=${encodeURIComponent(u.email)}`, { waitUntil: 'load' });
  await page.waitForSelector('#email', { timeout: 30000 });
  await page.fill('#password', u.password);
  await page.click('button[type="submit"]');
  await page.waitForURL((x) => x.pathname === '/manager', { timeout: 45000 });
}
const counts = async () => {
  const c = async (t) => (await admin.from(t).select('*', { count: 'exact', head: true })).count;
  return { profiles: await c('user_profiles'), departments: await c('departments'), memberships: await c('department_members'), invitations: await c('user_invitations') };
};

async function cleanup() {
  const problems = [];
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const pm = (data?.users || []).find((u) => u.email === MANAGER.email);
  // Order matters (foreign keys): manager → invitation → director → department
  if (pm) { const { error } = await admin.auth.admin.deleteUser(pm.id); if (error) problems.push(`manager: ${error.message}`); }
  const { error: invErr } = await admin.from('user_invitations').delete().like('email', `dept.%${RUN}@example.com`);
  if (invErr) problems.push(`invitation: ${invErr.message}`);
  for (const id of made.users) { const { error } = await admin.auth.admin.deleteUser(id); if (error) problems.push(`director: ${error.message}`); }
  for (const id of made.departments) { const { error } = await admin.from('departments').delete().eq('id', id); if (error) problems.push(`department: ${error.message}`); }
  for (const p of problems) console.error(`  cleanup: ${p}`);
}

async function main() {
  const before = await counts();
  const { data: d, error: dErr } = await admin.from('departments').insert({ name: DEPT }).select('id').single();
  if (dErr) throw dErr;
  made.departments.push(d.id);
  const { data: pd, error: pdErr } = await admin.auth.admin.createUser({ email: DIRECTOR.email, password: DIRECTOR.password, email_confirm: true, user_metadata: { name: DIRECTOR.name } });
  if (pdErr) throw pdErr;
  made.users.push(pd.user.id);
  await admin.from('user_profiles').update({ name: DIRECTOR.name, has_completed_onboarding: true }).eq('id', pd.user.id);
  const roleId = async (n) => (await admin.from('roles').select('id').eq('name', n).single()).data.id;
  await admin.from('user_roles').insert({ user_id: pd.user.id, role_id: await roleId('Project Director') });
  const director = await signIn(env, DIRECTOR.email, DIRECTOR.password);

  report.start('The invitation\'s department is applied on acceptance');
  const inv = await call(env, director, 'POST', '/api/invitations', { email: MANAGER.email, name: MANAGER.name, roleId: await roleId('Project Manager'), departmentId: d.id, send_email: false });
  report.status('INV-with-department', inv, 201, 'Project Manager invited into the department');
  const bad = await call(env, director, 'POST', '/api/invitations', { email: `dept.bad.${RUN}@example.com`, name: 'Bad', roleId: await roleId('Employee'), departmentId: '00000000-0000-4000-8000-000000000000', send_email: false });
  report.status('INV-unknown-department', bad, 400, 'an unknown department is refused');
  const acc = await call(env, null, 'POST', `/api/invitations/accept/${inv.body?.invitation?.token}`, { password: MANAGER.password });
  report.status('INV-accept', acc, [200, 201]);
  const { data: pmProfile } = await admin.from('user_profiles').select('id').eq('email', MANAGER.email).single();
  await admin.from('user_profiles').update({ has_completed_onboarding: true }).eq('id', pmProfile.id); // skip the first-time tutorial
  const { count: joined } = await admin.from('department_members').select('*', { count: 'exact', head: true }).eq('user_id', pmProfile.id).eq('department_id', d.id);
  report.record('INV-joined-department', joined === 1, `membership rows: ${joined}`);

  const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
  try {
    report.start('The Project Manager sees the department');
    let pm = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await login(pm, MANAGER);
    await pm.getByRole('button', { name: 'Department' }).first().click().catch(() => {});
    const inSidebar = await pm.getByRole('link', { name: DEPT }).first().waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
    report.record('PM-sidebar', inSidebar, 'department listed under Department in the sidebar');
    await pm.goto(`${env.appUrl}/departments`, { waitUntil: 'load' });
    // Look only in the page content (<main>), not at the sidebar link
    report.record('PM-departments-page', await pm.getByRole('main').getByText(DEPT).first().waitFor({ timeout: 20000 }).then(() => true).catch(() => false), '/departments lists it (page content)');
    await pm.goto(`${env.appUrl}/departments/${d.id}`, { waitUntil: 'load' });
    await pm.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    const detail = await pm.getByRole('main').innerText();
    await pm.screenshot({ path: path.join(OUT, 'department-members-pm.png') }).catch(() => {});
    report.record('PM-department-detail', detail.includes(DEPT) && !/Not Found|Access Denied|don't have permission/i.test(detail), 'department page opens');

    report.start('Departments on the Users page');
    const pmApi = await signIn(env, MANAGER.email, MANAGER.password);
    report.status('PUT-refused-for-manager', await call(env, pmApi, 'PUT', `/api/users/${pmProfile.id}/departments`, { departmentIds: [] }), 403, "a Project Manager can't change departments");
    const list = await call(env, director, 'GET', '/api/admin/users?type=internal');
    const row = (list.body?.data?.users || []).find((u) => u.id === pmProfile.id);
    report.record('USERS-list-shows-department', list.status === 200 && row?.departments?.includes(DEPT) && (list.body?.data?.departments || []).some((x) => x.id === d.id), `Users list: ${row?.departments?.join(', ') || 'none'}`);
    const cleared = await call(env, director, 'PUT', `/api/users/${pmProfile.id}/departments`, { departmentIds: [] });
    report.record('PUT-remove', cleared.status === 200 && cleared.body?.data?.removed === 1, `removed ${cleared.body?.data?.removed}`);
    pm = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await login(pm, MANAGER);
    await pm.goto(`${env.appUrl}/departments`, { waitUntil: 'load' });
    await pm.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await pm.getByRole('main').waitFor({ timeout: 15000 }).catch(() => {});
    report.record('PM-no-longer-sees', !(await pm.getByRole('main').getByText(DEPT).count()) && !(await pm.getByRole('link', { name: DEPT }).count()), 'after removal neither /departments nor the sidebar lists it');

    // The director adds the manager back through the Users page dialog
    const dp = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await login(dp, DIRECTOR);
    await dp.goto(`${env.appUrl}/admin/users`, { waitUntil: 'load' });
    const pmRow = dp.locator('tr', { hasText: MANAGER.email });
    await pmRow.getByRole('button', { name: 'Departments' }).click();
    const dialog = dp.getByRole('dialog');
    await dialog.getByText(`Departments for ${MANAGER.name}`).waitFor({ timeout: 15000 });
    await dialog.getByLabel(DEPT).check();
    await dialog.getByRole('button', { name: 'Save' }).click();
    const saved = await dp.getByText(`Departments updated for ${MANAGER.name}`).waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
    const shown = await pmRow.getByText(DEPT).waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
    await dp.screenshot({ path: path.join(OUT, 'department-members-users-page.png') }).catch(() => {});
    const { count: back } = await admin.from('department_members').select('*', { count: 'exact', head: true }).eq('user_id', pmProfile.id).eq('department_id', d.id);
    report.record('USERS-page-dialog', saved && shown && back === 1, 'ticked in the Departments dialog → saved, shown in the list, membership stored');
  } finally {
    await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 15000))]);
    await cleanup();
    const after = await counts();
    report.record('CLEANUP', JSON.stringify(after) === JSON.stringify(before), `before ${JSON.stringify(before)}, after ${JSON.stringify(after)}`);
  }
}

main().catch((e) => report.error('UNCAUGHT', e)).finally(() => process.exit(report.summary() ? 1 : 0));
