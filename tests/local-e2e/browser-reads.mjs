// Batch B of Phase 11: small browser reads and writes moved behind API endpoints.
//
// Each endpoint runs the query the component used to run in the browser, as the signed-in user, so
// row-level security still decides. Checked here by running the same query straight against the
// Supabase data API as the same user and comparing the results, for several personas; then in a real
// browser, that the time-entry page and the dashboard make no direct database requests for these tables.
//
// NON-DESTRUCTIVE: the only write is a project's remaining hours, which is put back afterwards.
// Local Supabase only (app on port 3100). Needs the seeded personas: npm run e2e:local:seed
//
// Usage: node tests/local-e2e/browser-reads.mjs
import { chromium } from '@playwright/test';
import { loadEnv, adminClient, signIn, call, Report, chromePath, isoDate, addDays, mondayOf } from './lib.mjs';
import { PERSONAS } from './seed.mjs';

const env = loadEnv();
const admin = adminClient(env);
const report = new Report('Browser reads moved to the API (batch B)');
const WHO = ['superadmin', 'pm', 'emp1', 'outsider', 'client'];
const S = {};

// Rows compared without regard to order (order is checked separately where the API promises one)
const canon = (rows) => JSON.stringify((rows || []).map((r) => JSON.stringify(r)).sort());
const same = (a, b) => canon(a) === canon(b);
const body = (r) => r.body?.data;

const RUN = `brtest-${Date.now().toString(36)}`;
const made = { entries: [], instances: [] };

// Temporary rows so the comparisons cover real data: time entries for two people over a few dates,
// and one active workflow run (copied from a finished one)
async function setUp() {
  const { data: tasks } = await admin.from('tasks').select('id, project_id').limit(3);
  const rows = [];
  for (const key of ['pm', 'emp1']) {
    [0, -2, -9, -25, -50].forEach((days, i) => {
      const t = tasks[i % tasks.length];
      rows.push({ user_id: S[key].userId, task_id: t.id, project_id: t.project_id, hours_logged: 1 + i * 0.5, entry_date: isoDate(addDays(days)),
        week_start_date: mondayOf(addDays(days)), description: `${RUN} ${key} ${i}` });
    });
  }
  const { data: entries, error } = await admin.from('time_entries').insert(rows).select('id');
  if (error) throw new Error(`time entries: ${error.message}`);
  made.entries.push(...entries.map((e) => e.id));

  const { data: done } = await admin.from('workflow_instances').select('*').not('current_node_id', 'is', null).limit(1).maybeSingle();
  if (done) {
    const { id: _id, ...copy } = done;
    const { data: inst, error: iErr } = await admin.from('workflow_instances').insert({ ...copy, status: 'active', completed_at: null, completed_snapshot: null }).select('id').single();
    if (iErr) throw new Error(`workflow run: ${iErr.message}`);
    made.instances.push(inst.id);
  }
}

async function cleanUp() {
  if (made.entries.length) { const { error } = await admin.from('time_entries').delete().in('id', made.entries); if (error) console.error(`  cleanup time entries: ${error.message}`); }
  if (made.instances.length) { const { error } = await admin.from('workflow_instances').delete().in('id', made.instances); if (error) console.error(`  cleanup workflow run: ${error.message}`); }
  const left = (await admin.from('time_entries').select('id', { count: 'exact', head: true }).like('description', `${RUN}%`)).count;
  report.record('cleanup', left === 0 && made.entries.length > 0, `${made.entries.length} temporary time entries and ${made.instances.length} workflow run removed`);
}

async function main() {
  for (const key of WHO) S[key] = await signIn(env, PERSONAS[key].email);
  await setUp();
  try { await checks(); } finally { await cleanUp(); }
}

async function checks() {
  const { data: projects } = await admin.from('projects').select('id, account_id, remaining_hours, updated_at');
  const { data: departments } = await admin.from('departments').select('id');
  const projectIds = projects.map((p) => p.id);
  const ids = projectIds.join(',');

  report.start('Signed out and bad input');
  for (const url of ['/api/workflows/active-instances?projectIds=' + ids, '/api/projects/task-hours?projectIds=' + ids, '/api/me/time-entries',
    '/api/me/time-options', `/api/projects/${projectIds[0]}/tasks`, `/api/breadcrumb?type=project&id=${projectIds[0]}`]) {
    report.status(`signed-out ${url.split('?')[0]}`, await call(env, null, 'GET', url), 401);
  }
  report.status('signed-out remaining-hours', await call(env, null, 'PATCH', `/api/projects/${projectIds[0]}/remaining-hours`, { remaining_hours: 1 }), 401);
  report.status('bad-project-id', await call(env, S.pm, 'GET', "/api/projects/task-hours?projectIds=x');drop table tasks;--"), 400, 'refused, not run');
  report.status('bad-date', await call(env, S.pm, 'GET', '/api/me/time-entries?from=yesterday'), 400);
  report.status('bad-sort', await call(env, S.pm, 'GET', '/api/me/time-entries?sort=password'), 400);
  report.status('bad-breadcrumb', await call(env, S.pm, 'GET', '/api/breadcrumb?type=users&id=' + projectIds[0]), 400);
  report.status('bad-hours', await call(env, S.pm, 'PATCH', `/api/projects/${projectIds[0]}/remaining-hours`, { remaining_hours: -5 }), 400);

  // Client accounts are sent to the client portal, which uses none of these screens: the endpoints
  // refuse them, like the other internal API routes
  report.start('Client accounts are refused');
  for (const url of ['/api/workflows/active-instances?projectIds=' + ids, '/api/projects/task-hours?projectIds=' + ids, '/api/me/time-entries',
    '/api/me/time-options', `/api/projects/${projectIds[0]}/tasks`, `/api/breadcrumb?type=project&id=${projectIds[0]}`]) {
    report.status(`client ${url.split('?')[0]}`, await call(env, S.client, 'GET', url), 403);
  }
  report.status('client remaining-hours', await call(env, S.client, 'PATCH', `/api/projects/${projectIds[0]}/remaining-hours`, { remaining_hours: 1 }), 403);

  for (const key of WHO.filter((k) => k !== 'client')) {
    const who = S[key];
    const db = who.db;
    report.start(`Same rows as the data API, as ${key}`);

    const wf = await call(env, who, 'GET', `/api/workflows/active-instances?projectIds=${ids}`);
    const wfDirect = await db.from('workflow_instances').select('project_id, current_node_id, started_snapshot, workflow_nodes:workflow_nodes!workflow_instances_current_node_id_fkey(label)').in('project_id', projectIds).eq('status', 'active');
    report.record('active-instances', wf.status === 200 && !wfDirect.error && same(body(wf), wfDirect.data), `${body(wf)?.length ?? wf.status} row(s)`);

    const th = await call(env, who, 'GET', `/api/projects/task-hours?projectIds=${ids}`);
    const thDirect = await db.from('tasks').select('project_id, remaining_hours, estimated_hours').in('project_id', projectIds);
    report.record('task-hours', th.status === 200 && same(body(th), thDirect.data), `${body(th)?.length ?? th.status} row(s)`);

    const te = await call(env, who, 'GET', '/api/me/time-entries?sort=entry_date&order=desc&offset=0&limit=50');
    const teDirect = await db.from('time_entries').select('*, tasks(id, name), projects(id, name)', { count: 'exact' }).eq('user_id', who.userId).order('entry_date', { ascending: false }).range(0, 49);
    report.record('time-entries', te.status === 200 && same(body(te), teDirect.data) && te.body?.meta?.count === teDirect.count,
      `${body(te)?.length ?? te.status} row(s), count ${te.body?.meta?.count} vs ${teDirect.count}`);
    const dates = (body(te) || []).map((r) => r.entry_date);
    report.record('time-entries-order', dates.every((d, i) => i === 0 || dates[i - 1] >= d), 'newest first');

    const from = isoDate(addDays(-60)), to = isoDate();
    const tf = await call(env, who, 'GET', `/api/me/time-entries?from=${from}&to=${to}&sort=hours_logged&order=asc`);
    const tfDirect = await db.from('time_entries').select('*, tasks(id, name), projects(id, name)').eq('user_id', who.userId).gte('entry_date', from).lte('entry_date', to).order('hours_logged', { ascending: true }).range(0, 999);
    report.record('time-entries-date-range', tf.status === 200 && same(body(tf), tfDirect.data), `${body(tf)?.length ?? tf.status} row(s) in the last 60 days`);

    const fl = await call(env, who, 'GET', '/api/me/time-entries?view=filters');
    const [flP, flT] = await Promise.all([
      db.from('time_entries').select('project_id, projects(id, name)').eq('user_id', who.userId).not('project_id', 'is', null),
      db.from('time_entries').select('task_id, tasks(id, name)').eq('user_id', who.userId).not('task_id', 'is', null),
    ]);
    report.record('time-entry-filters', fl.status === 200 && same(body(fl)?.projects, flP.data) && same(body(fl)?.tasks, flT.data), 'projects and tasks with time logged');

    const mon = new Date(`${mondayOf()}T12:00:00`);
    const d = { weekFrom: isoDate(mon), weekTo: isoDate(addDays(6, mon)), monthFrom: isoDate(new Date(mon.getFullYear(), mon.getMonth(), 1)), monthTo: isoDate(new Date(mon.getFullYear(), mon.getMonth() + 1, 0)), since: isoDate(addDays(-30)) };
    const sm = await call(env, who, 'GET', `/api/me/time-entries?view=summary&${new URLSearchParams(d)}`);
    const smWeek = await db.from('time_entries').select('hours_logged').eq('user_id', who.userId).gte('entry_date', d.weekFrom).lte('entry_date', d.weekTo);
    const smAll = await db.from('time_entries').select('*', { count: 'exact', head: true }).eq('user_id', who.userId);
    report.record('time-summary', sm.status === 200 && same(body(sm)?.week, smWeek.data) && body(sm)?.count === smAll.count, `${body(sm)?.week?.length} entries this week, ${body(sm)?.count} in all`);

    const op = await call(env, who, 'GET', '/api/me/time-options');
    const opA = await db.from('project_assignments').select('project_id, projects(id, name, status, updated_at)').eq('user_id', who.userId).is('removed_at', null);
    const opT = await db.from('tasks').select('project_id, projects(id, name)').eq('assigned_to', who.userId);
    report.record('time-options', op.status === 200 && same(body(op)?.assignments, opA.data) && same(body(op)?.taskProjects, opT.data), `${body(op)?.assignments?.length} assignment(s)`);

    const ot = await call(env, who, 'GET', `/api/me/time-options?view=tasks&projectIds=${ids}&openOnly=true`);
    const otDirect = await db.from('tasks').select('id, name, project_id').in('project_id', projectIds).neq('status', 'done').order('name');
    report.record('open-tasks', ot.status === 200 && JSON.stringify(body(ot)) === JSON.stringify(otDirect.data), `${body(ot)?.length} open task(s), same order`);

    const p0 = projects[0];
    const pt = await call(env, who, 'GET', `/api/projects/${p0.id}/tasks`);
    const ptDirect = await db.from('tasks').select('id, name, status').eq('project_id', p0.id).order('name');
    report.record('project-tasks', pt.status === 200 && JSON.stringify(body(pt)) === JSON.stringify(ptDirect.data), `${body(pt)?.length} task(s)`);
    if (ptDirect.data?.length) {
      const ex = await call(env, who, 'GET', `/api/projects/${p0.id}/tasks?exclude=${ptDirect.data[0].id}`);
      report.record('project-tasks-exclude', (body(ex) || []).length === ptDirect.data.length - 1 && !(body(ex) || []).some((t) => t.id === ptDirect.data[0].id), 'one task left out');
    }

    let crumbs = true;
    for (const p of projects) {
      const r = await call(env, who, 'GET', `/api/breadcrumb?type=project&id=${p.id}`);
      const x = (await db.from('projects').select('name, account_id, accounts(name)').eq('id', p.id).maybeSingle()).data;
      const want = x ? { name: x.name, accountId: x.account_id, accountName: x.accounts?.name ?? null } : null;
      if (JSON.stringify(body(r)) !== JSON.stringify(want)) crumbs = false;
      if (p.account_id) {
        const a = await call(env, who, 'GET', `/api/breadcrumb?type=account&id=${p.account_id}`);
        const ax = (await db.from('accounts').select('name').eq('id', p.account_id).maybeSingle()).data;
        if (JSON.stringify(body(a)) !== JSON.stringify(ax)) crumbs = false;
      }
    }
    for (const dep of departments) {
      const r = await call(env, who, 'GET', `/api/breadcrumb?type=department&id=${dep.id}`);
      const x = (await db.from('departments').select('name').eq('id', dep.id).maybeSingle()).data;
      if (JSON.stringify(body(r)) !== JSON.stringify(x)) crumbs = false;
    }
    report.record('breadcrumb-names', crumbs, `${projects.length} project(s), their accounts, ${departments.length} department(s): names only where the user may see them`);
  }

  report.start('Remaining hours (a write)');
  const target = projects[0];
  try {
    for (const key of WHO.filter((k) => k !== 'client')) {
      const who = S[key];
      const value = 7.5 + WHO.indexOf(key);
      // What the data API would allow this user, without changing anything: a policy check on a no-op update
      const allowed = await who.db.from('projects').update({ remaining_hours: target.remaining_hours }).eq('id', target.id).select('id');
      const r = await call(env, who, 'PATCH', `/api/projects/${target.id}/remaining-hours`, { remaining_hours: value });
      const may = !allowed.error && allowed.data?.length === 1;
      const after = (await admin.from('projects').select('remaining_hours').eq('id', target.id).single()).data;
      report.record(`remaining-hours ${key}`, may ? r.status === 200 && Number(after.remaining_hours) === value : r.status === 404 && Number(after.remaining_hours) !== value,
        may ? `saved ${value}h` : `refused (${r.status}), as the data API refuses it`);
      await admin.from('projects').update({ remaining_hours: target.remaining_hours, updated_at: target.updated_at }).eq('id', target.id);
    }
  } finally {
    await admin.from('projects').update({ remaining_hours: target.remaining_hours, updated_at: target.updated_at }).eq('id', target.id);
  }

  report.start('Browser makes no direct database requests for these');
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
  try {
    for (const [key, pagePath, tables] of [
      ['emp1', '/time-entries', ['time_entries', 'project_assignments', 'tasks', 'projects']],
      ['pm', '/dashboard', ['time_entries', 'project_assignments']],
    ]) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await ctx.addCookies(S[key].cookie.split('; ').map((kv) => { const i = kv.indexOf('='); return { name: kv.slice(0, i), value: kv.slice(i + 1), url: env.appUrl }; }));
      const page = await ctx.newPage();
      const direct = [];
      const apiCalls = [];
      page.on('request', (r) => {
        const m = r.url().match(/\/rest\/v1\/([a-z_]+)/);
        if (m) direct.push(m[1]);
        if (/\/api\/(me|breadcrumb|projects\/task-hours|workflows\/active-instances)/.test(r.url())) apiCalls.push(new URL(r.url()).pathname);
      });
      await page.goto(env.appUrl + pagePath, { waitUntil: 'load' });
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      const bad = direct.filter((t) => tables.includes(t));
      report.record(`${pagePath}-no-direct`, bad.length === 0, `${bad.length} direct request(s) for ${tables.join('/')}; API calls: ${[...new Set(apiCalls)].join(', ') || 'none'}`);
      if (direct.length) console.log(`    (still direct on ${pagePath}, for later batches: ${[...new Set(direct)].join(', ')})`);
      await ctx.close();
    }
  } finally {
    await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 15000))]);
  }
}

main()
  .catch((e) => report.error('run', e))
  .finally(() => process.exit(report.summary() ? 1 : 0));
