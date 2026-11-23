// Batch D of Phase 11: the project page, the workflow views and progress dialog, and the create / edit
// project and task dialogs moved behind API endpoints.
//
// Each endpoint runs the lookups the browser used to run, as the signed-in user, so row-level security
// still decides. Checked here against the same lookups run straight on the Supabase data API as the
// same user, for several personas; the create-project write is allowed and refused as the data API
// allows and refuses it; and in a real browser the project page makes no direct database requests for
// these lookups and no API call fails.
//
// NON-DESTRUCTIVE: one temporary active workflow run (copied from a finished one) and the projects the
// test creates are removed at the end. Local Supabase only (app on port 3100). Needs the seeded personas.
//
// Usage: node tests/local-e2e/browser-reads-d.mjs
import { chromium } from '@playwright/test';
import { loadEnv, adminClient, signIn, call, Report, chromePath } from './lib.mjs';
import { PERSONAS } from './seed.mjs';

const env = loadEnv();
const admin = adminClient(env);
const report = new Report('Browser reads moved to the API (batch D)');
const WHO = ['superadmin', 'pm', 'emp1', 'outsider'];
const S = {};
const RUN = `brd-${Date.now().toString(36)}`;
const made = { instances: [], projects: [] };
const PROJECT = '0e2e0000-0000-4000-8000-00000000b001';

const norm = (v) => Array.isArray(v) ? v.map(norm) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])])) : v;
const eq = (a, b) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));
const same = (a, b) => JSON.stringify((a || []).map((r) => JSON.stringify(norm(r))).sort()) === JSON.stringify((b || []).map((r) => JSON.stringify(norm(r))).sort());
const body = (r) => r.body?.data;
const ids = (rows) => (rows || []).map((r) => r.id).sort();

async function main() {
  for (const key of [...WHO, 'client']) S[key] = await signIn(env, PERSONAS[key].email);
  const { data: done } = await admin.from('workflow_instances').select('*').not('current_node_id', 'is', null).limit(1).single();
  const { id: _id, ...copy } = done;
  const { data: inst, error } = await admin.from('workflow_instances').insert({ ...copy, status: 'active', completed_at: null, completed_snapshot: null }).select('*').single();
  if (error) throw new Error(`workflow run: ${error.message}`);
  made.instances.push(inst.id);
  try { await checks(inst); } finally {
    if (made.projects.length) await admin.from('projects').delete().in('id', made.projects);
    await admin.from('workflow_instances').delete().in('id', made.instances);
    const left = (await admin.from('projects').select('id', { count: 'exact', head: true }).like('name', `${RUN}%`)).count;
    report.record('cleanup', left === 0, `${made.projects.length} test project(s) and the temporary workflow run removed`);
  }
}

async function checks(inst) {
  const projectId = inst.project_id;
  report.start('Signed out, client accounts and bad input');
  const reads = [`/api/projects/${PROJECT}/page-data?view=status`, `/api/projects/${PROJECT}/assignable-people`, '/api/projects/new',
    `/api/workflows/instances/${inst.id}/view-data`, `/api/workflows/instances/${inst.id}/progress-data?view=access`];
  for (const url of reads) report.status(`signed-out ${url.split('?')[0]}`, await call(env, null, 'GET', url), 401);
  for (const url of reads) report.status(`client ${url.split('?')[0]}`, await call(env, S.client, 'GET', url), 403);
  report.status('bad-view', await call(env, S.pm, 'GET', `/api/projects/${PROJECT}/page-data?view=everything`), 400);
  report.status('form-data-needs-run', await call(env, S.pm, 'GET', `/api/projects/${PROJECT}/page-data?view=form-data`), 400);
  report.status('progress-data-needs-project', await call(env, S.pm, 'GET', `/api/workflows/instances/${inst.id}/progress-data?view=data`), 400);
  report.status('bad-new-project', await call(env, S.superadmin, 'POST', '/api/projects/new', { name: '', accountId: 'x', priority: 'top' }), 400);

  for (const key of WHO) {
    const who = S[key];
    const db = who.db;
    report.start(`Same results as the data API, as ${key}`);

    for (const pid of [PROJECT, projectId]) {
      const ov = await call(env, who, 'GET', `/api/projects/${pid}/page-data?view=overview`);
      const row = (await db.from('projects').select('*, account:accounts(*)').eq('id', pid).maybeSingle()).data;
      if (!row) { report.record(`overview ${pid.slice(0, 8)}`, ov.status === 404, `not visible: ${ov.status}`); continue; }
      const sh = (await db.rpc('get_project_stakeholders', { project_uuid: pid })).data || [];
      const o = body(ov);
      const { workflow_instance_id: _w, departments: _d, assigned_user: _a, stakeholders: _s, ...rest } = o?.project || {};
      const { workflow_instance_id: _w2, ...rowRest } = row;
      report.record(`overview ${pid.slice(0, 8)}`, ov.status === 200 && eq(rest, rowRest) && o.project.stakeholders.length === sh.length && typeof o.canEdit === 'boolean',
        `project row, ${sh.length} stakeholder(s), ${o?.project?.departments?.length} department(s), steps ${JSON.stringify(o?.stepNames)}, can edit: ${o?.canEdit}`);
    }

    const st = await call(env, who, 'GET', `/api/projects/${PROJECT}/page-data?view=status`);
    const std = await db.from('projects').select('status, completed_at, workflow_instance_id').eq('id', PROJECT).single();
    report.record('status', std.error ? st.status >= 400 : st.status === 200 && eq(body(st), std.data), std.error ? `not visible (${st.status})` : body(st)?.status);

    const tk = await call(env, who, 'GET', `/api/projects/${PROJECT}/page-data?view=tasks`);
    const tkd = (await db.from('tasks').select('id').eq('project_id', PROJECT)).data || [];
    const ph = ((await db.from('time_entries').select('hours_logged').eq('project_id', PROJECT).is('task_id', null)).data || []).reduce((s, e) => s + (e.hours_logged || 0), 0);
    report.record('tasks', tk.status === 200 && eq(ids(body(tk)?.tasks), ids(tkd)) && body(tk)?.projectHours === ph, `${tkd.length} task(s), ${ph}h on the project`);

    const lr = await call(env, who, 'GET', `/api/projects/${projectId}/page-data?view=latest-run`);
    const lrd = (await db.from('workflow_instances').select('id, status').eq('project_id', projectId).in('status', ['active', 'completed']).order('started_at', { ascending: false }).limit(1)).data;
    report.record('latest-run', lr.status === 200 && eq(body(lr), lrd?.[0] ?? null), body(lr)?.id ? `run ${body(lr).status}` : 'none visible');

    const pp = await call(env, who, 'GET', `/api/projects/${PROJECT}/page-data?view=people`);
    const ppd = (await db.from('user_profiles').select('id, name, email').order('name')).data;
    report.record('people', pp.status === 200 && eq(body(pp), ppd), `${ppd?.length} people`);

    const ct = await call(env, who, 'GET', `/api/projects/${PROJECT}/page-data?view=contributors`);
    report.record('contributors', ct.status === 200 && Array.isArray(body(ct)) && body(ct).length === 0, 'none (the table does not exist, as before)');

    const fd = await call(env, who, 'GET', `/api/projects/${projectId}/page-data?view=form-data&instanceId=${inst.id}`);
    const hd = await db.from('workflow_history').select('id').eq('workflow_instance_id', inst.id);
    report.record('form-data', hd.error ? fd.status === 200 && body(fd) === null : fd.status === 200 && Array.isArray(body(fd)), `${(body(fd) || []).length} form(s) from ${(hd.data || []).length} transition(s)`);

    const ap = await call(env, who, 'GET', `/api/projects/${PROJECT}/assignable-people`);
    const team = (await db.from('project_assignments').select('user_profiles!project_assignments_user_id_fkey ( id )').eq('project_id', PROJECT).is('removed_at', null)).data || [];
    report.record('assignable-people', ap.status === 200 && eq(ids(body(ap)), [...new Set(team.map((t) => t.user_profiles?.id).filter(Boolean))].sort().map((id) => id) ) && (body(ap) || []).every((p) => p.roles.length > 0),
      `${(body(ap) || []).length} team member(s), each with roles`);

    const np = await call(env, who, 'GET', '/api/projects/new');
    const [acc, wfs] = await Promise.all([db.from('accounts').select('id, name').order('name'), db.from('workflow_templates').select('id, name, description').eq('is_active', true).order('name')]);
    report.record('new-project-options', np.status === 200 && eq(body(np)?.accounts, acc.data) && eq(body(np)?.workflows, wfs.data), `${acc.data?.length} account(s), ${wfs.data?.length} workflow(s)`);

    const vd = await call(env, who, 'GET', `/api/workflows/instances/${inst.id}/view-data`);
    const visibleRun = !!(await db.from('workflow_instances').select('id').eq('id', inst.id).maybeSingle()).data;
    if (!visibleRun) report.record('view-data', vd.status === 404, `run not visible: ${vd.status}`);
    else {
      const [stepsD, histD] = await Promise.all([
        db.from('workflow_active_steps').select('*, assigned_user:user_profiles!workflow_active_steps_assigned_user_id_fkey(name)').eq('workflow_instance_id', inst.id).in('status', ['active', 'waiting']),
        db.from('workflow_history').select('from_node_id, to_node_id').eq('workflow_instance_id', inst.id),
      ]);
      report.record('view-data', vd.status === 200 && body(vd)?.instance?.id === inst.id && same(body(vd)?.activeSteps, stepsD.data) && same(body(vd)?.history, histD.data),
        `run, ${stepsD.data?.length} active step(s), ${histD.data?.length} transition(s)`);
    }

    const ac = await call(env, who, 'GET', `/api/workflows/instances/${inst.id}/progress-data?view=access`);
    const a = body(ac);
    const assigned = ((await db.from('project_assignments').select('id').eq('user_id', who.userId).eq('project_id', projectId).is('removed_at', null)).data || []).length > 0;
    const accessOk = !visibleRun ? ac.status === 200 && a === null
      : key === 'superadmin' ? a?.isSuperadmin === true && a?.hasRequiredRole === true && a?.isAssignedToProject === true
      : a?.isSuperadmin === false && a?.isAssignedToProject === assigned && typeof a?.hasRequiredRole === 'boolean';
    report.record('progress-access', ac.status === 200 && accessOk, visibleRun ? `assigned: ${a?.isAssignedToProject}, may act: ${a?.hasRequiredRole}${a?.requiredRoleName ? ` (needs ${a.requiredRoleName})` : ''}` : 'run not visible: nothing');

    const pd = await call(env, who, 'GET', `/api/workflows/instances/${inst.id}/progress-data?view=data&projectId=${projectId}`);
    const d = body(pd);
    const snapNodes = inst.started_snapshot?.nodes || [];
    const conns = (inst.started_snapshot?.connections || []).filter((c) => c.from_node_id === inst.current_node_id && !c.condition?.decision && !c.condition?.conditionValue);
    const wantNext = snapNodes.filter((n) => conns.some((c) => c.to_node_id === n.id)).map((n) => n.id).sort();
    report.record('progress-data', !visibleRun ? pd.status === 200 && d === null
      : pd.status === 200 && d?.instance?.id === inst.id && d?.instance?.workflow_nodes?.id === inst.current_node_id && eq(ids(d?.nextNodes), wantNext),
      visibleRun ? `step "${d?.instance?.workflow_nodes?.label}", ${d?.nextNodes?.length} next step(s), form: ${d?.formTemplate ? 'yes' : 'no'}` : 'run not visible: nothing');
  }

  report.start('Create project (dialog): allowed and refused as row-level security decides');
  const { data: acct } = await admin.from('accounts').select('id').limit(1).single();
  for (const key of ['emp1', 'pm', 'superadmin']) {
    const r = await call(env, S[key], 'POST', '/api/projects/new', { name: `${RUN} ${key}`, accountId: acct.id, priority: 'medium', startDate: '2026-12-01', endDate: '2026-12-31', estimatedHours: 12, assignToMe: key === 'pm' });
    if (body(r)?.id) made.projects.push(body(r).id);
    const probe = await S[key].db.from('projects').insert({ name: `${RUN} probe ${key}`, account_id: acct.id, status: 'planning', priority: 'medium', created_by: S[key].userId, actual_hours: 0 }).select('id');
    if (probe.data?.length) made.projects.push(probe.data[0].id);
    const may = !probe.error && probe.data?.length === 1;
    const row = body(r);
    report.record(`create ${key}`, may ? r.status === 201 && row.created_by === S[key].userId && row.priority === 'medium' && row.estimated_hours === 12 && (key === 'pm' ? row.assigned_user_id === S[key].userId : true) : r.status === 403,
      may ? `created${key === 'pm' ? ', creator is the lead' : ''}` : `refused (${r.status})`);
  }

  report.start('Browser: the project page makes no direct requests for these, and no API call fails');
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
  try {
    for (const [key, pid] of [['pm', PROJECT], ['superadmin', projectId]]) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await ctx.addCookies(S[key].cookie.split('; ').map((kv) => { const i = kv.indexOf('='); return { name: kv.slice(0, i), value: kv.slice(i + 1), url: env.appUrl }; }));
      const page = await ctx.newPage();
      const direct = [];
      const errors = [];
      page.on('request', (r) => { if (r.url().includes('/rest/v1/')) direct.push(decodeURIComponent(r.url().split('/rest/v1/')[1])); });
      page.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 500) errors.push(`${r.status()} ${new URL(r.url()).pathname}`); });
      await page.goto(`${env.appUrl}/projects/${pid}`, { waitUntil: 'load' });
      await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});
      const moved = [/^projects\?select=\*,account/, /^rpc\/get_project_stakeholders/, /^project_assignments/, /^workflow_instances/, /^workflow_active_steps/,
        /^workflow_nodes/, /^workflow_connections/, /^workflow_history/, /^tasks/, /^time_entries/, /^form_responses/, /^project_contributors/];
      const bad = direct.filter((u) => moved.some((re) => re.test(u)));
      const title = await page.locator('h1').first().textContent({ timeout: 5000 }).catch(() => '');
      report.record(`project page as ${key}`, bad.length === 0 && errors.length === 0 && !!title,
        `"${(title || '').trim().slice(0, 40)}"; ${bad.length} direct request(s) for moved lookups${bad.length ? `: ${bad.slice(0, 3).join(' | ')}` : ''}${errors.length ? `; API errors: ${errors.join(', ')}` : ''}`);
      if (direct.length) console.log(`    (still direct, for batch E: ${[...new Set(direct.map((u) => u.split('?')[0]))].join(', ')})`);
      await ctx.close();
    }
  } finally {
    await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 15000))]);
  }
}

main()
  .catch((e) => report.error('run', e))
  .finally(() => process.exit(report.summary() ? 1 : 0));
