// Local end-to-end flows: real users, real Next.js server (port 3100), real local Supabase.
// Usage: node tests/local-e2e/flows.mjs   (after `npx supabase start`, the seed, and `npm run dev`)
import { loadEnv, adminClient, signIn, call, payload, Report, isoDate, addDays, mondayOf } from './lib.mjs';
import { seed, IDS, PERSONAS } from './seed.mjs';

const report = new Report('Local E2E flows');
const RUN = Date.now().toString(36); // keeps names unique across re-runs
const env = loadEnv();
const admin = adminClient(env);

const S = {}; // signed-in sessions by persona
const asList = (r) => { const p = payload(r); return Array.isArray(p) ? p : Array.isArray(p?.items) ? p.items : Array.isArray(p?.rows) ? p.rows : []; };
const step = async (id, fn) => { try { await fn(); } catch (e) { report.error(id, e); } };
const api = (who, method, path, body) => call(env, who ? S[who] : null, method, path, body);
const upload = async (who, urlPath, name, content, fields = {}) => {
  const fd = new FormData();
  fd.append('file', new Blob([content], { type: 'text/plain' }), name);
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const res = await fetch(env.appUrl + urlPath, { method: 'POST', headers: { cookie: S[who].cookie, origin: env.appUrl }, body: fd, redirect: 'manual' });
  const text = await res.text();
  let body = null; try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body, text, headers: res.headers };
};
const has = (r, needle) => JSON.stringify(r?.body ?? r ?? '').includes(needle);
const notifs = async (who) => asList(await api(who, 'GET', '/api/notifications?limit=100')).concat(payload(await api(who, 'GET', '/api/notifications?limit=100'))?.notifications || []);

async function main() {
  // ------------------------------------------------------------------ setup
  report.start('Setup');
  const { ids } = await seed({ quiet: true });
  report.record('SEED', true, '9 personas, 2 accounts, 3 projects');
  const health = await call(env, null, 'GET', '/login');
  if (!report.status('APP-up', health, 200, env.appUrl)) return;
  for (const key of Object.keys(PERSONAS)) {
    await step(`AUTH-${key}`, async () => { S[key] = await signIn(env, PERSONAS[key].email); report.record(`AUTH-${key}`, true, 'signed in'); });
  }
  const today = new Date();
  const ws = mondayOf(today);

  // ------------------------------------------------------------------ access basics
  report.start('Access control');
  report.status('ACC-anon', await api(null, 'GET', '/api/me/tasks'), 401, 'not signed in');
  report.status('ACC-client-internal-api', await api('client', 'GET', '/api/me/tasks'), 403, 'client blocked from internal API');
  report.status('ACC-emp-manager-api', await api('emp1', 'GET', '/api/manager/overview'), [403, 200]);
  report.status('ACC-outsider-project', await api('outsider', 'GET', `/api/projects/${IDS.website}`), [403, 404]);
  await step('ACC-outsider-db', async () => {
    const { data } = await S.outsider.db.from('tasks').select('id').eq('project_id', IDS.website);
    report.record('ACC-outsider-db', (data || []).length === 0, `outsider reads ${(data || []).length} website tasks directly`);
  });
  await step('ACC-client-db', async () => {
    const [p, t] = await Promise.all([S.client.db.from('projects').select('id'), S.client.db.from('tasks').select('id')]);
    report.record('ACC-client-db', (p.data || []).length === 0 && (t.data || []).length === 0, `client direct reads: projects=${(p.data || []).length} tasks=${(t.data || []).length}`);
  });

  // ------------------------------------------------------------------ manager: projects & budget
  report.start('Manager: projects, budget, milestones, templates');
  report.status('PRJ-overview', await api('pm', 'GET', '/api/manager/overview'), 200);
  report.status('PRJ-budget-set', await api('pm', 'PATCH', `/api/projects/${IDS.website}`, { budget: 482000, hourly_rate: 1500, currency: 'INR' }), 200);
  await step('PRJ-budget-read', async () => {
    const r = await api('pm', 'GET', `/api/projects/${IDS.website}/budget`);
    const d = payload(r);
    report.record('PRJ-budget-read', r.status === 200 && Number(d?.budget) === 482000 && (d?.currency || d?.project_currency) === 'INR', `status ${r.status} budget=${d?.budget} currency=${d?.currency ?? d?.project_currency}`);
  });
  report.status('PRJ-budget-emp', await api('emp1', 'GET', `/api/projects/${IDS.website}/budget`), [403, 404], 'employee cannot read budget');
  report.status('PRJ-budget-otherpm', await api('pm2', 'GET', `/api/projects/${IDS.website}/budget`), [403, 404], 'manager of another project cannot');
  report.status('PRJ-budget-exec', await api('executive', 'GET', `/api/projects/${IDS.website}/budget`), 200, 'org-wide viewer can');
  await step('PRJ-budget-leak', async () => {
    const r = await api('emp1', 'GET', `/api/projects/${IDS.website}`);
    const p = r.body?.project || payload(r);
    const { data: fin } = await S.emp1.db.from('project_financials').select('budget');
    report.record('PRJ-budget-leak', r.status === 200 && p && !('budget' in p) && !('hourly_rate' in p) && (fin || []).length === 0, `project API keys budget=${p && 'budget' in p}; direct financials rows=${(fin || []).length}`);
  });
  report.status('PRJ-pm-invalid', await api('pm', 'PATCH', `/api/projects/${IDS.website}`, { assigned_user_id: ids.emp1 }), [400, 403], 'employee cannot be made project manager');

  let newProject;
  await step('PRJ-create', async () => {
    const r = await api('pm', 'POST', '/api/projects', { name: `E2E created ${RUN}`, accountId: IDS.acme, start_date: isoDate(today), end_date: isoDate(addDays(20)), status: 'planning', budget: 125000.5 });
    newProject = r.body?.project || payload(r);
    report.status('PRJ-create', r, [200, 201], newProject?.id ? `id ${newProject.id.slice(0, 8)}` : '');
  });
  if (newProject?.id) {
    report.status('PRJ-complete', await api('pm', 'POST', `/api/projects/${newProject.id}/complete`, {}), 200);
    await step('PRJ-complete-db', async () => {
      const { data } = await admin.from('projects').select('status, completed_at').eq('id', newProject.id).single();
      report.record('PRJ-complete-db', data.status === 'complete', `status=${data.status} completed_at=${data.completed_at ? 'set' : 'null'}`);
    });
    report.status('PRJ-reopen', await api('pm', 'POST', `/api/projects/${newProject.id}/reopen`, {}), 200);
    report.status('PRJ-archive', await api('pm', 'POST', `/api/projects/${newProject.id}/actions`, { action: 'archive' }), 200);
    await step('PRJ-archive-hidden', async () => {
      const r = await api('pm', 'GET', '/api/projects');
      const list = r.body?.projects || asList(r);
      report.record('PRJ-archive-hidden', r.status === 200 && !list.some((p) => p.id === newProject.id), `status ${r.status}, archived project listed=${list.some((p) => p.id === newProject.id)}`);
    });
    report.status('PRJ-archive-readonly', await api('pm', 'POST', '/api/tasks', { name: 'On archived project', project_id: newProject.id }), [403, 409, 400], 'no new tasks on an archived project');
    report.status('PRJ-unarchive', await api('pm', 'POST', `/api/projects/${newProject.id}/actions`, { action: 'unarchive' }), 200);
    await step('PRJ-edit', async () => {
      const r = await api('pm', 'PATCH', `/api/projects/${newProject.id}`, { priority: 'urgent', description: `Edited ${RUN}`, status: 'in_progress', end_date: isoDate(addDays(25)) });
      const { data } = await admin.from('projects').select('priority, description, status, end_date').eq('id', newProject.id).single();
      report.record('PRJ-edit', r.status === 200 && data.priority === 'urgent' && data.description === `Edited ${RUN}` && data.status === 'in_progress' && data.end_date === isoDate(addDays(25)), `status ${r.status}; priority=${data.priority} status=${data.status} end=${data.end_date}`);
    });
    report.status('PRJ-assign', await api('pm', 'POST', `/api/projects/${newProject.id}/assignments`, { userId: ids.emp2, roleInProject: 'Designer' }), [200, 201], 'employee added to the team');
    report.status('PRJ-assign-access', await api('emp2', 'GET', `/api/projects/${newProject.id}`), 200, 'new member can open the project');
    report.status('PRJ-assign-emp', await api('emp2', 'POST', `/api/projects/${newProject.id}/assignments`, { userId: ids.outsider }), [403], 'employees cannot change the team');
    await step('PRJ-pm-assign', async () => {
      const r = await api('pm', 'PATCH', `/api/projects/${newProject.id}`, { assigned_user_id: ids.pm2 });
      const { data } = await admin.from('projects').select('assigned_user_id').eq('id', newProject.id).single();
      report.record('PRJ-pm-assign', r.status === 200 && data.assigned_user_id === ids.pm2, `status ${r.status}; project manager is now ${data.assigned_user_id === ids.pm2 ? 'pm2' : data.assigned_user_id}`);
    });
  }
  await step('PRJ-milestone', async () => {
    const r = await api('pm', 'POST', `/api/projects/${IDS.website}/milestones`, { name: `Beta launch ${RUN}`, date: isoDate(addDays(10)), client_visible: true });
    report.status('PRJ-milestone', r, [200, 201]);
  });
  report.status('PRJ-milestone-emp', await api('emp1', 'POST', `/api/projects/${IDS.website}/milestones`, { name: 'Emp milestone', date: isoDate(addDays(5)) }), [403], 'employees cannot add milestones');
  let template;
  await step('PRJ-template-save', async () => {
    const r = await api('pm', 'POST', `/api/projects/${IDS.website}/actions`, { action: 'save_as_template', name: `Website template ${RUN}` });
    template = payload(r)?.template || payload(r);
    report.status('PRJ-template-save', r, [200, 201]);
  });
  if (template?.id) {
    await step('PRJ-from-template', async () => {
      const r = await api('pm', 'POST', '/api/projects/from-template', { template_id: template.id, name: `From template ${RUN}`, account_id: IDS.acme, start_date: isoDate(today) });
      report.status('PRJ-from-template', r, [200, 201]);
    });
  }

  // ------------------------------------------------------------------ tasks: lifecycle and review
  report.start('Tasks: create, edit rules, statuses, review');
  let T1, T2, T3, empTask;
  await step('TSK-create', async () => {
    const r = await api('pm', 'POST', '/api/tasks', { name: `Build login page ${RUN}`, description: 'Email + password, error states', project_id: IDS.website, assigned_to: ids.emp1, reviewer_id: ids.pm, priority: 'high', start_date: isoDate(today), due_date: isoDate(addDays(5)), estimated_hours: 6 });
    T1 = payload(r);
    report.status('TSK-create', r, 201);
  });
  report.status('TSK-emp-reviewer', await api('emp1', 'POST', '/api/tasks', { name: 'Self review', project_id: IDS.website, assigned_to: ids.emp1, reviewer_id: ids.emp2 }), 403, 'only a manager chooses the reviewer');
  report.status('TSK-bad-dates', await api('pm', 'POST', '/api/tasks', { name: 'Bad dates', project_id: IDS.website, start_date: isoDate(addDays(5)), due_date: isoDate(today) }), 400);
  report.status('TSK-assign-outsider', await api('pm', 'POST', '/api/tasks', { name: 'Outsider', project_id: IDS.website, assigned_to: ids.outsider }), [400, 403], 'assignee must be on the team');
  await step('TSK-emp-create', async () => {
    const r = await api('emp1', 'POST', '/api/tasks', { name: `Write tests ${RUN}`, project_id: IDS.website, priority: 'medium', estimated_hours: 2 });
    empTask = payload(r);
    report.status('TSK-emp-create', r, 201, 'employee creates a task in an assigned project');
  });
  report.status('TSK-outsider-create', await api('outsider', 'POST', '/api/tasks', { name: 'Nope', project_id: IDS.website }), [403, 404]);
  if (T1?.id) {
    report.status('TSK-emp-priority', await api('emp1', 'PATCH', `/api/tasks/${T1.id}`, { priority: 'low' }), 403, 'assignee cannot change priority');
    report.status('TSK-emp-description', await api('emp1', 'PATCH', `/api/tasks/${T1.id}`, { description: 'Updated by assignee' }), 200);
    report.status('TSK-emp-progress', await api('emp1', 'PATCH', `/api/tasks/${T1.id}`, { progress_percent: 40 }), 200);
    const st = async (who, action, note) => api(who, 'POST', `/api/tasks/${T1.id}/status`, { action, ...(note ? { note } : {}) });
    const statusIs = async (id, want) => {
      const { data } = await admin.from('tasks').select('status').eq('id', T1.id).single();
      report.record(id, data.status === want, `status=${data.status}`);
    };
    report.status('TSK-start', await st('emp1', 'start'), 200); await statusIs('TSK-start-db', 'in_progress');
    report.status('TSK-pause', await st('emp1', 'pause'), 200); await statusIs('TSK-pause-db', 'on_hold');
    report.status('TSK-resume', await st('emp1', 'resume'), 200);
    report.status('TSK-submit', await st('emp1', 'submit'), 200); await statusIs('TSK-submit-db', 'review');
    await step('TSK-manager-queue', async () => {
      const r = await api('pm', 'GET', '/api/manager/approvals');
      const toReview = await api('pm', 'GET', '/api/me/tasks?view=to_review');
      report.record('TSK-manager-queue', has(r, T1.id) && has(toReview, T1.id), 'submitted task is in the manager\'s approvals and "To review" lists');
    });
    report.status('TSK-self-approve', await st('emp1', 'approve'), 403, 'assignee cannot approve own work');
    report.status('TSK-peer-approve', await st('emp2', 'approve'), 403, 'teammate cannot approve');
    await step('TSK-db-bypass', async () => {
      const { error } = await S.emp1.db.from('tasks').update({ status: 'done' }).eq('id', T1.id);
      const { data } = await admin.from('tasks').select('status').eq('id', T1.id).single();
      report.record('TSK-db-bypass', data.status === 'review', `direct update error=${error ? error.code || 'yes' : 'none'}; status=${data.status}`);
    });
    report.status('TSK-changes-nonote', await st('pm', 'request_changes'), 400, 'a note is required');
    report.status('TSK-changes', await st('pm', 'request_changes', 'Please add the forgot-password link'), 200); await statusIs('TSK-changes-db', 'changes_requested');
    report.status('TSK-resubmit', await st('emp1', 'submit'), 200);
    report.status('TSK-approve', await st('pm', 'approve'), 200); await statusIs('TSK-approve-db', 'done');
    await step('TSK-history', async () => {
      const r = await api('emp1', 'GET', `/api/tasks/${T1.id}/detail`);
      const d = payload(r);
      const hist = d?.activity || d?.history || [];
      report.record('TSK-history', r.status === 200 && hist.length >= 5, `status ${r.status}, ${hist.length} history rows`);
    });
    await step('TSK-notify', async () => {
      const e = await notifs('emp1'); const p = await notifs('pm');
      const types = new Set(e.map((n) => n.type)); const ptypes = new Set(p.map((n) => n.type));
      report.record('TSK-notify-assigned', types.has('task_assigned'), `emp1 types: ${[...types].join(', ') || 'none'}`);
      report.record('TSK-notify-feedback', [...types].some((t) => /changes|approved|review/.test(t)), 'employee told about review decisions');
      report.record('TSK-notify-submitted', [...ptypes].some((t) => /review|submitted/.test(t)), `pm types: ${[...ptypes].join(', ') || 'none'}`);
    });
  }

  report.start('Tasks: subtasks, dependencies, delete');
  if (T1?.id) {
    await step('TSK-subtask', async () => {
      const r = await api('emp1', 'POST', '/api/tasks', { name: `Login form validation ${RUN}`, project_id: IDS.website, parent_task_id: T1.id });
      const sub = payload(r);
      report.status('TSK-subtask', r, 201);
      if (sub?.id) report.status('TSK-subsubtask', await api('emp1', 'POST', '/api/tasks', { name: 'Too deep', project_id: IDS.website, parent_task_id: sub.id }), 400, 'one subtask level only');
    });
    T2 = payload(await api('pm', 'POST', '/api/tasks', { name: `API endpoints ${RUN}`, project_id: IDS.website, assigned_to: ids.emp2 }));
    T3 = payload(await api('pm', 'POST', '/api/tasks', { name: `Deploy ${RUN}`, project_id: IDS.website }));
    report.status('TSK-due-today', await api('pm', 'POST', '/api/tasks', { name: `Fix header ${RUN}`, project_id: IDS.website, assigned_to: ids.emp1, due_date: isoDate(today) }), 201);
    if (T2?.id) {
      report.status('TSK-pm-priority', await api('pm', 'PATCH', `/api/tasks/${T2.id}`, { priority: 'urgent' }), 200, 'manager changes priority');
      report.status('TSK-assign-other-deny', await api('emp2', 'PATCH', `/api/tasks/${T2.id}`, { assigned_to: ids.emp1 }), 403, 'assignee cannot hand the task to someone else');
    }
    if (empTask?.id) {
      await step('TSK-self-assign', async () => {
        const r = await api('emp2', 'PATCH', `/api/tasks/${empTask.id}`, { assigned_to: ids.emp2 });
        const { data } = await admin.from('tasks').select('assigned_to').eq('id', empTask.id).single();
        report.record('TSK-self-assign', r.status === 200 && data.assigned_to === ids.emp2, `status ${r.status}; teammate took the unassigned task`);
      });
    }
    if (T2?.id && T3?.id) {
      report.status('TSK-dep-1', await api('pm', 'POST', `/api/tasks/${T2.id}/dependencies`, { depends_on_task_id: T1.id }), [200, 201]);
      report.status('TSK-dep-2', await api('pm', 'POST', `/api/tasks/${T3.id}/dependencies`, { depends_on_task_id: T2.id }), [200, 201]);
      report.status('TSK-dep-cycle', await api('pm', 'POST', `/api/tasks/${T1.id}/dependencies`, { depends_on_task_id: T3.id }), [400, 409], '3-task cycle rejected');
      report.status('TSK-dep-self', await api('pm', 'POST', `/api/tasks/${T2.id}/dependencies`, { depends_on_task_id: T2.id }), [400, 409]);
      report.status('TSK-delete-emp', await api('emp2', 'DELETE', `/api/tasks/${T3.id}`), 403, 'only creator or manager deletes');
      report.status('TSK-delete-pm', await api('pm', 'DELETE', `/api/tasks/${T3.id}`), [200, 204]);
    }
  }

  // ------------------------------------------------------------------ comments
  report.start('Collaboration: comments, replies, mentions');
  if (T2?.id) {
    let c1;
    await step('COM-add', async () => {
      const r = await api('emp2', 'POST', `/api/tasks/${T2.id}/comments`, { content: `@Arjun can you check the auth API? ${RUN}`, mentions: [ids.emp1] });
      c1 = payload(r);
      report.status('COM-add', r, [200, 201]);
    });
    if (c1?.id) {
      let reply;
      await step('COM-reply', async () => { const r = await api('emp1', 'POST', `/api/tasks/${T2.id}/comments`, { content: 'On it', parent_id: c1.id }); reply = payload(r); report.status('COM-reply', r, [200, 201]); });
      if (reply?.id) report.status('COM-reply-depth', await api('emp2', 'POST', `/api/tasks/${T2.id}/comments`, { content: 'Too deep', parent_id: reply.id }), 400, 'one reply level');
      await step('COM-list', async () => {
        const r = await api('pm', 'GET', `/api/tasks/${T2.id}/comments`);
        const list = asList(r);
        const count = list.reduce((n, c) => n + 1 + (c.replies?.length || 0), 0);
        report.record('COM-list', r.status === 200 && count >= 2, `status ${r.status}, ${count} comments incl. replies`);
      });
      await step('COM-notify', async () => {
        const e1 = await notifs('emp1'); const e2 = await notifs('emp2');
        report.record('COM-notify-mention', e1.some((n) => /mention/.test(n.type)), 'mentioned user notified');
        report.record('COM-notify-reply', e2.some((n) => /repl|comment/.test(n.type)), 'parent author notified of reply');
      });
    }
    report.status('COM-outsider', await api('outsider', 'POST', `/api/tasks/${T2.id}/comments`, { content: 'hi' }), [403, 404]);
  }

  // ------------------------------------------------------------------ time and timesheets
  report.start('Time tracking and timesheets');
  await step('TIME-clock', async () => {
    report.status('TIME-clock-in', await api('emp2', 'POST', '/api/clock', { task_id: T2?.id }), [200, 201]);
    const g = await api('emp2', 'GET', '/api/clock');
    report.record('TIME-clock-active', g.status === 200 && !!(payload(g)?.session || payload(g)?.activeSession || payload(g)?.is_active || g.body?.session), `status ${g.status}`);
    report.status('TIME-clock-out', await api('emp2', 'POST', '/api/clock/out', { allocations: [{ projectId: IDS.website, taskId: T2?.id || null, hours: 0.5, description: 'Clocked work' }] }), [200, 201]);
  });
  const entryDate = isoDate(today);
  report.status('TIME-entry', await api('emp1', 'POST', '/api/time-entries', { projectId: IDS.website, taskId: T1?.id || null, hoursLogged: 3.5, entryDate, description: 'Login page' }), [200, 201]);
  report.status('TIME-entry-other', await api('emp1', 'POST', '/api/time-entries', { projectId: IDS.website, hoursLogged: 1, entryDate, description: 'Standup' }), [200, 201]);
  let sheet;
  await step('TS-submit', async () => { const r = await api('emp1', 'POST', '/api/me/timesheets', { weekStart: ws }); sheet = payload(r); report.status('TS-submit', r, 201, `total ${sheet?.total_hours}h`); });
  report.status('TS-locked', await api('emp1', 'POST', '/api/time-entries', { projectId: IDS.website, hoursLogged: 1, entryDate, description: 'After submit' }), [400, 403, 409], 'submitted week is locked');
  if (sheet?.id) {
    report.status('TS-self-approve', await api('emp1', 'POST', `/api/timesheets/${sheet.id}/review`, { decision: 'approve' }), 403);
    await step('TS-db-bypass', async () => {
      const { error } = await S.emp1.db.from('timesheets').update({ status: 'approved' }).eq('id', sheet.id);
      const { data } = await admin.from('timesheets').select('status').eq('id', sheet.id).single();
      report.record('TS-db-bypass', data.status === 'submitted', `direct update error=${error ? error.code || 'yes' : 'none'}; status=${data.status}`);
    });
    report.status('TS-otherpm', await api('pm2', 'POST', `/api/timesheets/${sheet.id}/review`, { decision: 'approve' }), 403, 'manager of another project cannot approve');
    await step('TS-manager-list', async () => {
      const r = await api('pm', 'GET', `/api/manager/timesheets?weekStart=${ws}`);
      const p = payload(r); const list = Array.isArray(p) ? p : p?.timesheets || p?.rows || [];
      report.record('TS-manager-list', r.status === 200 && JSON.stringify(list).includes(sheet.id), `status ${r.status}`);
    });
    report.status('TS-reject-nonote', await api('pm', 'POST', `/api/timesheets/${sheet.id}/review`, { decision: 'reject' }), 400);
    report.status('TS-reject', await api('pm', 'POST', `/api/timesheets/${sheet.id}/review`, { decision: 'reject', note: 'Split the standup hours per day' }), 200);
    report.status('TS-resubmit', await api('emp1', 'POST', '/api/me/timesheets', { weekStart: ws }), 201);
    report.status('TS-approve', await api('pm', 'POST', `/api/timesheets/${sheet.id}/review`, { decision: 'approve', note: 'Thanks' }), 200);
    await step('TS-approved', async () => {
      const r = await api('emp1', 'GET', `/api/me/timesheets?weekStart=${ws}`);
      const d = payload(r);
      const { data } = await admin.from('timesheets').select('status, reviewed_by').eq('id', sheet.id).single();
      report.record('TS-approved', d?.status === 'approved' && data.reviewed_by === ids.pm, `api status=${d?.status} reviewed_by=${data.reviewed_by === ids.pm ? 'pm' : data.reviewed_by}`);
    });
    report.status('TS-history', await api('emp1', 'GET', '/api/me/timesheets/history'), 200);
    await step('TS-notify', async () => {
      const e = await notifs('emp1'); const p = await notifs('pm');
      report.record('TS-notify-submitted', p.some((n) => n.type === 'timesheet_submitted'), 'approver told about submission');
      report.record('TS-notify-decision', e.some((n) => /timesheet_(approved|rejected)/.test(n.type)), 'employee told about decision');
    });
  }

  // ------------------------------------------------------------------ deliverables and client approval
  report.start('Deliverables: internal review, client approval');
  let D;
  await step('DLV-create', async () => { const r = await api('emp1', 'POST', `/api/projects/${IDS.website}/deliverables`, { name: `Homepage mockup ${RUN}`, description: 'Desktop + mobile', file_url: 'https://example.com/mockup.pdf' }); D = payload(r); report.status('DLV-create', r, 201, `status ${D?.status}`); });
  if (D?.id) {
    const act = (who, action, note) => api(who, 'POST', `/api/deliverables/${D.id}/action`, { action, ...(note ? { note } : {}) });
    report.status('DLV-submit', await act('emp1', 'submit'), 200);
    report.status('DLV-emp-share', await act('emp1', 'share'), 403, 'only a manager shares with the client');
    await step('DLV-db-bypass', async () => {
      const { error } = await S.emp1.db.from('deliverables').update({ status: 'approved' }).eq('id', D.id);
      const { data } = await admin.from('deliverables').select('status').eq('id', D.id).single();
      report.record('DLV-db-bypass', data.status === 'pending_review', `direct update error=${error ? error.code || 'yes' : 'none'}; status=${data.status}`);
    });
    report.status('DLV-share', await act('pm', 'share', 'First version for review'), 200);
    await step('DLV-client-sees', async () => {
      const r = await api('client', 'GET', '/api/client/portal/deliverables');
      report.record('DLV-client-sees', r.status === 200 && JSON.stringify(r.body).includes(D.id), `status ${r.status}`);
      const r2 = await api('client2', 'GET', '/api/client/portal/deliverables');
      report.record('DLV-client2-hidden', r2.status === 200 && !JSON.stringify(r2.body).includes(D.id), 'other account cannot see it');
    });
    report.status('DLV-client2-decide', await api('client2', 'POST', `/api/client/portal/deliverables/${D.id}/decision`, { decision: 'approved' }), [403, 404]);
    report.status('DLV-reject-nonote', await api('client', 'POST', `/api/client/portal/deliverables/${D.id}/decision`, { decision: 'rejected' }), 400);
    report.status('DLV-reject', await api('client', 'POST', `/api/client/portal/deliverables/${D.id}/decision`, { decision: 'rejected', feedback: 'Logo is too small on mobile' }), 200);
    report.status('DLV-resubmit', await act('emp1', 'submit'), 200);
    report.status('DLV-reshare', await act('pm', 'share'), 200);
    report.status('DLV-approve', await api('client', 'POST', `/api/client/portal/deliverables/${D.id}/decision`, { decision: 'approved', feedback: 'Looks great' }), 200);
    await step('DLV-final', async () => {
      const { data } = await admin.from('deliverables').select('status, version, approved_by').eq('id', D.id).single();
      report.record('DLV-final', data.status === 'approved' && data.version >= 2 && data.approved_by === ids.client, `status=${data.status} v${data.version} approved_by=${data.approved_by === ids.client ? 'client' : data.approved_by}`);
    });
    await step('DLV-approval-history', async () => {
      const r = await api('client', 'GET', '/api/client/portal/approvals/history');
      report.record('DLV-approval-history', r.status === 200 && has(r, D.id) && has(r, 'Looks great'), `status ${r.status}; decision and comment recorded`);
    });
    report.status('DLV-manager-approvals', await api('pm', 'GET', '/api/manager/approvals'), 200);
    await step('DLV-notify', async () => {
      const c = await notifs('client'); const p = await notifs('pm');
      report.record('DLV-notify-client', c.some((n) => n.type === 'deliverable_shared'), 'client told about new deliverable');
      report.record('DLV-notify-pm', p.some((n) => /deliverable|client_decision|client_approv/.test(n.type)), `pm types: ${[...new Set(p.map((n) => n.type))].join(', ')}`);
    });
  }

  // ------------------------------------------------------------------ documents and attachments (local Storage)
  report.start('Documents: attachments, sharing, client documents');
  await step('DOC-flow', async () => {
    const content = `Spec for the login page ${RUN}`;
    const up = await upload('emp1', `/api/projects/${IDS.website}/files`, `spec-${RUN}.txt`, content, T1?.id ? { taskId: T1.id } : {});
    const file = payload(up);
    if (!report.status('DOC-task-attach', up, 201, file?.file_name)) return;
    const list = await api('emp1', 'GET', `/api/projects/${IDS.website}/files?taskId=${T1.id}`);
    report.record('DOC-task-list', has(list, file.id), 'attachment listed on the task');
    report.status('DOC-type-block', await upload('emp1', `/api/projects/${IDS.website}/files`, 'tool.exe', 'MZ'), 415, '.exe refused');
    report.status('DOC-outsider-upload', await upload('outsider', `/api/projects/${IDS.website}/files`, 'x.txt', 'x'), [403, 404]);
    const dl = await api('emp1', 'GET', `/api/files/${file.id}`);
    const loc = dl.headers.get('location') || '';
    report.record('DOC-download', dl.status === 302 && /\/storage\/v1\/object\/sign\//.test(loc), `status ${dl.status}, signed URL=${!!loc}`);
    if (loc) {
      const body = await fetch(loc.startsWith('http') ? loc : env.url + loc).then((r) => r.text()).catch((e) => `ERR ${e.message}`);
      report.record('DOC-download-content', body === content, 'downloaded bytes match the upload');
    }
    report.status('DOC-outsider-download', await api('outsider', 'GET', `/api/files/${file.id}`), [403, 404]);
    report.status('DOC-emp-share', await api('emp1', 'PATCH', `/api/files/${file.id}`, { client_visible: true }), 403, 'only a manager shares with the client');
    report.status('DOC-rename', await api('emp1', 'PATCH', `/api/files/${file.id}`, { file_name: `login-spec-${RUN}.txt` }), 200);
    report.record('DOC-client-hidden', !has(await api('client', 'GET', `/api/client/portal/projects/${IDS.website}/files`), file.id), 'not shared yet: client cannot see it');
    report.status('DOC-client-dl-hidden', await api('client', 'GET', `/api/client/portal/files/${file.id}`), 404);
    report.status('DOC-share', await api('pm', 'PATCH', `/api/files/${file.id}`, { client_visible: true }), 200);
    report.record('DOC-client-sees', has(await api('client', 'GET', `/api/client/portal/projects/${IDS.website}/files`), file.id), 'client sees the shared document');
    report.status('DOC-client-download', await api('client', 'GET', `/api/client/portal/files/${file.id}`), 302);
    report.status('DOC-client2-download', await api('client2', 'GET', `/api/client/portal/files/${file.id}`), 404, 'other account cannot download');
    const cu = await upload('client', `/api/client/portal/projects/${IDS.website}/files`, `requirements-${RUN}.txt`, 'Brand colours: moss, clay');
    report.status('DOC-client-upload', cu, 201);
    report.record('DOC-team-sees-upload', has(await api('pm', 'GET', `/api/projects/${IDS.website}/files`), `requirements-${RUN}.txt`), 'team sees the client upload');
    report.record('DOC-notify-upload', (await notifs('pm')).some((n) => n.type === 'client_upload'), 'manager told about the client upload');

    // A deliverable with an attached (unshared) file becomes downloadable for the client once shared
    const att = payload(await upload('emp1', `/api/projects/${IDS.website}/files`, `final-logo-${RUN}.txt`, 'logo'));
    const dv = payload(await api('emp1', 'POST', `/api/projects/${IDS.website}/deliverables`, { name: `Logo files ${RUN}`, file_id: att.id }));
    await api('emp1', 'POST', `/api/deliverables/${dv.id}/action`, { action: 'submit' });
    report.status('DOC-dlv-before-share', await api('client', 'GET', `/api/client/portal/files/${att.id}`), 404);
    await api('pm', 'POST', `/api/deliverables/${dv.id}/action`, { action: 'share' });
    report.status('DOC-dlv-download', await api('client', 'GET', `/api/client/portal/files/${att.id}`), 302, 'client downloads the deliverable file');
    report.status('DOC-dlv-other-project-file', await api('emp1', 'POST', `/api/projects/${IDS.internal}/deliverables`, { name: 'Wrong file', file_id: att.id }), 400, 'file must be in the same project');
  });

  // ------------------------------------------------------------------ workflow engine (D-1, D-2, D-3)
  report.start('Workflows: build, start, progress, auto-complete');
  await step('WF-flow', async () => {
    const { data: empRole } = await admin.from('roles').select('id').eq('name', 'Employee').single();
    const tpl = await api('superadmin', 'POST', '/api/admin/workflows/templates', { name: `E2E delivery ${RUN}`, description: 'Start → build → end' });
    const tplId = (tpl.body?.template || payload(tpl))?.id;
    if (!report.status('WF-template', tpl, [200, 201]) || !tplId) return;
    const node = async (node_type, label, x, extra = {}) => {
      const r = await api('superadmin', 'POST', `/api/admin/workflows/templates/${tplId}/nodes`, { workflow_template_id: tplId, node_type, label, position_x: x, position_y: 100, ...extra });
      return (r.body?.node || payload(r))?.id ? (r.body?.node || payload(r)) : (report.status(`WF-node-${node_type}`, r, [200, 201]), null);
    };
    const nStart = await node('start', 'Start', 0);
    const nBuild = await node('role', 'Build', 200, { entity_id: empRole.id });
    const nEnd = await node('end', 'Done', 400);
    if (!nStart || !nBuild || !nEnd) return;
    for (const [a, b] of [[nStart, nBuild], [nBuild, nEnd]]) {
      const c = await api('superadmin', 'POST', `/api/admin/workflows/templates/${tplId}/connections`, { workflow_template_id: tplId, from_node_id: a.id, to_node_id: b.id });
      if (!report.status(`WF-connect ${a.label}→${b.label}`, c, [200, 201])) return;
    }
    // Fresh project for this run: pm manages it, emp1 works on it
    const { data: proj, error: pErr } = await admin.from('projects').insert({ name: `Workflow project ${RUN}`, account_id: IDS.acme, status: 'in_progress', created_by: ids.pm, assigned_user_id: ids.pm }).select('id').single();
    if (pErr) throw pErr;
    await admin.from('project_assignments').insert([{ project_id: proj.id, user_id: ids.pm, role_in_project: 'Project Manager' }, { project_id: proj.id, user_id: ids.emp1, role_in_project: 'Developer' }]);

    report.status('WF-start-inactive', await api('pm', 'POST', '/api/workflows/start', { projectId: proj.id, workflowTemplateId: tplId }), 409, 'inactive template refused');
    if (!report.status('WF-activate', await api('superadmin', 'PATCH', `/api/admin/workflows/templates/${tplId}`, { is_active: true }), 200)) return;
    const st = await api('pm', 'POST', '/api/workflows/start', { projectId: proj.id, workflowTemplateId: tplId });
    if (!report.status('WF-start', st, [200, 201])) return;
    const { data: inst } = await admin.from('workflow_instances').select('id, status, current_node_id').eq('project_id', proj.id).order('started_at', { ascending: false }).limit(1).single();
    const { data: link } = await admin.from('projects').select('workflow_instance_id').eq('id', proj.id).single();
    report.record('WF-D3-link', link.workflow_instance_id === inst.id, 'projects.workflow_instance_id written on start (D-3)');
    const { data: hist } = await admin.from('workflow_history').select('transitioned_by, transition_type').eq('workflow_instance_id', inst.id);
    report.record('WF-D2-history', (hist || []).length > 0 && hist.every((h) => h.transitioned_by && h.transition_type), `${(hist || []).length} history rows, all with transitioned_by + transition_type (D-2)`);

    const steps = await api('emp1', 'GET', `/api/workflows/instances/${inst.id}/active-steps`);
    const list = steps.body?.activeSteps || steps.body?.steps || asList(steps);
    const active = list.find((s) => s.node_id === nBuild.id) || list[0];
    report.record('WF-active-step', steps.status === 200 && !!active, `status ${steps.status}, ${list.length} active step(s), current node ${inst.current_node_id === nBuild.id ? 'Build' : inst.current_node_id}`);
    const pr = await api('emp1', 'POST', '/api/workflows/progress', { workflowInstanceId: inst.id, activeStepId: active?.id || null, feedback: 'Build finished' });
    if (!report.status('WF-progress', pr, [200, 201])) return;
    const { data: done } = await admin.from('workflow_instances').select('status, completed_at').eq('id', inst.id).single();
    const { data: p2 } = await admin.from('projects').select('status, completed_at').eq('id', proj.id).single();
    report.record('WF-complete', done.status === 'completed', `instance status=${done.status}`);
    report.record('WF-D1-project-complete', p2.status === 'complete' && !!p2.completed_at, `project status=${p2.status}, completed_at=${p2.completed_at ? 'set' : 'null'} (D-1, employee finished the last step)`);
    const { data: upd } = await admin.from('project_updates').select('id, created_by').eq('project_id', proj.id);
    report.record('WF-history-count', ((await admin.from('workflow_history').select('id').eq('workflow_instance_id', inst.id)).data || []).length >= 2, 'start and hand-off recorded');
    report.record('WF-notes', (upd || []).every((u) => u.created_by), `${(upd || []).length} workflow notes, all with created_by (D-3)`);
  });

  // ------------------------------------------------------------------ updates, discussion, issues, feedback
  report.start('Client portal: updates, discussion, issues, feedback');
  let shared, internalUpd;
  await step('UPD-shared', async () => { const r = await api('pm', 'POST', `/api/projects/${IDS.website}/updates`, { content: `Sprint 1 complete ${RUN}`, client_visible: true }); shared = payload(r); report.status('UPD-shared', r, [200, 201]); });
  await step('UPD-emp-share', async () => {
    const r = await api('emp1', 'POST', `/api/projects/${IDS.website}/updates`, { content: `Internal: auth is flaky ${RUN}`, client_visible: true });
    internalUpd = payload(r);
    const { data } = internalUpd?.id ? await admin.from('project_updates').select('client_visible').eq('id', internalUpd.id).maybeSingle() : { data: null };
    report.record('UPD-emp-share', (r.status >= 400 && r.status < 500) || data?.client_visible === false, `status ${r.status}, client_visible=${data?.client_visible}`);
  });
  await step('UPD-client-view', async () => {
    const r = await api('client', 'GET', `/api/client/portal/projects/${IDS.website}/discussion`);
    const text = JSON.stringify(r.body || '');
    report.record('UPD-client-view', r.status === 200 && text.includes(`Sprint 1 complete ${RUN}`) && !text.includes(`auth is flaky ${RUN}`), `status ${r.status}; shared visible=${text.includes('Sprint 1 complete ' + RUN)}; internal visible=${text.includes('auth is flaky ' + RUN)}`);
  });
  if (shared?.id) {
    report.status('UPD-client-comment', await api('client', 'POST', `/api/client/portal/updates/${shared.id}/comments`, { content: 'Great progress!' }), [200, 201]);
    await step('UPD-team-sees-comment', async () => {
      const r = await api('pm', 'GET', `/api/projects/${IDS.website}/updates/${shared.id}/comments`);
      report.record('UPD-team-sees-comment', r.status === 200 && JSON.stringify(r.body).includes('Great progress!'), `status ${r.status}`);
    });
    report.status('UPD-emp-unshare', await api('emp1', 'PATCH', `/api/projects/${IDS.website}/updates/${shared.id}/share`, { client_visible: false }), 403);
    await step('UPD-client-reply', async () => {
      const team = payload(await api('pm', 'POST', `/api/projects/${IDS.website}/updates/${shared.id}/comments`, { content: `Thanks! Demo on Friday ${RUN}` }));
      const r = team?.id ? await api('client', 'POST', `/api/client/portal/updates/${shared.id}/comments`, { content: 'Friday works', parent_id: team.id }) : { status: 0 };
      report.status('UPD-client-reply', r, [200, 201], 'client replies to the team');
    });
    report.record('UPD-notify-client', (await notifs('client')).some((n) => n.type === 'project_update'), 'client told about the shared update');
    report.record('UPD-notify-team', (await notifs('emp1')).some((n) => n.type === 'project_update'), 'team told about the new update');
  }
  report.status('UPD-client-post', await api('client', 'POST', `/api/client/portal/projects/${IDS.website}/discussion`, { content: `Question from the client ${RUN}` }), [200, 201]);

  let issue;
  await step('ISS-client-report', async () => { const r = await api('client', 'POST', `/api/client/portal/projects/${IDS.website}/issues`, { title: `Contact form broken ${RUN}`, content: 'Submitting shows a blank page', severity: 'high' }); issue = payload(r); report.status('ISS-client-report', r, [200, 201]); });
  await step('ISS-team-sees', async () => {
    const r = await api('pm', 'GET', `/api/projects/${IDS.website}/issues`);
    report.record('ISS-team-sees', r.status === 200 && JSON.stringify(r.body).includes(`Contact form broken ${RUN}`), `status ${r.status}`);
  });
  if (issue?.id) {
    report.status('ISS-resolve', await api('pm', 'PUT', `/api/projects/${IDS.website}/issues/${issue.id}`, { status: 'resolved', resolution_note: 'Fixed the form handler' }), 200);
    await step('ISS-client-status', async () => {
      const r = await api('client', 'GET', `/api/client/portal/projects/${IDS.website}/issues`);
      const row = asList(r).find((i) => i.id === issue.id) || (r.body?.issues || []).find((i) => i.id === issue.id);
      report.record('ISS-client-status', r.status === 200 && row?.status === 'resolved', `status ${r.status}, issue status=${row?.status}`);
      report.record('ISS-client-resolution', has(r, 'Fixed the form handler'), 'client sees the resolution note');
    });
  }
  report.status('ISS-risk', await api('pm', 'POST', `/api/projects/${IDS.website}/issues`, { content: 'Payment gateway approval may slip', kind: 'risk', severity: 'high', title: `Gateway risk ${RUN}` }), [200, 201]);
  report.status('ISS-client2-blocked', await api('client2', 'GET', `/api/client/portal/projects/${IDS.website}/issues`), [403, 404]);

  report.status('FB-request', await api('pm', 'POST', `/api/projects/${IDS.website}/actions`, { action: 'request_feedback', message: 'How are we doing?' }), 200);
  await step('FB-client-summary', async () => {
    const r = await api('client', 'GET', '/api/client/portal/summary');
    const fr = payload(r)?.feedbackRequests || [];
    report.record('FB-client-summary', r.status === 200 && JSON.stringify(fr).includes(IDS.website), `status ${r.status}; feedback requests=${fr.length}`);
    report.record('FB-notify-client', (await notifs('client')).some((n) => n.type === 'feedback_request'), 'client told about the feedback request');
  });
  report.status('FB-submit', await api('client', 'POST', `/api/client/portal/projects/${IDS.website}/feedback`, { project_id: IDS.website, satisfaction_score: 9, what_went_well: 'Fast updates', what_needs_improvement: 'More demos' }), 201);
  await step('FB-history', async () => { const r = await api('client', 'GET', '/api/client/portal/feedback'); report.record('FB-history', r.status === 200 && JSON.stringify(r.body).includes('Fast updates'), `status ${r.status}`); });

  // ------------------------------------------------------------------ client portal views and isolation
  report.start('Client portal: views and isolation');
  await step('CP-projects', async () => {
    const r = await api('client', 'GET', '/api/client/portal/projects');
    const t = JSON.stringify(r.body || '');
    report.record('CP-projects', r.status === 200 && t.includes(IDS.website) && !t.includes(IDS.internal) && !t.includes(IDS.portal), `status ${r.status}; website=${t.includes(IDS.website)} internal=${t.includes(IDS.internal)} other-account=${t.includes(IDS.portal)}`);
  });
  report.status('CP-project', await api('client', 'GET', `/api/client/portal/projects/${IDS.website}`), 200);
  await step('CP-team-no-email', async () => {
    const r = await api('client', 'GET', `/api/client/portal/projects/${IDS.website}`);
    report.record('CP-team-no-email', r.status === 200 && !JSON.stringify(r.body).includes('e2e.emp1@example.com'), 'staff emails not exposed to clients');
  });
  report.status('CP-internal-project', await api('client', 'GET', `/api/client/portal/projects/${IDS.internal}`), [403, 404], 'unshared project hidden');
  report.status('CP-other-account', await api('client', 'GET', `/api/client/portal/projects/${IDS.portal}`), [403, 404], 'other account hidden');
  await step('CP-timeline', async () => {
    const r = await api('client', 'GET', `/api/client/portal/projects/${IDS.website}/timeline`);
    const d = payload(r);
    report.record('CP-timeline', r.status === 200 && has(r, `Beta launch ${RUN}`), `status ${r.status}`);
    report.record('CP-timeline-dates', !!d?.project?.start_date && !!d?.project?.end_date && typeof d?.progress_percent === 'number', `start=${d?.project?.start_date} end=${d?.project?.end_date} progress=${d?.progress_percent}%`);
    report.record('CP-timeline-upcoming', (d?.upcomingDeliveries || []).some((m) => m.name === `Beta launch ${RUN}`), 'milestone listed as an upcoming delivery');
    report.record('CP-timeline-stages', Array.isArray(d?.stages), `${(d?.stages || []).length} completed stages listed`);
  });
  await step('CP-summary', async () => {
    const d = payload(await api('client', 'GET', '/api/client/portal/summary'));
    const p = (d?.projects || []).find((x) => x.id === IDS.website);
    report.record('CP-summary', d?.totals?.total >= 1 && d?.totals?.active >= 1 && typeof p?.progress_percent === 'number' && (d?.upcomingDeliveries || []).length >= 1,
      `total=${d?.totals?.total} active=${d?.totals?.active} completed=${d?.totals?.completed} progress=${p?.progress_percent}% upcoming=${(d?.upcomingDeliveries || []).length} pendingApprovals=${d?.pendingApprovals}`);
  });
  await step('CP-team', async () => {
    const r = await api('client', 'GET', `/api/client/portal/projects/${IDS.website}`);
    const team = r.body?.team || [];
    const leaks = JSON.stringify(team).match(/@example\.com|e2e\.[a-z0-9]+@/g) || [];
    const realIds = Object.values(ids).filter((id) => JSON.stringify(team).includes(id));
    report.record('CP-team', team.length >= 2 && team.every((m) => (m.user?.name || m.name) && m.role_in_project) && !leaks.length && !realIds.length,
      `${team.length} members with name and role; emails exposed=${leaks.length}, real user IDs exposed=${realIds.length}`);
    report.record('CP-progress', typeof r.body?.project?.progress_percent === 'number' && !!r.body?.project?.status, `status=${r.body?.project?.status} completion ${r.body?.project?.progress_percent}%`);
  });
  report.status('CP-files', await api('client', 'GET', `/api/client/portal/projects/${IDS.website}/files`), 200);

  // ------------------------------------------------------------------ employee and manager views
  report.start('Employee and manager screens (APIs)');
  for (const [id, who, path] of [
    ['EMP-summary', 'emp1', '/api/me/summary'], ['EMP-tasks', 'emp1', '/api/me/tasks'],
    ['EMP-calendar', 'emp1', `/api/me/calendar?from=${isoDate(addDays(-7))}&to=${isoDate(addDays(30))}`],
    ['EMP-performance', 'emp1', '/api/me/performance'], ['EMP-notifications', 'emp1', '/api/notifications'],
    ['MGR-team', 'pm', '/api/manager/team'], ['MGR-approvals', 'pm', '/api/manager/approvals'],
    ['MGR-timesheets', 'pm', '/api/manager/timesheets'], ['MGR-overview-exec', 'executive', '/api/manager/overview'],
  ]) report.status(id, await api(who, 'GET', path), 200);
  await step('EMP-tasks-content', async () => {
    const created = await api('emp1', 'GET', '/api/me/tasks?view=created');
    const assigned = await api('emp1', 'GET', '/api/me/tasks');
    report.record('EMP-tasks-content', JSON.stringify(created.body).includes(`Write tests ${RUN}`) && JSON.stringify(assigned.body).includes(`Build login page ${RUN}`),
      '"Created by me" has my own task; "Assigned to me" has the manager\'s task');
  });
  await step('EMP-calendar-content', async () => {
    const d = payload(await api('emp1', 'GET', `/api/me/calendar?from=${isoDate(addDays(-7))}&to=${isoDate(addDays(31))}`));
    report.record('EMP-calendar-milestones', JSON.stringify(d?.milestones || []).includes(`Beta launch ${RUN}`), 'milestone in the calendar');
    report.record('EMP-calendar-tasks', JSON.stringify(d?.tasks || []).includes(`Fix header ${RUN}`), 'task deadline in the calendar');
    report.record('EMP-calendar-projects', JSON.stringify(d?.projectDeadlines || []).includes(IDS.website), 'project deadline in the calendar');
    report.record('EMP-calendar-availability', Array.isArray(d?.availability), `${(d?.availability || []).length} availability rows`);
  });
  await step('EMP-summary-content', async () => {
    const d = payload(await api('emp1', 'GET', '/api/me/summary'));
    report.record('EMP-summary-due-today', (d?.dueToday || []).some((t) => t.name === `Fix header ${RUN}`), `${(d?.dueToday || []).length} due today`);
    report.record('EMP-summary-hours', d?.hoursThisWeek >= 4.5, `hours this week=${d?.hoursThisWeek}`);
    report.record('EMP-summary-counts', d?.assigned >= 2 && d?.pending >= 1 && d?.completedThisWeek >= 1 && Array.isArray(d?.overdue), `assigned=${d?.assigned} pending=${d?.pending} completedThisWeek=${d?.completedThisWeek} overdue=${(d?.overdue || []).length} activeProjects=${JSON.stringify(d?.activeProjects)?.slice(0, 40)}`);
    report.record('EMP-summary-notifications', d?.unreadNotifications >= 1, `unread notifications=${d?.unreadNotifications}`);
  });
  await step('EMP-performance-content', async () => {
    const d = payload(await api('emp1', 'GET', '/api/me/performance'));
    report.record('EMP-performance-content', d?.tasksCompleted >= 1 && d?.hoursLogged >= 4.5 && (d?.byProject || []).some((p) => p.project_id === IDS.website) && Array.isArray(d?.weekly),
      `completed=${d?.tasksCompleted} pending=${d?.tasksPending} hours=${d?.hoursLogged} onTime=${d?.onTimeRate}% projects=${(d?.byProject || []).length} weeks=${(d?.weekly || []).length}`);
  });
  await step('EMP-views', async () => {
    for (const view of ['assigned', 'created', 'in_progress', 'review', 'changes_requested', 'done', 'overdue', 'to_review']) {
      report.status(`EMP-view-${view}`, await api('emp1', 'GET', `/api/me/tasks?view=${view}`), 200);
    }
    report.record('EMP-view-done-content', has(await api('emp1', 'GET', '/api/me/tasks?view=done'), `Build login page ${RUN}`), 'approved task in "Completed"');
    const f = await api('emp1', 'GET', `/api/me/tasks?priority=high&q=login&projectId=${IDS.website}`);
    report.record('EMP-filter', has(f, `Build login page ${RUN}`) && !has(f, `Fix header ${RUN}`), 'filter by project, priority and search');
    const due = await api('emp1', 'GET', '/api/me/tasks?due=today');
    report.record('EMP-filter-due', has(due, `Fix header ${RUN}`) && !has(due, `Build login page ${RUN}`), 'filter by deadline (today)');
  });
  const reportExpect = {
    'project-performance': 'Website Redesign (E2E)', 'project-completion': `Workflow project ${RUN}`,
    'employee-performance': PERSONAS.emp1.name, time: PERSONAS.emp1.name, budget: '482000', risks: `Gateway risk ${RUN}`, workload: PERSONAS.emp1.name,
  };
  for (const [type, needle] of Object.entries(reportExpect)) {
    const r = await api('pm', 'GET', `/api/manager/reports/${type}`);
    report.record(`RPT-${type}`, r.status === 200 && has(r, needle), `status ${r.status}; contains "${needle}"=${has(r, needle)}`);
  }
  report.status('RPT-emp-budget', await api('emp1', 'GET', '/api/manager/reports/budget'), [403, 200]);
  await step('RPT-emp-budget-content', async () => {
    const r = await api('emp1', 'GET', '/api/manager/reports/budget');
    report.record('RPT-emp-budget-content', r.status === 403 || !JSON.stringify(r.body).includes('482000'), `status ${r.status}; employee sees budget figure=${JSON.stringify(r.body).includes('482000')}`);
  });

  report.start('Manager dashboard figures (after the flows above)');
  await step('DASH-overview', async () => {
    const d = payload(await api('pm', 'GET', '/api/manager/overview'));
    const projIds = (d?.projects || []).map((p) => p.id);
    report.record('DASH-scope', projIds.includes(IDS.website) && projIds.includes(IDS.internal) && !projIds.includes(IDS.portal), `pm sees ${projIds.length} projects; other manager's project listed=${projIds.includes(IDS.portal)}`);
    report.record('DASH-counts', d?.counts?.total >= 2 && d?.counts?.active >= 1, `total=${d?.counts?.total} active=${d?.counts?.active} completed=${d?.counts?.completed} delayed=${d?.counts?.delayed}`);
    const emp1Load = (d?.workload || []).find((w) => (w.user?.id || w.id || w.user_id) === ids.emp1);
    report.record('DASH-employees', d?.employees >= 2 && !!emp1Load && typeof emp1Load.open === 'number', `employees=${d?.employees}, workload rows=${(d?.workload || []).length}, emp1 open=${emp1Load?.open} overdue=${emp1Load?.overdue}`);
    report.record('DASH-tasks', d?.tasks?.completed >= 1 && d?.tasks?.pending >= 1, `pending=${d?.tasks?.pending} completed=${d?.tasks?.completed} awaitingReview=${d?.tasks?.awaitingReview}`);
    report.record('DASH-feedback', d?.clientFeedback?.count >= 1 && d?.clientFeedback?.average >= 1, `feedback count=${d?.clientFeedback?.count} average=${d?.clientFeedback?.average}`);
    report.record('DASH-risks', d?.risks?.open >= 1, `open risks=${d?.risks?.open}`);
    report.record('DASH-activity', (d?.recentActivity || []).length > 0, `${(d?.recentActivity || []).length} recent activity rows`);
    report.record('DASH-approvals', d?.pendingApprovals && 'tasks' in d.pendingApprovals && 'timesheets' in d.pendingApprovals && 'deliverables' in d.pendingApprovals, JSON.stringify(d?.pendingApprovals));
    const d2 = payload(await api('pm2', 'GET', '/api/manager/overview'));
    report.record('DASH-delayed', d2?.counts?.delayed >= 1 && (d2?.projects || [])[0]?.id === IDS.portal, `pm2 delayed=${d2?.counts?.delayed} (Globex Portal ended yesterday), listed first=${(d2?.projects || [])[0]?.id === IDS.portal}`);
    const team = await api('pm', 'GET', '/api/manager/team');
    report.record('DASH-team', team.status === 200 && JSON.stringify(team.body).includes(ids.emp1) && !JSON.stringify(team.body).includes(ids.outsider), 'team list has the project staff and not the outsider');
  });

  // ------------------------------------------------------------------ admin
  report.start('Admin: settings, invitations, deactivation');
  report.status('ADM-client-feedback-admin', await api('superadmin', 'GET', `/api/accounts/${IDS.acme}/client-feedback`), 200, 'superadmin opens any account\'s client feedback');
  report.status('ADM-client-invites-admin', await api('superadmin', 'GET', `/api/accounts/${IDS.globex}/client-invites`), 200, 'superadmin lists any account\'s client invitations');
  report.status('ADM-client-feedback-otherpm', await api('pm2', 'GET', `/api/accounts/${IDS.acme}/client-feedback`), [403], 'manager of another account cannot');
  report.status('ADM-settings-get', await api('superadmin', 'GET', '/api/settings'), 200);
  report.status('ADM-settings-set', await api('superadmin', 'PATCH', '/api/settings', { currency: 'INR' }), 200);
  report.status('ADM-settings-emp', await api('emp1', 'PATCH', '/api/settings', { currency: 'USD' }), 403);
  await step('ADM-invite', async () => {
    const { data: role } = await admin.from('roles').select('id').eq('name', 'Employee').single();
    const r = await api('superadmin', 'POST', '/api/invitations', { email: `new.hire.${RUN}@example.com`, name: 'New Hire', roleId: role.id, send_email: false, phone: '+91 98765 43210' });
    report.record('ADM-invite', r.status === 201 && /wa\.me\/919876543210/.test(r.body?.whatsappUrl || ''), `status ${r.status}; whatsapp=${(r.body?.whatsappUrl || '').slice(0, 30)}`);
    const token = r.body?.invitation?.token || (r.body?.acceptUrl || '').split('/').pop();
    if (token) {
      const a = await call(env, null, 'POST', `/api/invitations/accept/${token}`, { password: 'Welcome123!' });
      report.status('ADM-invite-accept', a, [200, 201]);
      const s = await signIn(env, `new.hire.${RUN}@example.com`, 'Welcome123!').catch((e) => e);
      report.record('ADM-invite-signin', !(s instanceof Error) && !!s.userId, s instanceof Error ? s.message : 'new user can sign in');
    }
  });
  await step('ADM-client-invite', async () => {
    const r = await api('pm', 'POST', `/api/accounts/${IDS.acme}/invite-client`, { account_id: IDS.acme, email: `client.${RUN}@example.com`, expires_in_days: 7 });
    report.record('ADM-client-invite', r.status === 201 && /^https:\/\/wa\.me\//.test(r.body?.whatsappUrl || ''), `status ${r.status}; whatsapp link=${!!r.body?.whatsappUrl}`);
    const token = r.body?.invitation?.token || (r.body?.acceptUrl || '').split('/').pop();
    if (!token) return;
    const a = await call(env, null, 'POST', `/api/client/accept-invite/${token}`, { name: 'New Client', password: 'Welcome123!', company_position: 'Marketing lead' });
    report.status('ADM-client-accept', a, [200, 201]);
    const s = await signIn(env, `client.${RUN}@example.com`, 'Welcome123!').catch((e) => e);
    if (s instanceof Error) { report.record('ADM-client-signin', false, s.message); return; }
    const sum = await call(env, s, 'GET', '/api/client/portal/projects');
    report.record('ADM-client-signin', sum.status === 200 && JSON.stringify(sum.body).includes(IDS.website), `new client signs in and sees the Acme project (status ${sum.status})`);
  });
  report.status('ADM-deactivate', await api('superadmin', 'POST', `/api/users/${ids.outsider}/status`, { active: false }), 200);
  report.status('ADM-deactivated-blocked', await api('outsider', 'GET', '/api/me/summary'), [401, 403], 'existing session rejected');
  await step('ADM-deactivated-signin', async () => {
    const s = await signIn(env, PERSONAS.outsider.email).catch((e) => e);
    report.record('ADM-deactivated-signin', s instanceof Error, s instanceof Error ? 'sign-in refused' : 'sign-in still works');
  });
  report.status('ADM-reactivate', await api('superadmin', 'POST', `/api/users/${ids.outsider}/status`, { active: true }), 200);
  report.status('ADM-self-deactivate', await api('emp1', 'POST', `/api/users/${ids.emp1}/status`, { active: false }), [403, 400]);

  // ------------------------------------------------------------------ cron
  report.start('Scheduled jobs');
  report.status('CRON-noauth', await call(env, null, 'POST', '/api/cron/deadline-reminders', {}), 401);
  await step('CRON-run', async () => {
    const r = await fetch(`${env.appUrl}/api/cron/deadline-reminders`, { method: 'POST', headers: { authorization: `Bearer ${env.cronSecret}` } });
    report.record('CRON-run', r.status === 200, `status ${r.status}`);
    const n = (await notifs('emp1')).filter((x) => x.type === 'deadline');
    report.record('CRON-reminder', n.some((x) => (x.message || '').includes(`Fix header ${RUN}`)), `${n.length} deadline reminders for the employee`);
    const again = await fetch(`${env.appUrl}/api/cron/deadline-reminders`, { method: 'POST', headers: { authorization: `Bearer ${env.cronSecret}` } });
    const n2 = (await notifs('emp1')).filter((x) => x.type === 'deadline' && (x.message || '').includes(`Fix header ${RUN}`));
    report.record('CRON-dedupe', again.status === 200 && n2.length === 1, `running twice sends one reminder (got ${n2.length})`);
  });
}

main()
  .catch((e) => report.error('UNCAUGHT', e))
  .finally(() => { const failed = report.summary(); process.exit(failed ? 1 : 0); });
