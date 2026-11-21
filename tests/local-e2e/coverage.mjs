// End-to-end checks for features that were built but had not been exercised end to end yet,
// plus the project resource plan. Seeds first (adds the @example.com test users), like e2e:local.
//
//   A Resource plan        B Gantt, rescheduling, Kanban drag-and-drop, board columns
//   C Project progress     D Team details, reports + CSV, team analytics
//   E Employee portal      F Workflow with a client-approval step, client portal, notifications
//   G Client accounts and the Team Lead role
//
// Usage: node tests/local-e2e/coverage.mjs   (app running on port 3100, local Supabase)
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { loadEnv, adminClient, signIn, call, Report, ROOT, chromePath, isoDate, addDays, mondayOf } from './lib.mjs';
import { seed, IDS, PERSONAS } from './seed.mjs';

const env = loadEnv();
const admin = adminClient(env);
const report = new Report('Feature coverage (browser + API)');
const OUT = path.join(ROOT, 'tests', 'local-e2e', 'output');
fs.mkdirSync(OUT, { recursive: true });
const RUN = Date.now().toString(36);
const S = {};
const ids = {};
const api = (who, method, p, body) => call(env, who ? S[who] : null, method, p, body);
const day = (n) => isoDate(addDays(n));
const W0 = mondayOf();
const W1 = isoDate(addDays(7, new Date(`${W0}T12:00:00`)));

async function step(id, fn) {
  try { await fn(); } catch (e) { report.error(id, e); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = (page) => page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `coverage-${name}.png`) }).catch(() => {});
const visible = (loc, timeout = 15000) => loc.first().waitFor({ timeout }).then(() => true).catch(() => false);
let browser;
async function pageAs(who) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, acceptDownloads: true });
  await ctx.addCookies(S[who].cookie.split('; ').map((kv) => { const i = kv.indexOf('='); return { name: kv.slice(0, i), value: kv.slice(i + 1), url: env.appUrl }; }));
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept().catch(() => {}));
  return page;
}
async function open(page, p) {
  await page.goto(env.appUrl + p, { waitUntil: 'load', timeout: 120000 });
  await settle(page);
}

async function main() {
  report.start('Setup');
  await seed({ quiet: true });
  for (const who of ['superadmin', 'pm', 'emp1', 'emp2', 'client', 'client2']) {
    S[who] = await signIn(env, PERSONAS[who].email);
    ids[who] = S[who].userId;
  }
  // A project of its own: pm manages it, emp1 and emp2 work on it, Acme's client can see it
  const { data: proj, error: pErr } = await admin.from('projects').insert({
    name: `Coverage ${RUN}`, account_id: IDS.acme, status: 'in_progress', priority: 'medium', created_by: ids.pm, assigned_user_id: ids.pm,
    start_date: day(-2), end_date: day(40), estimated_hours: 100, shared_with_client: true,
  }).select('id').single();
  if (pErr) throw pErr;
  const P = proj.id;
  await admin.from('project_assignments').insert([
    { project_id: P, user_id: ids.pm, role_in_project: 'Project Manager' },
    { project_id: P, user_id: ids.emp1, role_in_project: 'Developer' },
    { project_id: P, user_id: ids.emp2, role_in_project: 'Designer' },
  ]);
  const task = async (name, extra) => {
    const { data, error } = await admin.from('tasks').insert({ name, project_id: P, created_by: ids.pm, priority: 'medium', ...extra }).select('id').single();
    if (error) throw new Error(`task ${name}: ${error.message}`);
    return data.id;
  };
  const T = {
    design: await task(`Design ${RUN}`, { assigned_to: ids.emp2, status: 'todo', start_date: day(0), due_date: day(4), estimated_hours: 16 }),
    build: await task(`Build ${RUN}`, { assigned_to: ids.emp1, status: 'todo', start_date: day(2), due_date: day(8), estimated_hours: 24 }),
    review: await task(`Review ${RUN}`, { assigned_to: ids.emp1, status: 'in_progress', started_at: new Date().toISOString(), due_date: day(10), estimated_hours: 6 }),
    fix: await task(`Fix ${RUN}`, { assigned_to: ids.emp1, status: 'changes_requested', review_note: `Please fix the header ${RUN}`, due_date: day(6), estimated_hours: 3 }),
    late: await task(`Late ${RUN}`, { assigned_to: ids.emp1, status: 'todo', due_date: day(-1), estimated_hours: 2 }),
    done: await task(`Done ${RUN}`, { assigned_to: ids.emp1, status: 'done', completed_at: new Date().toISOString(), progress_percent: 100, due_date: day(1), estimated_hours: 4 }),
    unassigned: await task(`Unassigned ${RUN}`, { status: 'todo', due_date: day(12) }),
  };
  T.sub = await task(`Sub ${RUN}`, { assigned_to: ids.emp2, status: 'done', completed_at: new Date().toISOString(), parent_task_id: T.design });
  T.calendar = await task(`Calendar ${RUN}`, { assigned_to: ids.emp1, status: 'todo', due_date: day(0), estimated_hours: 1 });
  T.submitted = await task(`Submitted ${RUN}`, { assigned_to: ids.emp1, status: 'review', due_date: day(3), estimated_hours: 2 });
  const { error: depErr } = await admin.from('task_dependencies').insert({ task_id: T.build, depends_on_task_id: T.design });
  if (depErr) throw depErr;
  await admin.from('milestones').insert({ name: `Launch ${RUN}`, project_id: P, date: day(12), status: 'pending', client_visible: true, created_by: ids.pm });
  report.record('SETUP', true, `project Coverage ${RUN} with ${Object.keys(T).length} tasks, a dependency and a milestone`);

  browser = await chromium.launch({ executablePath: chromePath(), headless: true });
  try {
    // ================================================================ A. Resource plan
    report.start('A. Resource plan (project resource allocation)');
    await admin.from('user_availability').upsert({ user_id: ids.emp2, week_start_date: W0, available_hours: 10 }, { onConflict: 'user_id,week_start_date' });
    const pm = await pageAs('pm');
    // Waits for the save request itself: the toast of the previous save can still be on screen
    const savePlan = async () => {
      const [res] = await Promise.all([
        pm.waitForResponse((r) => r.url().includes(`/api/projects/${P}/allocations`) && r.request().method() === 'PUT', { timeout: 30000 }),
        pm.getByRole('button', { name: 'Save plan' }).click(),
      ]);
      await visible(pm.getByText('Resource plan saved'));
      return res.ok();
    };
    await step('RP', async () => {
      await open(pm, `/projects/${P}`);
      await pm.getByRole('link', { name: 'Resource plan' }).click();
      report.record('RP-link', await pm.waitForURL((u) => u.pathname === `/projects/${P}/resources`, { timeout: 30000 }).then(() => true).catch(() => false), `project page → ${new URL(pm.url()).pathname}`);
      await settle(pm);
      const rows = await pm.locator('tbody').innerText().catch(() => '');
      report.record('RP-rows', ['Arjun Developer', 'Meera Designer', `Build ${RUN}`, `Design ${RUN}`].every((s) => rows.includes(s)) && !rows.includes(`Done ${RUN}`),
        'people with their open tasks (done tasks left out)');
      report.record('RP-unassigned', await visible(pm.getByText(`Unassigned ${RUN}`)), 'unassigned tasks listed separately');
      await pm.locator(`#alloc-${T.design}-${W0}`).fill('8');
      await pm.locator(`#alloc-${T.design}-${W1}`).fill('4');
      await pm.locator(`#alloc-${T.build}-${W0}`).fill('12');
      const saved = await savePlan();
      const { data: rowsDb } = await admin.from('task_week_allocations').select('task_id, week_start_date, assigned_user_id, allocated_hours').in('task_id', [T.design, T.build]);
      const has = (t, w, u, h) => (rowsDb || []).some((r) => r.task_id === t && r.week_start_date === w && r.assigned_user_id === u && Number(r.allocated_hours) === h);
      report.record('RP-save', saved && has(T.design, W0, ids.emp2, 8) && has(T.design, W1, ids.emp2, 4) && has(T.build, W0, ids.emp1, 12), `${(rowsDb || []).length} allocation rows stored for the assignees`);
      await pm.locator(`#alloc-${T.design}-${W0}`).fill('12');
      await savePlan();
      await settle(pm);
      const cell = pm.locator(`tr[data-person="${ids.emp2}"] [data-week="${W0}"]`);
      const status = await cell.getAttribute('data-status').catch(() => null);
      // Others can be over capacity too (earlier runs leave allocations), so look for Meera anywhere in the banner
      const banner = await visible(pm.getByText(/^Over capacity:/)) ? await pm.getByText(/^Over capacity:/).first().innerText() : '';
      report.record('RP-over-capacity', status === 'over' && banner.includes('Meera Designer'), `12 h planned against 10 h available → ${status}; banner "${banner}"`);
      await shot(pm, 'resource-plan');
      await pm.locator(`#alloc-${T.design}-${W1}`).fill('0');
      const clearedOk = await savePlan();
      const { count: cleared } = await admin.from('task_week_allocations').select('*', { count: 'exact', head: true }).eq('task_id', T.design).eq('week_start_date', W1);
      report.record('RP-clear', clearedOk && cleared === 0, 'setting a week to 0 removes that allocation');
      const plan = await api('pm', 'GET', `/api/projects/${P}/allocations?from=${W0}&weeks=2`);
      const m = plan.body?.data?.people?.find((p) => p.id === ids.emp2)?.weeks?.[0];
      report.record('RP-api-capacity', m?.here === 12 && m?.available === 10 && m?.status === 'over', `week 1 for Meera: ${JSON.stringify(m)}`);
    });
    await step('RP-guard', async () => {
      report.status('RP-employee-api', await api('emp1', 'GET', `/api/projects/${P}/allocations`), 403, 'employees cannot open the plan');
      report.status('RP-employee-save', await api('emp1', 'PUT', `/api/projects/${P}/allocations`, { changes: [{ taskId: T.build, weekStartDate: W0, hours: 40 }] }), 403);
      const tuesday = isoDate(addDays(1, new Date(`${W0}T12:00:00`)));
      report.status('RP-not-monday', await api('pm', 'PUT', `/api/projects/${P}/allocations`, { changes: [{ taskId: T.build, weekStartDate: tuesday, hours: 1 }] }), 400, 'weeks start on a Monday');
      report.status('RP-unassigned-refused', await api('pm', 'PUT', `/api/projects/${P}/allocations`, { changes: [{ taskId: T.unassigned, weekStartDate: W0, hours: 2 }] }), 400);
      report.status('RP-done-refused', await api('pm', 'PUT', `/api/projects/${P}/allocations`, { changes: [{ taskId: T.done, weekStartDate: W0, hours: 2 }] }), 400);
      const e1 = await pageAs('emp1');
      await open(e1, `/projects/${P}/resources`);
      report.record('RP-employee-page', await visible(e1.getByText('Only a project manager can see the resource plan')), 'the page explains it is for project managers');
      await e1.context().close();
    });

    // ================================================================ B. Planning views
    report.start('B. Gantt, rescheduling, Kanban board');
    await step('GANTT', async () => {
      await open(pm, `/projects/${P}`);
      await pm.locator('button[title="Open Gantt View"]').click();
      const dlg = pm.getByRole('dialog');
      await visible(dlg.getByText(`Task Gantt Chart - Coverage ${RUN}`));
      await sleep(1500);
      const red = await dlg.locator('svg path[stroke="#ef4444"]').count();
      report.record('GANTT-conflict', red >= 1, `${red} dependency arrow(s) drawn red (Build starts before Design ends)`);
      report.record('GANTT-milestone', await dlg.locator('svg text', { hasText: `Launch ${RUN}` }).count() === 1, 'milestone drawn on the timeline');
      await shot(pm, 'gantt-before');
      const btn = dlg.getByRole('button', { name: /Reschedule from dependencies/ });
      report.record('RESCHED-offered', (await btn.innerText()).includes('(1)') && await btn.isEnabled(), `button: ${await btn.innerText()}`);
      await btn.click();
      const alert = pm.getByRole('alertdialog');
      report.record('RESCHED-preview', await visible(alert.getByText(`Build ${RUN}`)), 'preview lists the task that moves');
      await alert.getByRole('button', { name: 'Apply' }).click();
      const applied = await visible(pm.getByText('1 task(s) rescheduled'));
      const { data: b } = await admin.from('tasks').select('start_date, due_date').eq('id', T.build).single();
      report.record('RESCHED-applied', applied && String(b.start_date).slice(0, 10) > day(4), `Build now starts ${String(b.start_date).slice(0, 10)} (Design ends ${day(4)})`);
      await sleep(1500);
      report.record('GANTT-conflict-gone', await dlg.locator('svg path[stroke="#ef4444"]').count() === 0 && await dlg.locator('svg path[stroke="#64748b"]').count() >= 1, 'arrow drawn normally after rescheduling');
      await pm.keyboard.press('Escape');
    });
    await step('SCHED-guard', async () => {
      const r = await api('emp1', 'POST', `/api/tasks/${T.build}/status`, { action: 'start' });
      report.record('SCHED-start-blocked', r.status >= 400 && /Waiting for/i.test(JSON.stringify(r.body)), `start Build before Design is done → ${r.status}: ${r.body?.error}`);
    });
    await step('KANBAN', async () => {
      await open(pm, `/projects/${P}`);
      await pm.locator('button[title="Open Kanban View"]').click();
      const dlg = pm.getByRole('dialog');
      await visible(dlg.getByText(`Task Kanban Board - Coverage ${RUN}`));
      const column = (label) => dlg.locator('div.w-80', { has: pm.getByRole('heading', { name: label, exact: true }) }).locator('div.rounded-b-lg');
      const card = dlg.locator('[draggable="true"]', { hasText: `Design ${RUN}` });
      await card.dragTo(column('In Progress'));
      await sleep(2000);
      const { data: d } = await admin.from('tasks').select('status').eq('id', T.design).single();
      report.record('KANBAN-drag', d.status === 'in_progress', `Design dragged To Do → In Progress: status ${d.status}`);
      await dlg.getByRole('button', { name: 'Customize columns' }).click();
      const edit = pm.getByRole('dialog', { name: 'Customize board columns' });
      await edit.getByLabel('Name for In Progress').fill(`Doing ${RUN}`);
      await edit.locator('div', { has: pm.getByLabel('Name for On Hold') }).last().getByRole('checkbox').check();
      await edit.getByRole('button', { name: 'Save', exact: true }).click();
      await sleep(1500);
      const { data: pr } = await admin.from('projects').select('board_columns').eq('id', P).single();
      const cols = pr.board_columns || [];
      report.record('BOARD-saved', cols.some((c) => c.status === 'in_progress' && c.label === `Doing ${RUN}`) && cols.some((c) => c.status === 'on_hold' && c.hidden), 'renamed and hidden columns stored for the project');
      report.record('BOARD-shown', await visible(dlg.getByRole('heading', { name: `Doing ${RUN}` })) && await dlg.getByRole('heading', { name: 'On Hold', exact: true }).count() === 0, 'board shows the new name and hides On Hold');
      await shot(pm, 'kanban-custom');
      await dlg.getByRole('button', { name: 'Customize columns' }).click();
      await pm.getByRole('dialog', { name: 'Customize board columns' }).getByRole('button', { name: 'Reset to default' }).click();
      await sleep(1500);
      const { data: pr2 } = await admin.from('projects').select('board_columns').eq('id', P).single();
      report.record('BOARD-reset', pr2.board_columns === null, 'reset to default');
      await pm.keyboard.press('Escape');
    });

    // ================================================================ C. Progress
    report.start('C. Project progress (same number everywhere)');
    await step('PROG', async () => {
      const { data: all } = await admin.from('tasks').select('status, parent_task_id').eq('project_id', P);
      const top = (all || []).filter((t) => !t.parent_task_id);
      const expected = Math.round((top.filter((t) => t.status === 'done').length / top.length) * 100);
      const ov = await api('pm', 'GET', '/api/manager/overview');
      const row = JSON.stringify(ov.body).includes(P) ? (ov.body?.data?.projects || []).find((p) => p.id === P) : null;
      report.record('PROG-manager', row?.progress_percent === expected, `Manager dashboard ${row?.progress_percent}% · expected ${expected}% (${top.length} top-level tasks)`);
      const cs = await api('client', 'GET', '/api/client/portal/summary');
      const crow = (cs.body?.data?.projects || []).find((p) => p.id === P);
      report.record('PROG-client', crow?.progress_percent === expected, `client portal ${crow?.progress_percent}%`);
      const e1 = await pageAs('emp1');
      await open(e1, `/projects/${P}`);
      const txt = await e1.locator('[data-testid="project-progress"]').innerText().catch(() => '');
      report.record('PROG-project-page', txt.includes(`${expected}%`) && txt.includes(`of ${top.length} tasks done`), `project page: "${txt.replace(/\s+/g, ' ')}"`);
      await e1.context().close();
    });

    // ================================================================ D. Team, reports, analytics
    report.start('D. Team details, reports and CSV, team analytics');
    await step('TEAM', async () => {
      await open(pm, '/manager/team');
      await pm.locator('tr', { hasText: 'Arjun Developer' }).getByRole('button', { name: 'Details' }).click();
      const dlg = pm.getByRole('dialog');
      const ok = await visible(dlg.getByRole('heading', { name: 'Arjun Developer' })) && await visible(dlg.getByText(PERSONAS.emp1.email)) && await visible(dlg.getByRole('link', { name: new RegExp(`Coverage ${RUN}`) }));
      report.record('TEAM-details', ok, 'employee panel: name, email, projects, open tasks');
      await pm.keyboard.press('Escape');
    });
    const csvOf = async (page, reportLabel) => {
      await page.getByRole('button', { name: reportLabel, exact: true }).click();
      await settle(page);
      await page.locator('table tbody tr').first().waitFor({ timeout: 20000 });
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.getByRole('button', { name: 'Export CSV' }).click()]);
      return { name: dl.suggestedFilename(), text: fs.readFileSync(await dl.path(), 'utf8') };
    };
    await step('CSV', async () => {
      await open(pm, '/manager/reports');
      const a = await csvOf(pm, 'Employee performance');
      report.record('CSV-employee-performance', a.name.endsWith('.csv') && a.text.split(/\r?\n/).length >= 2 && a.text.includes('Arjun Developer'), `${a.name}: ${a.text.split(/\r?\n/)[0].replace(/^﻿/, '').slice(0, 80)}`);
      const b = await csvOf(pm, 'Project completion');
      report.record('CSV-project-completion', b.text.includes(`Coverage ${RUN}`), `${b.name}: ${b.text.split(/\r?\n/).length - 1} row(s)`);
    });
    await step('ANALYTICS', async () => {
      const r = await api('superadmin', 'GET', '/api/analytics/team?dateRange=30d');
      const d = r.body?.data;
      report.record('ANALYTICS-team', r.status === 200 && d?.summary?.totalUsers > 0 && Array.isArray(d?.workloadDistribution), `team analytics: ${d?.summary?.totalUsers} people, ${d?.summary?.totalHoursLogged} h logged`);
      const sa = await pageAs('superadmin');
      await open(sa, '/analytics');
      report.record('ANALYTICS-page', await visible(sa.getByText(/Team Performance/i)) && !(await sa.getByText(/Something went wrong|Application error/).count()), 'analytics page shows the team performance widget');
      await sa.context().close();
    });

    // ================================================================ E. Employee portal
    report.start('E. Employee portal: calendar, performance, My Tasks, notifications');
    const emp = await pageAs('emp1');
    await step('CAL', async () => {
      await open(emp, '/calendar');
      const monthTitle = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });
      const startsMonth = await visible(emp.getByText(monthTitle, { exact: true }));
      await emp.getByRole('button', { name: 'Week', exact: true }).click();
      await settle(emp);
      const weekHeader = await emp.locator('span.font-semibold.w-44').innerText().catch(() => '');
      const weekShows = await visible(emp.getByText(`Calendar ${RUN}`));
      await emp.getByRole('button', { name: 'Month', exact: true }).click();
      await settle(emp);
      report.record('CAL-week-month', startsMonth && /–/.test(weekHeader) && weekShows && await visible(emp.getByText(monthTitle, { exact: true })), `month "${monthTitle}" → week "${weekHeader}" (task due today shown) → month`);
    });
    await step('PERF', async () => {
      const { data: mine } = await admin.from('tasks').select('status, due_date, completed_at, updated_at').eq('assigned_to', ids.emp1);
      const done = (mine || []).filter((t) => t.status === 'done');
      const withDue = done.filter((t) => t.due_date);
      const onTime = withDue.filter((t) => (t.completed_at || t.updated_at || '').slice(0, 10) <= t.due_date.slice(0, 10)).length;
      const want = { tasksCompleted: done.length, tasksPending: (mine || []).length - done.length, onTimeRate: withDue.length ? Math.round((onTime / withDue.length) * 100) : null };
      const r = await api('emp1', 'GET', '/api/me/performance');
      const got = r.body?.data || {};
      report.record('PERF-values', got.tasksCompleted === want.tasksCompleted && got.tasksPending === want.tasksPending && got.onTimeRate === want.onTimeRate,
        `API ${got.tasksCompleted} done / ${got.tasksPending} pending / ${got.onTimeRate}% on time · from the tasks ${JSON.stringify(want)}`);
      await open(emp, '/performance');
      const kpi = async (label) => (await emp.locator('div.p-4', { has: emp.getByText(label, { exact: true }) }).first().innerText().catch(() => '')).replace(label, '').trim();
      report.record('PERF-page', (await kpi('Tasks completed')) === String(want.tasksCompleted) && (await kpi('Tasks pending')) === String(want.tasksPending), 'performance page shows the same numbers');
    });
    await step('FILTERS', async () => {
      await open(emp, '/tasks');
      // Each view button shows its count after the label ("In progress3")
      const view = async (label, expectText) => {
        await emp.getByRole('button', { name: new RegExp(`^${label}\\s*\\d+$`) }).click();
        await settle(emp);
        return visible(emp.getByText(expectText));
      };
      report.record('TASKS-in-progress', await view('In progress', `Review ${RUN}`), 'In progress lists the started task');
      report.record('TASKS-changes-requested', await view('Changes requested', `Fix ${RUN}`) && await visible(emp.getByText(`Please fix the header ${RUN}`, { exact: false })), 'Changes requested lists the task with the reviewer note');
      report.record('TASKS-overdue', await view('Overdue', `Late ${RUN}`), 'Overdue lists the late task');
    });
    await step('NOTIFY-approval', async () => {
      report.status('NOTIFY-approve-task', await api('pm', 'POST', `/api/tasks/${T.submitted}/status`, { action: 'approve' }), 200, 'manager approves the submitted task');
      const n = await api('emp1', 'GET', '/api/notifications?limit=50');
      const hit = (n.body?.data || []).find((x) => JSON.stringify(x).includes(`Submitted ${RUN}`));
      await open(emp, '/dashboard');
      await emp.getByRole('button', { name: /Notifications \(\d+ unread\)/ }).click();
      report.record('NOTIFY-approval', !!hit && await visible(emp.getByRole('menu').getByText(new RegExp(`Submitted ${RUN}`))), `employee told: "${hit?.title || 'none'}" (bell list)`);
      await emp.keyboard.press('Escape');
    });

    // ================================================================ F. Workflow with a client-approval step
    report.start('F. Workflow: role step, client approval, client portal');
    await step('WF', async () => {
      const { data: empRole } = await admin.from('roles').select('id').eq('name', 'Employee').single();
      const tpl = await api('superadmin', 'POST', '/api/admin/workflows/templates', { name: `Coverage delivery ${RUN}`, description: 'Build → client sign-off' });
      const tplId = (tpl.body?.template || tpl.body?.data)?.id;
      const node = async (node_type, label, x, extra = {}) => {
        const r = await api('superadmin', 'POST', `/api/admin/workflows/templates/${tplId}/nodes`, { workflow_template_id: tplId, node_type, label, position_x: x, position_y: 100, ...extra });
        return r.body?.node || r.body?.data;
      };
      const nStart = await node('start', 'Start', 0);
      const nBuild = await node('role', `Build ${RUN}`, 200, { entity_id: empRole.id });
      const nSign = await node('approval', `Client sign-off ${RUN}`, 400, { settings: { client_approval: true } });
      const nEnd = await node('end', 'Delivered', 600);
      for (const [a, b] of [[nStart, nBuild], [nBuild, nSign], [nSign, nEnd]]) {
        await api('superadmin', 'POST', `/api/admin/workflows/templates/${tplId}/connections`, { workflow_template_id: tplId, from_node_id: a.id, to_node_id: b.id });
      }
      await api('superadmin', 'PATCH', `/api/admin/workflows/templates/${tplId}`, { is_active: true });
      const { data: sign } = await admin.from('workflow_nodes').select('node_type, settings').eq('id', nSign.id).single();
      report.record('WF-approval-configured', sign?.node_type === 'approval' && sign?.settings?.client_approval === true, 'approval step marked as a client approval');

      const { data: wp } = await admin.from('projects').insert({ name: `Coverage WF ${RUN}`, account_id: IDS.acme, status: 'in_progress', created_by: ids.pm, assigned_user_id: ids.pm, shared_with_client: true, start_date: day(0), end_date: day(30) }).select('id').single();
      await admin.from('project_assignments').insert([{ project_id: wp.id, user_id: ids.pm, role_in_project: 'Project Manager' }, { project_id: wp.id, user_id: ids.emp1, role_in_project: 'Developer' }]);
      const before = (await api('client', 'GET', '/api/client/portal/summary')).body?.data?.totals?.completed ?? 0;
      report.status('WF-start', await api('pm', 'POST', '/api/workflows/start', { projectId: wp.id, workflowTemplateId: tplId }), [200, 201]);
      const { data: inst } = await admin.from('workflow_instances').select('id, current_node_id').eq('project_id', wp.id).single();
      await sleep(500);
      const e1n = await api('emp1', 'GET', '/api/notifications?limit=50');
      report.record('WF-notify-step', (e1n.body?.data || []).some((x) => JSON.stringify(x).includes(`Build ${RUN}`)), 'employees in the step role are notified when the workflow reaches them');
      const steps = await api('emp1', 'GET', `/api/workflows/instances/${inst.id}/active-steps`);
      const active = (steps.body?.activeSteps || steps.body?.steps || steps.body?.data || [])[0];
      report.status('WF-build-done', await api('emp1', 'POST', '/api/workflows/progress', { workflowInstanceId: inst.id, activeStepId: active?.id || null, feedback: 'Built' }), [200, 201]);
      const { data: atSign } = await admin.from('workflow_instances').select('current_node_id').eq('id', inst.id).single();
      report.record('WF-at-client-step', atSign.current_node_id === nSign.id, 'workflow waits at the client sign-off');
      const cn = await api('client', 'GET', '/api/notifications?limit=50');
      report.record('WF-client-asked', (cn.body?.data || []).some((x) => JSON.stringify(x).includes(`Coverage WF ${RUN}`)), 'client notified that an approval is waiting');
      const pmTry = await api('pm', 'POST', '/api/workflows/progress', { workflowInstanceId: inst.id, activeStepId: null, feedback: 'skip the client' });
      const { data: still } = await admin.from('workflow_instances').select('current_node_id, status').eq('id', inst.id).single();
      report.record('WF-internal-cannot-approve', pmTry.status === 409 && still.current_node_id === nSign.id && still.status === 'active', `the manager cannot pass the client's step for them (${pmTry.status}: ${pmTry.body?.error})`);
      await open(pm, `/projects/${wp.id}`);
      report.record('WF-internal-sees-waiting', await visible(pm.getByText('Waiting for the client:')) && await pm.getByRole('button', { name: 'Send to Next Step' }).count() === 0, 'project page says the step is waiting for the client');

      const cp = await pageAs('client');
      await open(cp, '/client-portal/approvals');
      const waiting = await visible(cp.getByRole('link', { name: new RegExp(`Coverage WF ${RUN}`) }));
      report.record('CLIENT-approvals-list', waiting, '"Project stages waiting for you" lists the project');
      await cp.getByRole('link', { name: new RegExp(`Coverage WF ${RUN}`) }).first().click();
      await settle(cp);
      await cp.getByRole('button', { name: /^Approve/ }).first().click();
      await cp.getByRole('button', { name: 'Confirm Approval' }).click();
      const approvedToast = await visible(cp.getByText('Project approved'));
      await sleep(1500);
      const { data: fin } = await admin.from('workflow_instances').select('status').eq('id', inst.id).single();
      const { data: wpRow } = await admin.from('projects').select('status').eq('id', wp.id).single();
      report.record('WF-client-approved', approvedToast && fin.status === 'completed' && wpRow.status === 'complete', `client approved in the portal → workflow ${fin.status}, project ${wpRow.status}`);
      await shot(cp, 'client-approved');

      const tl = await api('client', 'GET', `/api/client/portal/projects/${wp.id}/timeline`);
      const stages = tl.body?.data?.stages || [];
      report.record('CLIENT-stages', stages.length >= 2 && stages.every((s) => s.state === 'completed'), `timeline stages: ${stages.map((s) => `${s.label}=${s.state}`).join(', ')}`);
      const after = (await api('client', 'GET', '/api/client/portal/summary')).body?.data?.totals?.completed ?? 0;
      await open(cp, '/client-portal');
      const tile = await cp.locator('a,div', { has: cp.getByText('Completed projects', { exact: true }) }).first().innerText().catch(() => '');
      report.record('CLIENT-completed-count', after === before + 1 && tile.includes(String(after)), `completed projects ${before} → ${after} (dashboard tile)`);
      const cn2 = await api('client', 'GET', '/api/notifications?limit=50');
      report.record('CLIENT-notify-status', (cn2.body?.data || []).some((x) => JSON.stringify(x).includes(`Coverage WF ${RUN}`) && /complete/i.test(JSON.stringify(x))), 'client notified that the project is complete');
      report.status('CLIENT-update-shared', await api('pm', 'POST', `/api/projects/${P}/updates`, { content: `Weekly update ${RUN}`, client_visible: true }), [200, 201], 'manager shares an update');
      const cn3 = await api('client', 'GET', '/api/notifications?limit=50');
      report.record('CLIENT-notify-activity', (cn3.body?.data || []).some((x) => JSON.stringify(x).includes(`Coverage ${RUN}`)), 'client notified of the shared update');
      await cp.context().close();
    });

    // ================================================================ G. Client accounts, Team Lead
    report.start('G. Client accounts and the Team Lead role');
    await step('CLIENT-account', async () => {
      const sa = await pageAs('superadmin');
      await open(sa, '/admin/users');
      await sa.getByRole('button', { name: 'Clients', exact: true }).click();
      await settle(sa);
      const row = sa.locator('tr', { hasText: PERSONAS.client2.email });
      report.record('CLIENT-listed', await visible(row) && (await row.innerText()).includes('Globex'), 'Clients filter lists the client with their company');
      await row.getByRole('button', { name: 'Deactivate' }).click();
      const off = await visible(row.getByText('Deactivated'));
      const blocked = await signIn(env, PERSONAS.client2.email).then(() => false).catch(() => true);
      report.record('CLIENT-deactivated', off && blocked, 'deactivated client cannot sign in');
      await row.getByRole('button', { name: 'Reactivate' }).click();
      await visible(row.getByText('Active'));
      const back = await signIn(env, PERSONAS.client2.email).then(() => true).catch(() => false);
      report.record('CLIENT-reactivated', back, 'reactivated client can sign in again');
      await sa.context().close();
    });
    await step('TEAM-LEAD', async () => {
      const email = `e2e.teamlead.${RUN}@example.com`;
      const { data: u } = await admin.auth.admin.createUser({ email, password: 'Teamlead2026x', email_confirm: true, user_metadata: { name: 'Tara TeamLead' } });
      await admin.from('user_profiles').update({ name: 'Tara TeamLead' }).eq('id', u.user.id);
      const { data: tlRole } = await admin.from('roles').select('id').eq('name', 'Team Lead').single();
      await admin.from('user_roles').insert({ user_id: u.user.id, role_id: tlRole.id });
      await admin.from('project_assignments').insert({ project_id: P, user_id: u.user.id, role_in_project: 'Team Lead' });
      S.tl = await signIn(env, email, 'Teamlead2026x');
      const entryDate = day(0);
      report.status('TL-time-entry', await api('emp2', 'POST', '/api/time-entries', { projectId: P, taskId: T.design, hoursLogged: 2.5, entryDate, description: `Design work ${RUN}` }), [200, 201]);
      report.status('TL-submit', await api('emp2', 'POST', '/api/me/timesheets', { weekStart: mondayOf() }), 201, 'employee submits the week');
      const tl = await pageAs('tl');
      await open(tl, '/');
      const landed = await tl.waitForURL((x) => x.pathname === '/manager', { timeout: 30000 }).then(() => true).catch(() => false);
      report.record('TL-lands-manager', landed, `Team Lead opens the app → ${new URL(tl.url()).pathname}`);
      await open(tl, '/manager/timesheets');
      // The page opens on last week; Meera submitted this week
      await tl.getByRole('button', { name: 'Next week' }).click();
      await settle(tl);
      const row = tl.locator('tr', { hasText: 'Meera Designer' }).first();
      await row.getByRole('button', { name: 'Approve' }).click();
      await sleep(1500);
      const { data: ts } = await admin.from('timesheets').select('status, reviewed_by').eq('user_id', ids.emp2).eq('week_start_date', mondayOf()).single();
      report.record('TL-approves', ts?.status === 'approved' && ts?.reviewed_by === u.user.id, `Team Lead approved Meera's timesheet (status ${ts?.status})`);
      report.status('TL-cannot-manage', await api('tl', 'PUT', `/api/projects/${P}/allocations`, { changes: [{ taskId: T.build, weekStartDate: W0, hours: 1 }] }), 403, 'a Team Lead does not manage the project');
      await tl.context().close();
    });
    await emp.context().close();
    await pm.context().close();
  } finally {
    await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 15000))]);
  }
}

main().catch((e) => report.error('UNCAUGHT', e)).finally(() => process.exit(report.summary() ? 1 : 0));
