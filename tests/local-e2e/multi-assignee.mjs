// One task, several assignees: each person reports their own part; the manager sees the whole picture.
// Real users, real Next.js server (port 3100), real local database. Usage: node tests/local-e2e/multi-assignee.mjs
// (after the seed). Covers: assigning several people, the role-hierarchy rule (API and database), individual
// progress / report / blocker / completion, overall completion and review, time per person, notifications, My Tasks,
// the project board data, manager views, existing single-assignee tasks, and bypass attempts.
import pg from 'pg';
import { loadEnv, adminClient, signIn, call, payload, Report, isoDate } from './lib.mjs';
import { seed, IDS, PERSONAS } from './seed.mjs';

const report = new Report('Shared tasks (several assignees)');
const RUN = Date.now().toString(36);
const env = loadEnv();
const admin = adminClient(env);
const S = {};
const step = async (id, fn) => { try { await fn(); } catch (e) { report.error(id, e); } };
const api = (who, method, path, body) => call(env, who ? S[who] : null, method, path, body);
const notifs = async (who) => {
  const r = payload(await api(who, 'GET', '/api/notifications?limit=100'));
  return Array.isArray(r) ? r : r?.notifications || [];
};
const countType = async (who, type, needle) => (await notifs(who)).filter((n) => n.type === type && (n.message || '').includes(needle)).length;

// The database itself, as the app's request role with a given signed-in user (to try bypassing the API)
async function asUser(userId, sql, params = []) {
  const url = process.env.DATABASE_URL || env.databaseUrl || readEnvVar('DATABASE_URL');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('role', $1, true), set_config('request.jwt.claims', $2, true), set_config('request.jwt.claim.sub', $3, true), set_config('request.jwt.claim.role', 'authenticated', true)",
      [process.env.DB_USER_ROLE || readEnvVar('DB_USER_ROLE') || 'authenticated', JSON.stringify({ sub: userId, role: 'authenticated' }), userId]);
    if (readEnvVar('DB_SCHEMA')) await client.query(`set local search_path to ${readEnvVar('DB_SCHEMA')}, public`);
    await client.query(sql, params);
    return { ok: true };
  } catch (e) {
    return { ok: false, code: e.code, message: e.message };
  } finally {
    await client.query('rollback').catch(() => {});
    await client.end();
  }
}
import fs from 'node:fs';
import path from 'node:path';
function readEnvVar(name) {
  const file = path.join(process.cwd(), process.env.LOCAL_ENV_FILE || '.env.development.local');
  if (!fs.existsSync(file)) return '';
  const m = fs.readFileSync(file, 'utf8').match(new RegExp(`^\\s*${name}\\s*=\\s*(.*)\\s*$`, 'm'));
  return m ? m[1].replace(/^["']|["']$/g, '') : '';
}

async function main() {
  report.start('Setup');
  const { ids } = await seed({ quiet: true });
  for (const key of ['superadmin', 'pm', 'pm2', 'emp1', 'emp2', 'outsider']) S[key] = await signIn(env, PERSONAS[key].email);
  // pm2 (same level as pm) joins the website team, so only the hierarchy can refuse them
  const { data: pm2Row } = await admin.from('project_assignments').select('id').eq('project_id', IDS.website).eq('user_id', ids.pm2).maybeSingle();
  if (!pm2Row) await admin.from('project_assignments').insert({ project_id: IDS.website, user_id: ids.pm2, role_in_project: 'Reviewer', assigned_by: ids.pm });
  else await admin.from('project_assignments').update({ removed_at: null }).eq('id', pm2Row.id);
  report.record('SETUP', true, 'seeded; pm2 on the website team');

  // ------------------------------------------------------------------ assigning
  report.start('Assigning one task to several people');
  let T = null;
  await step('MA-create', async () => {
    const r = await api('pm', 'POST', '/api/tasks', { name: `Website testing ${RUN}`, project_id: IDS.website, assignee_ids: [ids.emp1, ids.emp2], priority: 'high', due_date: isoDate(new Date(Date.now() + 5 * 864e5)) });
    T = payload(r)?.task || r.body?.task;
    const people = (T?.assignees || []).map((a) => a.user_id);
    report.record('MA-create', r.status === 201 && people.length === 2 && people.includes(ids.emp1) && people.includes(ids.emp2), `status ${r.status}; ${people.length} assignees on one task`);
    report.record('MA-one-task', !!T?.id && T.assigned_to === ids.emp1, 'one task id; the first person is the primary assignee');
  });
  if (!T?.id) return;
  await step('MA-notified', async () => {
    report.record('MA-notified', (await countType('emp2', 'task_assigned', `Website testing ${RUN}`)) === 1 && (await countType('emp1', 'task_assigned', `Website testing ${RUN}`)) === 1, 'each assignee notified once');
  });

  report.start('Role hierarchy');
  report.status('MA-same-level', await api('pm', 'PATCH', `/api/tasks/${T.id}`, { assignee_ids: [ids.emp1, ids.emp2, ids.pm2] }), 403, 'a manager cannot assign someone at the same level');
  report.status('MA-above', await api('pm', 'PATCH', `/api/tasks/${T.id}`, { assignee_ids: [ids.emp1, ids.emp2, ids.superadmin] }), [403, 400], 'or above');
  report.status('MA-self', await api('pm', 'PATCH', `/api/tasks/${T.id}`, { assignee_ids: [ids.emp1, ids.emp2, ids.pm] }), 200, 'a manager can add themselves');
  report.status('MA-self-remove', await api('pm', 'PATCH', `/api/tasks/${T.id}`, { assignee_ids: [ids.emp1, ids.emp2] }), 200, 'and remove people');
  report.status('MA-superadmin', await api('superadmin', 'PATCH', `/api/tasks/${T.id}`, { assignee_ids: [ids.emp1, ids.emp2, ids.pm2] }), 200, 'superadmins are unrestricted');
  report.status('MA-superadmin-undo', await api('superadmin', 'PATCH', `/api/tasks/${T.id}`, { assignee_ids: [ids.emp1, ids.emp2] }), 200);
  await step('MA-people-list', async () => {
    const list = payload(await api('pm', 'GET', `/api/projects/${IDS.website}/assignable-people`)) || [];
    const listed = list.map((p) => p.id);
    report.record('MA-people-list', listed.includes(ids.pm) && listed.includes(ids.emp1) && listed.includes(ids.emp2) && !listed.includes(ids.pm2), `manager's list: themselves and the people below (${listed.length}), not pm2`);
  });
  report.status('MA-emp-add-other', await api('emp1', 'PATCH', `/api/tasks/${T.id}`, { assignee_ids: [ids.emp1, ids.emp2, ids.outsider] }), 403, 'an employee cannot add someone else');
  report.status('MA-emp-create-other', await api('emp1', 'POST', '/api/tasks', { name: `Emp shared ${RUN}`, project_id: IDS.website, assignee_ids: [ids.emp1, ids.emp2] }), 403, 'nor create a task for others');
  report.status('MA-emp-remove-other', await api('emp1', 'PATCH', `/api/tasks/${T.id}`, { assignee_ids: [ids.emp1] }), 403, 'nor remove someone');
  report.status('MA-max', await api('pm', 'PATCH', `/api/tasks/${T.id}`, { assignee_ids: Array.from({ length: 11 }, () => crypto.randomUUID()) }), 400, 'at most 10 assignees');

  report.start('Bypassing the API (database rules)');
  await step('DB-insert-other', async () => {
    const r = await asUser(ids.emp1, 'insert into task_assignees (task_id, user_id) values ($1, $2)', [T.id, ids.pm2]);
    report.record('DB-insert-other', !r.ok, `employee inserting someone else directly: ${r.ok ? 'ALLOWED' : `refused (${r.code})`}`);
  });
  await step('DB-update-other', async () => {
    const r = await asUser(ids.emp1, "update task_assignees set progress_percent = 99, report = 'hacked' where task_id = $1 and user_id = $2", [T.id, ids.emp2]);
    const { data: row } = await admin.from('task_assignees').select('progress_percent, report').eq('task_id', T.id).eq('user_id', ids.emp2).single();
    report.record('DB-update-other', (!r.ok || true) && row.progress_percent !== 99 && row.report !== 'hacked', `changing another person's part directly: ${r.ok ? 'no rows changed' : `refused (${r.code})`}`);
  });
  await step('DB-manager-same-level', async () => {
    const r = await asUser(ids.pm, 'insert into task_assignees (task_id, user_id) values ($1, $2)', [T.id, ids.pm2]);
    report.record('DB-manager-same-level', !r.ok, `manager inserting a same-level person directly: ${r.ok ? 'ALLOWED' : `refused (${r.code})`}`);
  });

  // ------------------------------------------------------------------ individual work
  report.start('Each person reports their own part');
  await step('MY-emp1', async () => {
    const r = await api('emp1', 'PATCH', `/api/tasks/${T.id}/my-work`, { progress_percent: 80, report: 'Tested login and signup' });
    report.status('MY-emp1', r, 200, 'emp1: 80%');
  });
  await step('MY-emp2', async () => {
    const r = await api('emp2', 'PATCH', `/api/tasks/${T.id}/my-work`, { progress_percent: 50, report: 'Testing checkout' });
    report.status('MY-emp2', r, 200, 'emp2: 50%');
  });
  await step('MY-overall', async () => {
    const d = payload(await api('pm', 'GET', `/api/tasks/${T.id}/assignees`));
    const by = Object.fromEntries((d?.assignees || []).map((a) => [a.user_id, a]));
    const { data: task } = await admin.from('tasks').select('progress_percent, status').eq('id', T.id).single();
    report.record('MY-separate', by[ids.emp1]?.progress_percent === 80 && by[ids.emp2]?.progress_percent === 50 && by[ids.emp1]?.report === 'Tested login and signup', 'manager sees each person\'s own progress and report');
    report.record('MY-overall', d?.summary?.progress === 65 && task.progress_percent === 65, `overall ${d?.summary?.progress}% (task ${task.progress_percent}%) = average`);
    report.record('MY-in-progress', task.status === 'in_progress', `task moved to ${task.status} once work started`);
  });
  report.status('MY-outsider', await api('outsider', 'PATCH', `/api/tasks/${T.id}/my-work`, { progress_percent: 10 }), [403, 404], 'someone not on the task cannot report on it');
  report.status('MY-manager-not-assignee', await api('pm', 'PATCH', `/api/tasks/${T.id}/my-work`, { progress_percent: 10 }), 403, 'a manager who is not on the task has no part to report');

  await step('MY-blocker', async () => {
    const r = await api('emp2', 'PATCH', `/api/tasks/${T.id}/my-work`, { blocker: 'Payment sandbox is down' });
    const d = payload(await api('pm', 'GET', `/api/tasks/${T.id}/assignees`));
    const mine = (d?.assignees || []).find((a) => a.user_id === ids.emp2);
    report.record('MY-blocker', r.status === 200 && mine?.status === 'blocked' && mine?.blocker === 'Payment sandbox is down', `emp2 blocked: ${mine?.status}`);
    report.record('MY-blocker-notified', (await countType('pm', 'task_blocker', `Website testing ${RUN}`)) === 1 && (await countType('emp1', 'task_blocker', `Website testing ${RUN}`)) === 1, 'manager and teammate told once');
    await api('emp2', 'PATCH', `/api/tasks/${T.id}/my-work`, { blocker: '' });
  });

  // ------------------------------------------------------------------ time
  report.start('Time per person on the shared task');
  await step('TIME', async () => {
    const day = isoDate(new Date());
    const a = await api('emp1', 'POST', '/api/time-entries', { taskId: T.id, projectId: IDS.website, hoursLogged: 2, entryDate: day, description: 'Testing' });
    const b = await api('emp2', 'POST', '/api/time-entries', { taskId: T.id, projectId: IDS.website, hoursLogged: 1.5, entryDate: day, description: 'Testing' });
    const d = payload(await api('pm', 'GET', `/api/tasks/${T.id}/assignees`));
    const by = Object.fromEntries((d?.assignees || []).map((x) => [x.user_id, x.hours_logged]));
    report.record('TIME-logged', [200, 201].includes(a.status) && [200, 201].includes(b.status), `entries: ${a.status} ${b.status}`);
    report.record('TIME-breakdown', by[ids.emp1] === 2 && by[ids.emp2] === 1.5 && d?.summary?.hours_logged === 3.5, `emp1 ${by[ids.emp1]}h, emp2 ${by[ids.emp2]}h, total ${d?.summary?.hours_logged}h`);
  });

  // ------------------------------------------------------------------ views
  report.start('My Tasks, board, manager views');
  await step('VIEW-my-tasks', async () => {
    const list = payload(await api('emp2', 'GET', '/api/me/tasks?view=assigned')) || [];
    const t = list.find((x) => x.id === T.id);
    report.record('VIEW-my-tasks', !!t && t.my_part?.user_id === ids.emp2 && t.assignees?.length === 2, 'the second assignee sees the shared task with their own part');
  });
  await step('VIEW-board', async () => {
    const d = payload(await api('pm', 'GET', `/api/projects/${IDS.website}/page-data?view=tasks`));
    const t = (d?.tasks || []).find((x) => x.id === T.id);
    report.record('VIEW-board', t?.assignees?.length === 2, 'the project board data lists both people');
  });
  await step('VIEW-detail', async () => {
    const d = payload(await api('emp2', 'GET', `/api/tasks/${T.id}/detail`));
    report.record('VIEW-detail', d?.shared === true && d?.assignees?.length === 2 && d?.permissions?.isAssignee === true && !d.permissions.actions.includes('submit'), 'detail: shared, both people, own part instead of task-level submit');
  });
  await step('VIEW-manager-team', async () => {
    const team = payload(await api('pm', 'GET', '/api/manager/team')) || [];
    const emp2 = team.find((r) => r.user?.id === ids.emp2);
    report.record('VIEW-manager-team', !!emp2, 'manager team view includes the second assignee');
  });

  // ------------------------------------------------------------------ completion
  report.start('Completion');
  await step('DONE-one', async () => {
    const r = await api('emp1', 'PATCH', `/api/tasks/${T.id}/my-work`, { status: 'done' });
    const { data: task } = await admin.from('tasks').select('status').eq('id', T.id).single();
    report.record('DONE-one', r.status === 200 && task.status === 'in_progress', `one person done: task stays ${task.status}`);
    report.record('DONE-one-notified', (await countType('pm', 'task_part_done', `Website testing ${RUN}`)) === 1, 'manager told that a part is done');
  });
  await step('DONE-all', async () => {
    const r = await api('emp2', 'POST', `/api/tasks/${T.id}/status`, { action: 'submit' });
    const { data: task } = await admin.from('tasks').select('status, progress_percent').eq('id', T.id).single();
    report.record('DONE-all', r.status === 200 && task.status === 'review' && task.progress_percent === 100, `everyone done: task ${task.status}, ${task.progress_percent}%`);
  });
  await step('DONE-approve', async () => {
    const r = await api('pm', 'POST', `/api/tasks/${T.id}/status`, { action: 'approve' });
    const { data: task } = await admin.from('tasks').select('status').eq('id', T.id).single();
    report.record('DONE-approve', r.status === 200 && task.status === 'done', `manager approves: ${task.status}`);
    report.record('DONE-approve-notified', (await countType('emp1', 'task_approved', `Website testing ${RUN}`)) === 1 && (await countType('emp2', 'task_approved', `Website testing ${RUN}`)) === 1, 'both assignees told once');
  });
  report.status('DONE-locked', await api('emp1', 'PATCH', `/api/tasks/${T.id}/my-work`, { progress_percent: 40 }), 409, 'a done task is not changed by an assignee');
  await step('DONE-reopen', async () => {
    const r = await api('pm', 'POST', `/api/tasks/${T.id}/status`, { action: 'reopen' });
    const { data: rows } = await admin.from('task_assignees').select('status').eq('task_id', T.id);
    report.record('DONE-reopen', r.status === 200 && rows.every((x) => x.status === 'in_progress'), `reopened: parts ${rows.map((x) => x.status).join(', ')}`);
    report.record('DONE-reopen-notified', (await countType('emp2', 'task_reopened', `Website testing ${RUN}`)) === 1, 'assignees told once');
  });
  await step('DONE-override', async () => {
    const r = await api('pm', 'PATCH', `/api/tasks/${T.id}`, { status: 'done' });
    const { data: rows } = await admin.from('task_assignees').select('status').eq('task_id', T.id);
    report.record('DONE-override', r.status === 200 && rows.every((x) => x.status === 'done'), 'a manager can mark the whole task done');
  });
  await step('DETAILS-notified', async () => {
    await api('pm', 'POST', `/api/tasks/${T.id}/status`, { action: 'reopen' });
    const before = await countType('emp2', 'task_updated', `Website testing ${RUN}`);
    await api('pm', 'PATCH', `/api/tasks/${T.id}`, { due_date: isoDate(new Date(Date.now() + 9 * 864e5)), priority: 'urgent' });
    const after = await countType('emp2', 'task_updated', `Website testing ${RUN}`);
    report.record('DETAILS-notified', after - before === 1, 'a change of dates and priority: one notification per assignee');
  });

  // ------------------------------------------------------------------ single-assignee tasks
  report.start('Existing single-assignee behaviour');
  await step('SINGLE', async () => {
    const r = await api('pm', 'POST', '/api/tasks', { name: `Single ${RUN}`, project_id: IDS.website, assigned_to: ids.emp1 });
    const S1 = payload(r)?.task || r.body?.task;
    const { data: rows } = await admin.from('task_assignees').select('user_id').eq('task_id', S1.id);
    report.record('SINGLE-create', r.status === 201 && S1.assigned_to === ids.emp1 && rows.length === 1, 'legacy assigned_to still works, with one row');
    report.status('SINGLE-start', await api('emp1', 'POST', `/api/tasks/${S1.id}/status`, { action: 'start' }), 200);
    report.status('SINGLE-progress', await api('emp1', 'PATCH', `/api/tasks/${S1.id}`, { progress_percent: 40 }), 200);
    report.status('SINGLE-submit', await api('emp1', 'POST', `/api/tasks/${S1.id}/status`, { action: 'submit' }), 200);
    const { data: row } = await admin.from('task_assignees').select('status, progress_percent').eq('task_id', S1.id).single();
    const { data: task } = await admin.from('tasks').select('status').eq('id', S1.id).single();
    report.record('SINGLE-mirror', task.status === 'review' && row.status === 'done', `task ${task.status}, part ${row.status}`);
    report.status('SINGLE-myw-refused', await api('emp1', 'PATCH', `/api/tasks/${S1.id}/my-work`, { progress_percent: 10 }), 400, 'single tasks use the task actions');
    const re = await api('pm', 'PATCH', `/api/tasks/${S1.id}`, { assigned_to: ids.emp2 });
    const { data: after } = await admin.from('task_assignees').select('user_id').eq('task_id', S1.id);
    report.record('SINGLE-reassign', re.status === 200 && after.length === 1 && after[0].user_id === ids.emp2, 'reassigning a single task replaces its one assignee');
  });
}

// pm2 is not on the website team in the shared seed: take them off again so other suites are not affected
async function cleanup() {
  const { data: users } = await admin.from('user_profiles').select('id').eq('email', PERSONAS.pm2.email);
  const pm2 = users?.[0]?.id;
  if (!pm2) return;
  const { data: tasks } = await admin.from('tasks').select('id').eq('project_id', IDS.website);
  const taskIds = (tasks || []).map((t) => t.id);
  if (taskIds.length) await admin.from('task_assignees').delete().eq('user_id', pm2).in('task_id', taskIds);
  await admin.from('project_assignments').delete().eq('project_id', IDS.website).eq('user_id', pm2);
}

main()
  .catch((e) => report.error('UNCAUGHT', e))
  .finally(async () => { await cleanup().catch((e) => report.error('CLEANUP', e)); const failed = report.summary(); process.exit(failed ? 1 : 0); });
