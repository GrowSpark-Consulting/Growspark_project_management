// Departments: people join a department directly, whatever their role.
//
// Reported: a superadmin created departments, but a Project Manager saw none of them. Membership
// came only from roles created inside a department; the ready-made roles belong to no department,
// and the invitation's Department choice was ignored. Now: the invitation's department is applied
// on acceptance, and departments can be set per person on the Users page (PUT /api/users/[id]/departments).
// Workflow department steps count such direct members too: project team, notifications, the
// "Send to Next Step" button, the next-step picker and the right to advance the step.
//
// NON-DESTRUCTIVE: no reset, no seed. Temporary @example.com users, a department, an account, a
// project and a workflow template, all deleted at the end. Local Supabase only. The audit log is
// append-only, so the department changes made here stay in it (with the deleted user unlinked).
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
const made = { users: [], departments: [], accounts: [], templates: [] };

async function login(page, u) {
  await page.goto(`${env.appUrl}/login?email=${encodeURIComponent(u.email)}`, { waitUntil: 'load' });
  await page.waitForSelector('#email', { timeout: 30000 });
  await page.fill('#password', u.password);
  await page.click('button[type="submit"]');
  await page.waitForURL((x) => x.pathname === '/manager', { timeout: 45000 });
}
const counts = async () => {
  const c = async (t) => (await admin.from(t).select('*', { count: 'exact', head: true })).count;
  return {
    profiles: await c('user_profiles'), departments: await c('departments'), memberships: await c('department_members'), invitations: await c('user_invitations'),
    accounts: await c('accounts'), projects: await c('projects'), templates: await c('workflow_templates'),
  };
};

async function cleanup() {
  const problems = [];
  // The account takes its project with it (workflow run, steps, history, team, notifications); then the template
  for (const id of made.accounts) { const { error } = await admin.from('accounts').delete().eq('id', id); if (error) problems.push(`account: ${error.message}`); }
  for (const id of made.templates) { const { error } = await admin.from('workflow_templates').delete().eq('id', id); if (error) problems.push(`template: ${error.message}`); }
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

    // The manager is in the department only directly: the Project Manager role belongs to no department
    report.start('Workflow department steps count people added directly');
    const { data: acct, error: aErr } = await admin.from('accounts').insert({ name: `E2E Dept Account ${RUN}` }).select('id').single();
    if (aErr) throw aErr;
    made.accounts.push(acct.id);
    const { data: proj, error: prErr } = await admin.from('projects').insert({
      name: `E2E Dept Project ${RUN}`, account_id: acct.id, status: 'in_progress', priority: 'medium',
      created_by: pd.user.id, assigned_user_id: pd.user.id, shared_with_client: false,
    }).select('id').single();
    if (prErr) throw prErr;
    await admin.from('project_assignments').insert({ project_id: proj.id, user_id: pd.user.id, role_in_project: 'Project Director' });
    const { data: tpl, error: tErr } = await admin.from('workflow_templates').insert({ name: `E2E Dept Flow ${RUN}`, description: 'Two department steps', created_by: pd.user.id, is_active: true }).select('id').single();
    if (tErr) throw tErr;
    made.templates.push(tpl.id);
    const STEP1 = `Dept review ${RUN}`, STEP2 = `Dept build ${RUN}`, STEP3 = `Dept sign-off ${RUN}`;
    const node = async (node_type, label, x, entity_id = null) => {
      const { data: n, error } = await admin.from('workflow_nodes').insert({ workflow_template_id: tpl.id, node_type, label, entity_id, position_x: x, position_y: 100 }).select('id').single();
      if (error) throw error;
      return n.id;
    };
    const n0 = await node('start', 'Start', 0), n1 = await node('department', STEP1, 200, d.id), n2 = await node('department', STEP2, 400, d.id);
    const n3 = await node('department', STEP3, 600, d.id), nEnd = await node('end', 'Done', 800);
    const { error: cErr } = await admin.from('workflow_connections').insert([[n0, n1], [n1, n2], [n2, n3], [n3, nEnd]].map(([a, b]) => ({ workflow_template_id: tpl.id, from_node_id: a, to_node_id: b })));
    if (cErr) throw cErr;
    const activeStep = async (nodeId) => (await admin.from('workflow_active_steps').select('id, assigned_user_id').eq('workflow_instance_id', inst.id).eq('node_id', nodeId).eq('status', 'active').maybeSingle()).data;
    const notifiedAbout = async (label) => ((await admin.from('notifications').select('message').eq('user_id', pmProfile.id)).data || []).some((n) => (n.message || '').includes(label));

    report.status('WF-start', await call(env, director, 'POST', '/api/workflows/start', { projectId: proj.id, workflowTemplateId: tpl.id }), [200, 201], 'the director starts it; the first step is a department step');
    const { data: inst } = await admin.from('workflow_instances').select('id').eq('project_id', proj.id).single();
    const { count: onTeam } = await admin.from('project_assignments').select('*', { count: 'exact', head: true }).eq('project_id', proj.id).eq('user_id', pmProfile.id).is('removed_at', null);
    report.record('WF-dept-team', onTeam === 1, 'the direct member joined the project team when the step was reached');
    report.record('WF-dept-notified', await notifiedAbout(STEP1), 'and was told the step is waiting');
    const elig = await call(env, director, 'GET', `/api/workflows/steps/assignments?workflowInstanceId=${inst.id}&userId=${pmProfile.id}`);
    const second = (elig.body?.nodes || []).find((x) => x.id === n2);
    report.record('WF-dept-eligible', elig.status === 200 && second?.user_eligible === true, `can be assigned "${STEP2}": ${second?.user_eligible}`);

    // In the browser: the button is offered, and the next department step lists its members to pick from
    pm = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await login(pm, MANAGER);
    await pm.goto(`${env.appUrl}/projects/${proj.id}`, { waitUntil: 'load' });
    const send = pm.getByRole('button', { name: 'Send to Next Step' }).first();
    report.record('WF-dept-button', await send.waitFor({ timeout: 30000 }).then(() => true).catch(() => false), 'project page offers "Send to Next Step"');
    await send.click();
    const dlg = pm.getByRole('dialog');
    const counted = await dlg.getByText('1 user available for assignment').waitFor({ timeout: 20000 }).then(() => true).catch(() => false);
    await dlg.getByRole('combobox').first().click().catch(() => {});
    const listed = await pm.getByRole('option', { name: `${STEP2} - ${MANAGER.name}` }).waitFor({ timeout: 10000 }).then(() => true).catch(() => false);
    await pm.screenshot({ path: path.join(OUT, 'department-members-workflow-picker.png') }).catch(() => {});
    report.record('WF-dept-picker', counted && listed, `the picker for "${STEP2}" lists the department's member`);
    await pm.keyboard.press('Escape');
    await pm.keyboard.press('Escape');

    // Moving on with nobody picked: the department has a member (direct only), so the next step is created for the department
    const s1 = await activeStep(n1);
    report.status('WF-dept-advance', await call(env, pmApi, 'POST', '/api/workflows/progress', { workflowInstanceId: inst.id, activeStepId: s1?.id }), 200, `the direct member completes "${STEP1}"`);
    const s2 = await activeStep(n2);
    report.record('WF-dept-next-step', !!s2 && s2.assigned_user_id === null && await notifiedAbout(STEP2), `"${STEP2}" is active for the department and its member was told`);
    // Nobody is assigned to it, but it is still the department's step: others on the project team are refused
    const outsiderOpen = await call(env, director, 'POST', '/api/workflows/progress', { workflowInstanceId: inst.id, activeStepId: s2?.id });
    const { data: stillOpen } = await admin.from('workflow_active_steps').select('status').eq('id', s2?.id).single();
    report.record('WF-dept-outsider-unassigned', outsiderOpen.status === 403 && stillOpen?.status === 'active', `someone on the project but outside the department: ${outsiderOpen.status} ${outsiderOpen.body?.error}`);

    // In the browser the member picks themself for the next step
    await pm.goto(`${env.appUrl}/projects/${proj.id}`, { waitUntil: 'load' });
    await pm.getByRole('button', { name: 'Send to Next Step' }).first().click({ timeout: 30000 });
    const dlg2 = pm.getByRole('dialog');
    await dlg2.getByRole('combobox').first().click({ timeout: 20000 });
    await pm.getByRole('option', { name: `${STEP3} - ${MANAGER.name}` }).click({ timeout: 10000 });
    await dlg2.getByRole('button', { name: 'Send to Next Step' }).click();
    const sent = await pm.getByText('Project sent to next step successfully').waitFor({ timeout: 20000 }).then(() => true).catch(() => false);
    const s3 = await activeStep(n3);
    report.record('WF-dept-assigned', sent && s3?.assigned_user_id === pmProfile.id, `"${STEP3}" assigned to the member picked in the dialog`);

    // A step assigned in the department: someone outside it cannot advance it either
    const outsider = await call(env, director, 'POST', '/api/workflows/progress', { workflowInstanceId: inst.id, activeStepId: s3?.id });
    report.record('WF-dept-outsider', outsider.status === 403 && /department/.test(outsider.body?.error || ''), `someone outside the department: ${outsider.status} ${outsider.body?.error}`);

    // The member finishes the workflow from the project page
    await pm.goto(`${env.appUrl}/projects/${proj.id}`, { waitUntil: 'load' });
    await pm.getByRole('button', { name: 'Send to Next Step' }).first().click({ timeout: 30000 });
    await pm.getByRole('dialog').getByRole('button', { name: 'Send to Next Step' }).click({ timeout: 20000 });
    const toast = await pm.getByText('Project sent to next step successfully').waitFor({ timeout: 20000 }).then(() => true).catch(() => false);
    const { data: fin } = await admin.from('workflow_instances').select('status').eq('id', inst.id).single();
    report.record('WF-dept-complete', toast && fin?.status === 'completed', `finished in the browser → workflow ${fin?.status}`);
  } finally {
    await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 15000))]);
    await cleanup();
    const after = await counts();
    report.record('CLEANUP', JSON.stringify(after) === JSON.stringify(before), `before ${JSON.stringify(before)}, after ${JSON.stringify(after)}`);
  }
}

main().catch((e) => report.error('UNCAUGHT', e)).finally(() => process.exit(report.summary() ? 1 : 0));
