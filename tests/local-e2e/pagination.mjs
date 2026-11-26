// Server-side pagination: page boundaries, page sizes, search, filters, sorting, access rules and the old
// (unpaged) responses, for every paginated list. Runs against the local app (port 3100) on the seeded
// local database (npm run e2e:local:seed first).
//
// NON-DESTRUCTIVE: creates temporary rows named "Pg <run>" (projects, tasks, time entries, notifications,
// updates, comments, files, invitations, feedback, audit entries) and deletes all of them at the end.
//
// Usage: node tests/local-e2e/pagination.mjs
import { loadEnv, adminClient, signIn, call, Report } from './lib.mjs';

const env = loadEnv();
const admin = adminClient(env);
const report = new Report('Pagination (server-side)');
const RUN = Date.now().toString(36);
const TAG = `Pg ${RUN}`;
const made = { projects: [], tasks: [], timeEntries: [], notifications: [], updates: [], comments: [], files: [], invitations: [], feedback: [], audit: [], users: [], accounts: [] };
const pad = (n) => String(n).padStart(2, '0');
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const PRIORITY_RANK = { urgent: 4, high: 3, medium: 2, low: 1 };

const ok = (id, cond, detail = '') => report.record(id, !!cond, detail);
const pg = (r) => r.body?.meta?.pagination || r.body?.pagination;
const rows = (r) => (Array.isArray(r.body?.data) ? r.body.data : Array.isArray(r.body) ? r.body : []);
const samePage = (p, expected) => p && Object.entries(expected).every(([k, v]) => p[k] === v);
const describe = (p) => (p ? `page ${p.page}/${p.totalPages}, size ${p.pageSize}, total ${p.total}, next ${p.hasNextPage}, prev ${p.hasPreviousPage}` : 'no pagination');

async function insert(table, values, list) {
  const { data, error } = await admin.from(table).insert(values).select('id');
  if (error) throw new Error(`${table}: ${error.message}`);
  if (list) list.push(...data.map((r) => r.id));
  return data;
}

async function main() {
  // Seeded people and data
  const { data: people } = await admin.from('user_profiles').select('id, email').like('email', 'e2e.%@example.com');
  const id = Object.fromEntries((people || []).map((p) => [p.email.split('@')[0].replace('e2e.', ''), p.id]));
  for (const k of ['superadmin', 'pm', 'emp1', 'emp2', 'client']) if (!id[k]) throw new Error(`Seeded user e2e.${k} missing: run npm run e2e:local:seed`);
  const { data: acme } = await admin.from('accounts').select('id').eq('name', 'Acme Corp (E2E)').single();
  const { data: website } = await admin.from('projects').select('id').eq('name', 'Website Redesign (E2E)').single();
  const S = {
    sa: await signIn(env, 'e2e.superadmin@example.com'),
    pm: await signIn(env, 'e2e.pm@example.com'),
    emp1: await signIn(env, 'e2e.emp1@example.com'),
    emp2: await signIn(env, 'e2e.emp2@example.com'),
    client: await signIn(env, 'e2e.client@example.com'),
  };

  // ---------------------------------------------------------------- test data
  report.start('Test data');
  const today = new Date();
  const projectRows = Array.from({ length: 45 }, (_, i) => ({
    name: `${TAG} ${pad(i + 1)}`, account_id: acme.id, status: i % 2 ? 'planning' : 'in_progress',
    priority: PRIORITIES[i % 4], end_date: new Date(today.getTime() + (i + 1) * 86400000).toISOString().slice(0, 10),
    created_by: id.pm, assigned_user_id: id.pm,
  }));
  const projects = await insert('projects', projectRows, made.projects);
  // Hidden from the Projects page: complete and archived
  await insert('projects', [
    { name: `${TAG} complete`, account_id: acme.id, status: 'complete', priority: 'low', created_by: id.pm, assigned_user_id: id.pm },
    { name: `${TAG} archived`, account_id: acme.id, status: 'planning', priority: 'low', created_by: id.pm, assigned_user_id: id.pm, archived_at: new Date().toISOString() },
  ], made.projects);
  // emp1 is on the team of the first three
  await admin.from('project_assignments').insert(projects.slice(0, 3).map((p) => ({ project_id: p.id, user_id: id.emp1, role_in_project: 'Developer', assigned_by: id.pm })));

  const past = (d) => new Date(today.getTime() - d * 86400000).toISOString().slice(0, 10);
  const future = (d) => new Date(today.getTime() + d * 86400000).toISOString().slice(0, 10);
  const taskRows = Array.from({ length: 45 }, (_, i) => ({
    name: `${TAG} task ${pad(i + 1)}`, project_id: website.id, assigned_to: id.emp1, created_by: id.pm,
    priority: PRIORITIES[i % 4], status: i < 5 ? 'backlog' : i < 15 ? 'in_progress' : 'todo',
    due_date: i < 10 ? past(i + 2) : future(i + 30),
  }));
  await insert('tasks', taskRows, made.tasks);

  const entryRows = Array.from({ length: 45 }, (_, i) => {
    const d = new Date(Date.UTC(2020, 0, 6 + i));
    const monday = new Date(d); monday.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return { user_id: id.emp1, project_id: website.id, hours_logged: 1.5, entry_date: d.toISOString().slice(0, 10), week_start_date: monday.toISOString().slice(0, 10), description: `${TAG} entry ${pad(i + 1)}`, is_auto_clock_out: i < 4 };
  });
  await insert('time_entries', entryRows, made.timeEntries);
  ok('created 47 projects, 45 tasks, 45 time entries', true);

  // ---------------------------------------------------------------- Projects
  report.start('Projects (/api/projects/list)');
  const q = encodeURIComponent(TAG);
  const p1 = await call(env, S.sa, 'GET', `/api/projects/list?q=${q}&page=1&pageSize=20`);
  report.status('page 1 answers', p1, 200);
  ok('page 1: 20 rows', rows(p1).length === 20, `${rows(p1).length} rows`);
  ok('page 1: pagination block', samePage(pg(p1), { page: 1, pageSize: 20, total: 45, totalPages: 3, hasNextPage: true, hasPreviousPage: false }), describe(pg(p1)));
  ok('complete and archived projects are not listed', !rows(p1).some((r) => /complete|archived/.test(r.name)));
  ok('rows keep their details (account, team, departments)', rows(p1).every((r) => r.account && Array.isArray(r.assigned_users) && Array.isArray(r.departments)));
  const p2 = await call(env, S.sa, 'GET', `/api/projects/list?q=${q}&page=2&pageSize=20`);
  ok('page 2: 20 other rows', rows(p2).length === 20 && !rows(p2).some((r) => rows(p1).some((x) => x.id === r.id)), describe(pg(p2)));
  const p3 = await call(env, S.sa, 'GET', `/api/projects/list?q=${q}&page=3&pageSize=20`);
  ok('last page: 5 rows, no next page', rows(p3).length === 5 && pg(p3)?.hasNextPage === false && pg(p3)?.hasPreviousPage === true, describe(pg(p3)));
  const seen = new Set([...rows(p1), ...rows(p2), ...rows(p3)].map((r) => r.id));
  ok('pages together: all 45, no duplicates', seen.size === 45);
  const p9 = await call(env, S.sa, 'GET', `/api/projects/list?q=${q}&page=9&pageSize=20`);
  ok('page past the end: empty, total still 45', rows(p9).length === 0 && pg(p9)?.total === 45, describe(pg(p9)));
  const p50 = await call(env, S.sa, 'GET', `/api/projects/list?q=${q}&page=1&pageSize=50`);
  ok('page size 50: all 45 on one page', rows(p50).length === 45 && pg(p50)?.totalPages === 1, describe(pg(p50)));
  const pOdd = await call(env, S.sa, 'GET', `/api/projects/list?q=${q}&page=1&pageSize=7`);
  ok('unsupported page size falls back to 20', pg(pOdd)?.pageSize === 20 && rows(pOdd).length === 20);
  const pNone = await call(env, S.sa, 'GET', `/api/projects/list?q=${encodeURIComponent(`${TAG} nothing-matches`)}&page=1`);
  ok('search without matches: empty, total 0', rows(pNone).length === 0 && pg(pNone)?.total === 0, describe(pg(pNone)));
  const pOne = await call(env, S.sa, 'GET', `/api/projects/list?q=${encodeURIComponent(`${TAG} 07`)}&page=1`);
  ok('search finds the one project', rows(pOne).length === 1 && rows(pOne)[0].name === `${TAG} 07`);
  const byName = await call(env, S.sa, 'GET', `/api/projects/list?q=${q}&page=1&pageSize=50&sort=name&order=desc`);
  const names = rows(byName).map((r) => r.name);
  ok('sort by name (desc) across the whole result', names[0] === `${TAG} 45` && names.every((n, i) => i === 0 || names[i - 1].localeCompare(n) >= 0));
  const byPriority = await call(env, S.sa, 'GET', `/api/projects/list?q=${q}&page=1&pageSize=20&sort=priority&order=desc`);
  ok('sort by priority (desc): page 1 is the urgent and high ones', rows(byPriority).every((r) => PRIORITY_RANK[r.priority] >= 3), rows(byPriority).map((r) => r.priority).join(','));
  const byDeadline = await call(env, S.sa, 'GET', `/api/projects/list?q=${q}&page=2&pageSize=20&sort=deadline`);
  const dates = rows(byDeadline).map((r) => r.end_date);
  ok('sort by deadline, page 2 continues in order', dates[0] === projectRows[20].end_date && dates.every((d, i) => i === 0 || dates[i - 1] <= d));
  const dept = await call(env, S.sa, 'GET', `/api/projects/list?q=${q}&page=1&department=00000000-0000-0000-0000-000000000000`);
  ok('department filter with no matching team: empty', rows(dept).length === 0 && pg(dept)?.total === 0);
  ok('department list for the filter is included', Array.isArray(p1.body?.meta?.departments));
  // Access: same visibility as before
  const e1 = await call(env, S.emp1, 'GET', `/api/projects/list?q=${q}&page=1`);
  ok('employee sees only the 3 projects they are on', pg(e1)?.total === 3 && rows(e1).length === 3, describe(pg(e1)));
  const e2 = await call(env, S.emp2, 'GET', `/api/projects/list?q=${q}&page=1`);
  ok('employee not on any of them sees none', pg(e2)?.total === 0 && rows(e2).length === 0);
  const old = await call(env, S.emp1, 'GET', '/api/projects/list');
  const oldMine = (Array.isArray(old.body?.data) ? old.body.data : []).filter((r) => r.name.startsWith(TAG));
  ok('without page: the old full list (same 3 for the employee)', old.status === 200 && Array.isArray(old.body?.data) && !old.body?.meta && oldMine.length === 3);
  const cl = await call(env, S.client, 'GET', `/api/projects/list?page=1`);
  report.status('client account: not available', cl, 403);
  const anon = await call(env, null, 'GET', `/api/projects/list?page=1`);
  report.status('signed out: refused', anon, 401);

  // ---------------------------------------------------------------- My Tasks
  report.start('My Tasks (/api/me/tasks)');
  const tq = encodeURIComponent(`${TAG} task`);
  const t1 = await call(env, S.emp1, 'GET', `/api/me/tasks?view=assigned&q=${tq}&page=1&pageSize=20`);
  report.status('page 1 answers', t1, 200);
  ok('page 1: 20 rows', rows(t1).length === 20 && samePage(pg(t1), { page: 1, pageSize: 20, total: 45, totalPages: 3, hasNextPage: true }), describe(pg(t1)));
  ok('ordered by deadline (earliest first)', rows(t1).every((r, i, a) => i === 0 || (a[i - 1].due_date || '9') <= (r.due_date || '9')));
  ok('rows keep project and subtask counts', rows(t1).every((r) => r.project?.id === website.id && r.subtasks && typeof r.subtasks.total === 'number'));
  ok('legacy status shown as its new name', rows(t1).filter((r) => r.name.endsWith(' 01')).every((r) => r.status === 'todo'));
  const t3 = await call(env, S.emp1, 'GET', `/api/me/tasks?view=assigned&q=${tq}&page=3&pageSize=20`);
  ok('last page: 5 rows', rows(t3).length === 5 && pg(t3)?.hasNextPage === false);
  const t100 = await call(env, S.emp1, 'GET', `/api/me/tasks?view=assigned&q=${tq}&page=1&pageSize=100`);
  ok('page size 100: all 45', rows(t100).length === 45 && pg(t100)?.totalPages === 1);
  const high = await call(env, S.emp1, 'GET', `/api/me/tasks?view=assigned&q=${tq}&priority=high&page=1`);
  const wantHigh = taskRows.filter((t) => t.priority === 'high').length;
  ok('priority filter counted on the server', pg(high)?.total === wantHigh && rows(high).every((r) => r.priority === 'high'), `${pg(high)?.total}/${wantHigh}`);
  const todo = await call(env, S.emp1, 'GET', `/api/me/tasks?view=assigned&q=${tq}&status=todo&page=1&pageSize=50`);
  const wantTodo = taskRows.filter((t) => t.status === 'todo' || t.status === 'backlog').length;
  ok('status filter includes legacy "backlog" as to-do', pg(todo)?.total === wantTodo, `${pg(todo)?.total}/${wantTodo}`);
  const overdue = await call(env, S.emp1, 'GET', `/api/me/tasks?view=assigned&q=${tq}&due=overdue&page=1`);
  ok('overdue filter', pg(overdue)?.total === 10, `${pg(overdue)?.total}/10`);
  const inProgress = await call(env, S.emp1, 'GET', `/api/me/tasks?view=in_progress&q=${tq}&page=1`);
  ok('in-progress view', pg(inProgress)?.total === 10 && rows(inProgress).every((r) => r.status === 'in_progress'), `${pg(inProgress)?.total}/10`);
  const counts = t1.body?.meta?.counts;
  ok('per-view counts still included', counts && counts.assigned >= 45 && counts.overdue >= 10 && typeof counts.to_review === 'number');
  ok('project options still included', (t1.body?.meta?.projects || []).some((p) => p.id === website.id));
  const tOld = await call(env, S.emp1, 'GET', `/api/me/tasks?view=assigned&q=${tq}`);
  ok('without page: all matching tasks, no pagination block (old behaviour)', rows(tOld).length === 45 && !tOld.body?.meta?.pagination);
  const tOther = await call(env, S.emp2, 'GET', `/api/me/tasks?view=assigned&q=${tq}&page=1`);
  ok("someone else's tasks are not listed", pg(tOther)?.total === 0 && rows(tOther).length === 0);

  // ---------------------------------------------------------------- Admin time tracking
  report.start('Admin time tracking (/api/admin/time-entries)');
  const range = `startDate=2020-01-01&endDate=2020-03-31&userId=${id.emp1}`;
  const a1 = await call(env, S.sa, 'GET', `/api/admin/time-entries?${range}&page=1&pageSize=20`);
  report.status('page 1 answers', a1, 200);
  ok('page 1: 20 rows', (a1.body?.timeEntries || []).length === 20 && samePage(a1.body?.pagination, { page: 1, total: 45, totalPages: 3 }), describe(a1.body?.pagination));
  ok('newest first', (a1.body?.timeEntries || [])[0]?.entry_date === entryRows[44].entry_date);
  ok('summary covers all 45 entries, not just the page', a1.body?.summary?.totalEntries === 45 && a1.body?.summary?.totalHours === 67.5 && a1.body?.summary?.autoClockOuts === 4 && a1.body?.summary?.uniqueUsers === 1, JSON.stringify(a1.body?.summary));
  const a3 = await call(env, S.sa, 'GET', `/api/admin/time-entries?${range}&page=3&pageSize=20`);
  ok('last page: 5 rows (the oldest)', (a3.body?.timeEntries || []).length === 5 && a3.body?.timeEntries?.at(-1)?.entry_date === entryRows[0].entry_date);
  const a50 = await call(env, S.sa, 'GET', `/api/admin/time-entries?${range}&page=1&pageSize=50`);
  ok('page size 50: all 45', (a50.body?.timeEntries || []).length === 45);
  const aOld = await call(env, S.sa, 'GET', `/api/admin/time-entries?${range}`);
  ok('without page: all entries and summary (old behaviour, used by Export CSV)', (aOld.body?.timeEntries || []).length === 45 && !aOld.body?.pagination && aOld.body?.summary?.totalEntries === 45);
  const aEmpty = await call(env, S.sa, 'GET', `/api/admin/time-entries?startDate=2019-01-01&endDate=2019-01-31&userId=${id.emp1}&page=1`);
  ok('no matches: empty page and zero summary', (aEmpty.body?.timeEntries || []).length === 0 && aEmpty.body?.pagination?.total === 0 && aEmpty.body?.summary?.totalEntries === 0);
  const aBad = await call(env, S.sa, 'GET', `/api/admin/time-entries?startDate=not-a-date&page=1`);
  report.status('invalid date refused', aBad, 400);
  const aEmp = await call(env, S.emp1, 'GET', `/api/admin/time-entries?${range}&page=1`);
  report.status('employee without the permission: refused', aEmp, 403);

  // ---------------------------------------------------------------- cursor feeds
  // Follow a feed to its end; returns the rows of every chunk and the chunk sizes
  const follow = async (who, base, pick, meta) => {
    const chunks = [];
    let cursor = null;
    for (let i = 0; i < 20; i++) {
      const r = await call(env, who, 'GET', `${base}${base.includes('?') ? '&' : '?'}limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      if (r.status !== 200) return { error: `HTTP ${r.status} ${r.text.slice(0, 120)}`, chunks };
      const m = meta(r);
      chunks.push(pick(r));
      if (!m.hasMore) return { chunks, last: m };
      cursor = m.nextCursor;
      if (!cursor) return { error: 'hasMore without nextCursor', chunks };
    }
    return { error: 'did not end', chunks };
  };
  const at = (i) => `2099-01-01T00:${pad(Math.floor(i / 60))}:${pad(i % 60)}.000Z`;
  const P = projects[0].id;

  report.start('Notifications (cursor)');
  // 45 of emp1's notifications, newest in the far future so they come first; two share a timestamp
  const nRows = Array.from({ length: 45 }, (_, i) => ({ user_id: id.emp1, title: `${TAG} n ${pad(i + 1)}`, message: 'pagination test', type: 'general', read: i % 3 === 0, created_at: at(i === 10 ? 9 : i) }));
  await insert('notifications', nRows, made.notifications);
  const nFirst = await call(env, S.emp1, 'GET', '/api/notifications?limit=20');
  ok('first chunk: newest 20, more to come', rows(nFirst).length === 20 && nFirst.body?.meta?.hasMore === true && !!nFirst.body?.meta?.nextCursor && rows(nFirst)[0].title === `${TAG} n 45`);
  ok('unread count still included', typeof nFirst.body?.meta?.unread === 'number');
  const nFeed = await follow(S.emp1, '/api/notifications', rows, (r) => r.body?.meta || {});
  const nMine = nFeed.chunks.flat().filter((r) => r.title?.startsWith(TAG));
  ok('following the feed: all 45 once each (including the two with the same time)', !nFeed.error && nMine.length === 45 && new Set(nMine.map((r) => r.id)).size === 45, nFeed.error || `${nMine.length} of 45`);
  ok('chunks are newest first', nMine.every((r, i, a) => i === 0 || a[i - 1].created_at >= r.created_at));
  const nUnread = await follow(S.emp1, '/api/notifications?unread=1', rows, (r) => r.body?.meta || {});
  const nUnreadMine = nUnread.chunks.flat().filter((r) => r.title?.startsWith(TAG));
  ok('unread filter with the cursor', nUnreadMine.length === nRows.filter((n) => !n.read).length && nUnreadMine.every((r) => !r.read), `${nUnreadMine.length}`);
  const nBell = await call(env, S.emp1, 'GET', '/api/notifications?limit=10');
  ok('the bell (limit=10) still gets 10 and the unread count', rows(nBell).length === 10 && typeof nBell.body?.meta?.unread === 'number');
  const nBad = await call(env, S.emp1, 'GET', '/api/notifications?limit=20&cursor=not-a-cursor');
  ok('an unreadable cursor starts from the newest', rows(nBad)[0]?.title === `${TAG} n 45`);
  const nOther = await call(env, S.emp2, 'GET', '/api/notifications?limit=200');
  ok("someone else's notifications are not listed", !rows(nOther).some((r) => r.title?.startsWith(TAG)));

  report.start('Audit log (cursor)');
  await insert('audit_log', Array.from({ length: 25 }, (_, i) => ({ actor_id: id.superadmin, action: `${TAG} action`, entity_type: 'project', entity_id: P, project_id: P, details: { i }, created_at: at(i) })), made.audit);
  const aFeed = await follow(S.sa, `/api/admin/audit-log?projectId=${P}`, rows, (r) => r.body?.meta || {});
  ok('chunks of 10: 10, 10, 5, then the end', !aFeed.error && aFeed.chunks.map((c) => c.length).join(',') === '10,10,5', aFeed.error || aFeed.chunks.map((c) => c.length).join(','));
  ok('all 25 once each, newest first', new Set(aFeed.chunks.flat().map((r) => r.id)).size === 25 && aFeed.chunks.flat()[0]?.details?.i === 24);
  ok('actor names still included', aFeed.chunks.flat().every((r) => 'actor_name' in r));
  const auOld = await call(env, S.sa, 'GET', `/api/admin/audit-log?projectId=${P}`);
  ok('without limit: up to 100 (as before)', rows(auOld).length === 25);
  const aBadId = await call(env, S.sa, 'GET', '/api/admin/audit-log?projectId=nope');
  report.status('invalid project id refused', aBadId, 400);
  const aEmp1 = await call(env, S.emp1, 'GET', '/api/admin/audit-log?limit=10');
  report.status('non-superadmin refused', aEmp1, 403);

  report.start('Project files (cursor)');
  await insert('project_files', Array.from({ length: 25 }, (_, i) => ({ project_id: P, file_name: `${TAG} file ${pad(i + 1)}.txt`, storage_path: `${P}/pg-${RUN}-${i}/f.txt`, size_bytes: 10 + i, mime_type: 'text/plain', uploaded_by: id.pm, created_at: at(i) })), made.files);
  const fFeed = await follow(S.sa, `/api/projects/${P}/files`, rows, (r) => r.body?.meta || {});
  ok('chunks of 10: 10, 10, 5', !fFeed.error && fFeed.chunks.map((c) => c.length).join(',') === '10,10,5', fFeed.error || fFeed.chunks.map((c) => c.length).join(','));
  ok('uploader names still included', fFeed.chunks.flat().every((f) => f.uploader?.name));
  const fOld = await call(env, S.sa, 'GET', `/api/projects/${P}/files`);
  ok('without limit: every file, no cursor (as before)', rows(fOld).length === 25 && !fOld.body?.meta);
  const fEmp2 = await call(env, S.emp2, 'GET', `/api/projects/${P}/files?limit=10`);
  report.status('not on the project: refused', fEmp2, [403, 404]);

  report.start('Project updates (cursor)');
  await insert('project_updates', Array.from({ length: 25 }, (_, i) => ({ project_id: P, content: `${TAG} update ${pad(i + 1)}`, created_by: id.pm, created_at: at(i) })), made.updates);
  const uFeed = await follow(S.sa, `/api/projects/${P}/updates`, (r) => r.body?.updates || [], (r) => ({ hasMore: r.body?.hasMore, nextCursor: r.body?.nextCursor }));
  ok('chunks of 10: 10, 10, 5', !uFeed.error && uFeed.chunks.map((c) => c.length).join(',') === '10,10,5', uFeed.error || uFeed.chunks.map((c) => c.length).join(','));
  ok('newest first, author included', uFeed.chunks.flat()[0]?.content === `${TAG} update 25` && uFeed.chunks.flat().every((u) => u.user_profiles?.name));
  const uOld = await call(env, S.sa, 'GET', `/api/projects/${P}/updates`);
  ok('without limit: every update (as before)', (uOld.body?.updates || []).length === 25 && uOld.body?.hasMore === undefined);

  // ---------------------------------------------------------------- Batch 3: tables
  report.start('Admin users (/api/admin/users)');
  const userRows = [];
  for (let i = 0; i < 25; i++) {
    const email = `pgu.${RUN}.${pad(i)}@example.com`;
    const { data, error } = await admin.auth.admin.createUser({ email, password: 'PgUser2026x', email_confirm: true, user_metadata: { name: `${TAG} user ${pad(i + 1)}` } });
    if (error) throw error;
    made.users = made.users || [];
    made.users.push(data.user.id);
    userRows.push(data.user.id);
  }
  await admin.from('user_profiles').update({ is_active: false }).in('id', userRows.slice(0, 5));
  const uq = encodeURIComponent(TAG);
  const au1 = await call(env, S.sa, 'GET', `/api/admin/users?type=all&q=${uq}&page=1&pageSize=20`);
  report.status('page 1 answers', au1, 200);
  ok('page 1: 20 users, total 25', (au1.body?.data?.users || []).length === 20 && samePage(au1.body?.meta?.pagination, { page: 1, total: 25, totalPages: 2, hasNextPage: true }), describe(au1.body?.meta?.pagination));
  ok('rows keep roles, departments, account name', (au1.body?.data?.users || []).every((u) => Array.isArray(u.roles) && Array.isArray(u.departments) && 'account_name' in u));
  ok('departments list still included', Array.isArray(au1.body?.data?.departments));
  const au2 = await call(env, S.sa, 'GET', `/api/admin/users?type=all&q=${uq}&page=2&pageSize=20`);
  ok('last page: 5 users, no overlap', (au2.body?.data?.users || []).length === 5 && !(au2.body?.data?.users || []).some((u) => (au1.body?.data?.users || []).some((x) => x.id === u.id)));
  const auOne = await call(env, S.sa, 'GET', `/api/admin/users?type=all&q=${encodeURIComponent(`${TAG} user 07`)}&page=1`);
  ok('search by name finds one', (auOne.body?.data?.users || []).length === 1 && auOne.body?.meta?.pagination?.total === 1);
  const auMail = await call(env, S.sa, 'GET', `/api/admin/users?type=all&q=${encodeURIComponent(`pgu.${RUN}.03`)}&page=1`);
  ok('search by email finds one', (auMail.body?.data?.users || []).length === 1);
  const auActive = await call(env, S.sa, 'GET', `/api/admin/users?type=all&q=${uq}&inactive=0&page=1&pageSize=50`);
  ok('hide deactivated: 20 of 25 remain', auActive.body?.meta?.pagination?.total === 20 && (auActive.body?.data?.users || []).every((u) => u.is_active !== false));
  const auClients = await call(env, S.sa, 'GET', `/api/admin/users?type=client&page=1&pageSize=100`);
  ok('type filter: only clients', (auClients.body?.data?.users || []).length > 0 && (auClients.body?.data?.users || []).every((u) => u.is_client));
  const usersOld = await call(env, S.sa, 'GET', '/api/admin/users?type=all');
  ok('without page: everyone, no pagination (as before)', (usersOld.body?.data?.users || []).length >= 25 && !usersOld.body?.meta);
  const auEmp = await call(env, S.emp1, 'GET', `/api/admin/users?type=all&page=1`);
  report.status('no permission: refused', auEmp, 403);

  report.start('Invitations (/api/invitations)');
  const { data: empRole } = await admin.from('roles').select('id').eq('name', 'Employee').single();
  await insert('user_invitations', Array.from({ length: 25 }, (_, i) => ({ email: `pgi.${RUN}.${pad(i)}@example.com`, name: `${TAG} invitee ${pad(i + 1)}`, role_id: empRole.id, invited_by: id.superadmin, token: `pg${RUN}${pad(i)}${'x'.repeat(30)}`, expires_at: future(7) + 'T00:00:00Z', status: i < 10 ? 'accepted' : 'pending', created_at: at(i) })), made.invitations);
  const iq = encodeURIComponent(TAG);
  const i1 = await call(env, S.sa, 'GET', `/api/invitations?q=${iq}&page=1&pageSize=20`);
  report.status('page 1 answers', i1, 200);
  ok('page 1: 20 invitations, total 25, newest first', (i1.body?.invitations || []).length === 20 && samePage(i1.body?.pagination, { page: 1, total: 25, totalPages: 2 }) && i1.body?.invitations?.[0]?.name === `${TAG} invitee 25`, describe(i1.body?.pagination));
  ok('rows keep role and inviter', (i1.body?.invitations || []).every((r) => r.roles?.name && r.inviter));
  const i2 = await call(env, S.sa, 'GET', `/api/invitations?q=${iq}&page=2&pageSize=20`);
  ok('last page: 5', (i2.body?.invitations || []).length === 5 && i2.body?.pagination?.hasNextPage === false);
  const iAcc = await call(env, S.sa, 'GET', `/api/invitations?q=${iq}&status=accepted&page=1`);
  ok('status filter: 10 accepted', iAcc.body?.pagination?.total === 10 && (iAcc.body?.invitations || []).every((r) => r.status === 'accepted'));
  const iMail = await call(env, S.sa, 'GET', `/api/invitations?q=${encodeURIComponent(`pgi.${RUN}.04`)}&page=1`);
  ok('search by email', (iMail.body?.invitations || []).length === 1);
  const iNone = await call(env, S.sa, 'GET', `/api/invitations?q=${encodeURIComponent('zz-no-match-zz')}&page=1`);
  ok('no matches: empty page, total 0', (iNone.body?.invitations || []).length === 0 && iNone.body?.pagination?.total === 0);
  const iOld = await call(env, S.sa, 'GET', '/api/invitations');
  ok('without page: every invitation, no pagination (as before)', (iOld.body?.invitations || []).filter((r) => r.name?.startsWith(TAG)).length === 25 && !iOld.body?.pagination);
  const iEmp = await call(env, S.emp2, 'GET', `/api/invitations?page=1`);
  ok('someone without invite rights: refused or sees none of these', iEmp.status === 403 || !(iEmp.body?.invitations || []).some((r) => r.name?.startsWith(TAG)));

  report.start('Client feedback (/api/accounts/[id]/client-feedback)');
  const fbRows = Array.from({ length: 25 }, (_, i) => ({ project_id: P, client_user_id: id.client, satisfaction_score: (i % 10) + 1, what_went_well: `${TAG} good ${pad(i + 1)}`, submitted_at: at(i) }));
  await insert('client_feedback', fbRows, made.feedback);
  const f1 = await call(env, S.sa, 'GET', `/api/accounts/${acme.id}/client-feedback?page=1&pageSize=20`);
  report.status('page 1 answers', f1, 200);
  ok('page 1: 20 entries and the pagination block', (f1.body?.feedback || []).length === 20 && f1.body?.pagination?.page === 1 && f1.body?.pagination?.total >= 25, describe(f1.body?.pagination));
  ok('newest first', (f1.body?.feedback || [])[0]?.what_went_well === `${TAG} good 25`);
  const wantAvg = Math.round((fbRows.reduce((a, r) => a + r.satisfaction_score, 0) / fbRows.length) * 10) / 10;
  const f2 = await call(env, S.sa, 'GET', `/api/accounts/${acme.id}/client-feedback?page=2&pageSize=20`);
  ok('page 2 holds the rest', (f2.body?.feedback || []).length === f1.body.pagination.total - 20);
  ok('stats cover all entries (count, per-score counts), not just the page', f1.body?.stats?.totalFeedback >= 25 && Object.values(f1.body.stats.feedbackByScore).reduce((a, b) => a + b, 0) === f1.body.stats.totalFeedback, JSON.stringify(f1.body?.stats));
  ok('stats identical on every page', JSON.stringify(f1.body?.stats) === JSON.stringify(f2.body?.stats));
  const fbOld = await call(env, S.sa, 'GET', `/api/accounts/${acme.id}/client-feedback`);
  ok('without page: every entry, no pagination, no stats (as before)', (fbOld.body?.feedback || []).length === f1.body.pagination.total && !fbOld.body?.pagination && !fbOld.body?.stats);
  const fEmp = await call(env, S.emp1, 'GET', `/api/accounts/${acme.id}/client-feedback?page=1`);
  report.status('no permission: refused', fEmp, 403);

  report.start('Accounts page data (/api/pages/accounts)');
  await insert('accounts', Array.from({ length: 25 }, (_, i) => ({ name: `${TAG} account ${pad(i + 1)}`, status: 'active', description: 'pagination' })), made.accounts);
  const ac1 = await call(env, S.sa, 'GET', `/api/pages/accounts?q=${uq}&page=1&pageSize=20`);
  const acData = (r) => r.body?.data || {};
  report.status('page 1 answers', ac1, 200);
  ok('page 1: 20 accounts, total 25, by name', (acData(ac1).accounts || []).length === 20 && samePage(acData(ac1).pagination, { page: 1, total: 25, totalPages: 2 }) && acData(ac1).accounts[0].name === `${TAG} account 01`, describe(acData(ac1).pagination));
  const ac2 = await call(env, S.sa, 'GET', `/api/pages/accounts?q=${uq}&page=2&pageSize=20`);
  ok('last page: 5, no overlap', (acData(ac2).accounts || []).length === 5);
  const acOne = await call(env, S.sa, 'GET', `/api/pages/accounts?q=${encodeURIComponent(`${TAG} account 12`)}&page=1`);
  ok('search finds one', (acData(acOne).accounts || []).length === 1);
  const acNone = await call(env, S.sa, 'GET', `/api/pages/accounts?q=zz-none-zz&page=1`);
  ok('no matches: empty, total 0', (acData(acNone).accounts || []).length === 0 && acData(acNone).pagination?.total === 0);
  const acOld = await call(env, S.sa, 'GET', `/api/pages/accounts`);
  ok('without page: every account, no pagination (as before)', (acData(acOld).accounts || []).length >= 25 && !acData(acOld).pagination);
  const acEmp = await call(env, S.emp2, 'GET', `/api/pages/accounts?q=${uq}&page=1`);
  ok('an employee without account access sees none of them', !((acData(acEmp).accounts || []).some((a) => a.name?.startsWith(TAG))));

  report.start('Task comments (cursor, whole threads)');
  const { data: task } = await admin.from('tasks').insert({ name: `${TAG} comment task`, project_id: P, created_by: id.pm, assigned_to: id.pm }).select('id').single();
  made.tasks.push(task.id);
  const tops = await insert('comments', Array.from({ length: 12 }, (_, i) => ({ project_id: P, task_id: task.id, content: `${TAG} top ${pad(i + 1)}`, created_by: id.pm, created_at: at(i * 10) })), made.comments);
  // Two replies on each of the three newest threads, written later than everything else
  await insert('comments', tops.slice(9).flatMap((t, k) => [1, 2].map((j) => ({ project_id: P, task_id: task.id, parent_id: t.id, content: `${TAG} reply ${k}-${j}`, created_by: id.pm, created_at: at(200 + k * 2 + j) }))), made.comments);
  const cFirst = await call(env, S.sa, 'GET', `/api/tasks/${task.id}/comments?limit=5`);
  const c1 = rows(cFirst);
  ok('first chunk: 5 newest threads with all their replies', c1.filter((c) => !c.parent_id).length === 5 && c1.filter((c) => c.parent_id).length === 6, `${c1.length} rows`);
  ok('every reply in a chunk has its thread in the same chunk', c1.filter((c) => c.parent_id).every((r) => c1.some((t) => t.id === r.parent_id)));
  ok('rows oldest first, ready to show', c1.every((c, i, a) => i === 0 || a[i - 1].created_at <= c.created_at));
  const cFeed = await follow(S.sa, `/api/tasks/${task.id}/comments`, rows, (r) => r.body?.meta || {});
  ok('following the feed: 12 threads and 6 replies, once each', !cFeed.error && cFeed.chunks.flat().length === 18 && new Set(cFeed.chunks.flat().map((c) => c.id)).size === 18, cFeed.error || `${cFeed.chunks.flat().length}`);
  const cOld = await call(env, S.sa, 'GET', `/api/tasks/${task.id}/comments`);
  ok('without limit: every comment (as before)', rows(cOld).length === 18 && !cOld.body?.meta);
}

async function cleanup() {
  report.start('Cleanup');
  const del = async (table, ids) => { if (ids.length) await admin.from(table).delete().in('id', ids); };
  await del('audit_log', made.audit);
  await del('client_feedback', made.feedback);
  await del('user_invitations', made.invitations);
  await del('project_files', made.files);
  await del('comments', made.comments);
  await del('project_updates', made.updates);
  await del('notifications', made.notifications);
  await del('time_entries', made.timeEntries);
  for (const uid of made.users || []) await admin.auth.admin.deleteUser(uid).catch(() => undefined);
  await del('accounts', made.accounts);
  await del('tasks', made.tasks);
  if (made.projects.length) await admin.from('project_assignments').delete().in('project_id', made.projects);
  await del('projects', made.projects);
  const { count } = await admin.from('projects').select('id', { count: 'exact', head: true }).like('name', `${TAG}%`);
  const { count: leftUsers } = await admin.from('user_profiles').select('id', { count: 'exact', head: true }).like('email', `pgu.${RUN}.%`);
  ok('all temporary rows removed', count === 0 && leftUsers === 0, `${count} projects, ${leftUsers} users left`);
}

try {
  await main();
} catch (e) {
  report.error('run', e);
} finally {
  await cleanup().catch((e) => report.error('cleanup', e));
}
process.exit(report.summary() ? 1 : 0);
