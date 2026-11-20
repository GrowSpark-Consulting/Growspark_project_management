// Suite: database rules (row-level security + triggers), exercised as real users.
// Part 1 = the 66 original checks (2026-11-19 audit). Part 2 = regression checks for the
// nine fixes G-1..G-6 and D-1..D-3. Every check runs on a fresh database built from the migrations.
import { createDatabase, sessions, denied, describe } from '../lib/harness.mjs';

export const name = 'Database rules (RLS + triggers)';

export async function run(report) {
  const { db, migrations, allApplied } = await createDatabase();
  if (!allApplied) {
    const bad = migrations.find((m) => !m.ok);
    report.record('SETUP', 'Migrations apply before rule checks', 'FAIL', bad ? `${bad.file}: ${bad.error}` : 'migrations incomplete');
    return;
  }
  const { q, tryQ, asUser, asAnon, asService } = sessions(db);
  const check = report.check.bind(report);
  const code = (r, c) => !r.ok && r.code === c;

  // ------------------------------------------------------------------ seed (owner: no JWT, no RLS)
  const U = {};
  for (const n of ['admin', 'pm', 'pm2', 'emp', 'emp2', 'outsider', 'viewer', 'client', 'client2']) {
    U[n] = (await q(`insert into auth.users (email) values ($1) returning id`, [`${n}@test.local`])).rows[0].id;
  }
  const acct = (await q(`insert into public.accounts (name) values ('Acme') returning id`)).rows[0];
  const acct2 = (await q(`insert into public.accounts (name) values ('Other Co') returning id`)).rows[0];
  // The on_auth_user_created trigger has already created each profile (as in Supabase); fill in the test fields
  for (const [n, id] of Object.entries(U)) {
    await q(`insert into public.user_profiles (id, email, name, is_superadmin, is_client, client_account_id) values ($1,$2,$3,$4,$5,$6)
             on conflict (id) do update set name = excluded.name, is_superadmin = excluded.is_superadmin, is_client = excluded.is_client, client_account_id = excluded.client_account_id`,
      [id, `${n}@test.local`, n, n === 'admin', n.startsWith('client'), n === 'client' ? acct.id : n === 'client2' ? acct2.id : null]);
  }
  const roleId = async (nm) => (await q(`select id from public.roles where name = $1 limit 1`, [nm])).rows[0]?.id;
  const R = { pm: await roleId('Project Manager'), emp: await roleId('Employee'), viewer: await roleId('Executive') };
  await check('SEED', 'Role templates seeded (Project Manager, Employee, Executive, Team Lead, Project Director)',
    async () => !!(R.pm && R.emp && R.viewer && (await roleId('Team Lead')) && (await roleId('Project Director'))));
  if (!R.pm || !R.emp || !R.viewer) return;
  for (const [u, r] of [['pm', 'pm'], ['pm2', 'pm'], ['emp', 'emp'], ['emp2', 'emp'], ['outsider', 'emp'], ['viewer', 'viewer']]) {
    await q(`insert into public.user_roles (user_id, role_id) values ($1,$2)`, [U[u], R[r]]);
  }
  const project = async (nm, extra = '') => (await q(`insert into public.projects (name, account_id, created_by${extra ? ', shared_with_client' : ''}) values ($1,$2,$3${extra ? ', true' : ''}) returning id`, [nm, acct.id, U.pm])).rows[0].id;
  const P = await project('Website', 'shared');
  const P2 = await project('Old project');
  const P3 = await project('Other');
  const P4 = await project('Workflow project');
  for (const pid of [P, P2, P4]) {
    for (const u of ['pm', 'emp', 'emp2']) await q(`insert into public.project_assignments (project_id, user_id, role_in_project) values ($1,$2,'member')`, [pid, U[u]]);
  }
  const upd = (await q(`insert into public.project_updates (project_id, content, created_by, client_visible) values ($1,'Internal note',$2,false) returning id`, [P, U.pm])).rows[0].id;
  const week = async (offsetDays) => {
    const d = (await q(`select public.get_week_start_date(current_date + $1::int) d`, [offsetDays])).rows[0].d;
    return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
  };
  const W0 = await week(0), W1 = await week(-7), W2 = await week(-14);

  // ================================================================== PART 1: original 66 checks
  await check('SEC-01', 'Anonymous role cannot read projects / notifications', async () => {
    const a = await asAnon(() => tryQ(`select count(*) from public.projects`));
    const b = await asAnon(() => tryQ(`select count(*) from public.notifications`));
    return { pass: !a.ok && !b.ok, info: `${describe(a)} / ${describe(b)}` };
  });
  await check('SEC-02', 'User cannot change own is_client / client_account_id', async () => {
    const r = await asUser(U.emp, () => tryQ(`update public.user_profiles set is_client = true, client_account_id = $1 where id = $2`, [acct.id, U.emp]));
    return { pass: code(r, '42501'), info: describe(r) };
  });
  await check('SEC-02b', 'User can still edit own name', async () => {
    const r = await asUser(U.emp, () => tryQ(`update public.user_profiles set name = 'Emp One' where id = $1`, [U.emp]));
    return { pass: r.ok && r.affected === 1, info: describe(r) };
  });
  await check('F-DEACT', 'Deactivated user cannot reactivate themselves (is_active is protected)', async () => {
    await q(`update public.user_profiles set is_active = false, deactivated_at = now() where id = $1`, [U.outsider]);
    const r = await asUser(U.outsider, () => tryQ(`update public.user_profiles set is_active = true, deactivated_at = null where id = $1`, [U.outsider]));
    await q(`update public.user_profiles set is_active = true, deactivated_at = null where id = $1`, [U.outsider]);
    return { pass: code(r, '42501'), info: describe(r) };
  });

  await q(`insert into public.tasks (name, project_id, created_by, assigned_to) values ('Seed task', $1, $2, $3)`, [P, U.pm, U.emp]);
  const count = async (uid, sql, params) => { const r = await asUser(uid, () => tryQ(sql, params)); return r.ok ? r.rows[0].n : `error ${r.code}`; };
  await check('SEC-06a', 'Client reads 0 tasks directly', async () => { const n = await count(U.client, `select count(*)::int n from public.tasks`); return { pass: n === 0, info: `${n}` }; });
  await check('SEC-06b', 'Client reads 0 project updates directly (incl. internal)', async () => { const n = await count(U.client, `select count(*)::int n from public.project_updates`); return { pass: n === 0, info: `${n}` }; });
  await check('SEC-06c', 'Client sees only own profile (no staff directory)', async () => { const n = await count(U.client, `select count(*)::int n from public.user_profiles`); return { pass: n === 1, info: `${n}` }; });
  await check('SEC-06d', 'Client direct project read is 0 (portal reads via server)', async () => { const n = await count(U.client, `select count(*)::int n from public.projects`); return { pass: n === 0, info: `${n}` }; });

  // Task created by emp, assigned to emp (emp is creator and assignee)
  let T = null;
  await check('K1', 'Project member can create a task', async () => {
    const r = await asUser(U.emp, () => tryQ(`insert into public.tasks (name, project_id, created_by, assigned_to, status) values ('Homepage', $1, $2, $2, 'done') returning id, status`, [P, U.emp]));
    T = r.rows[0]?.id || null;
    return { pass: r.ok, info: describe(r) };
  });
  if (!T) { report.record('K-series', 'Remaining task checks', 'FAIL', 'skipped: task creation failed'); return; }
  await check('K3-ins', 'Member cannot create a task directly as Done (coerced to To Do)', async () => {
    const s = (await q(`select status from public.tasks where id = $1`, [T])).rows[0].status;
    return { pass: s === 'todo', info: s };
  });
  await check('K1-perm', 'Non-member cannot create a task in the project', async () => {
    const r = await asUser(U.outsider, () => tryQ(`insert into public.tasks (name, project_id, created_by) values ('x', $1, $2)`, [P, U.outsider]));
    return { pass: !r.ok, info: describe(r) };
  });
  await check('SEC-08', 'view_all_projects (read-only) cannot edit tasks', async () => {
    const r = await asUser(U.viewer, () => tryQ(`update public.tasks set name = 'hacked' where project_id = $1`, [P]));
    return { pass: denied(r), info: describe(r) };
  });
  await check('SEC-08b', 'view_all_projects can still read tasks', async () => {
    const n = await count(U.viewer, `select count(*)::int n from public.tasks where project_id = $1`, [P]);
    return { pass: typeof n === 'number' && n >= 1, info: `${n}` };
  });

  const setStatus = (uid, status, note = null) =>
    asUser(uid, () => tryQ(`update public.tasks set status = $1, review_note = coalesce($2, review_note) where id = $3 returning status, started_at, completed_at, progress_percent`, [status, note, T]));
  await check('K2-start', 'Assignee can start (In Progress); started_at set', async () => { const r = await setStatus(U.emp, 'in_progress'); return { pass: r.ok && r.affected === 1 && !!r.rows[0].started_at, info: describe(r) }; });
  await check('K2-pause', 'Assignee can pause (On Hold)', async () => { const r = await setStatus(U.emp, 'on_hold'); return { pass: r.ok && r.affected === 1, info: describe(r) }; });
  await check('K2-resume', 'Assignee can resume', async () => { const r = await setStatus(U.emp, 'in_progress'); return { pass: r.ok && r.affected === 1, info: describe(r) }; });
  await check('K2-progress', 'Assignee can update progress %', async () => {
    const r = await asUser(U.emp, () => tryQ(`update public.tasks set progress_percent = 60 where id = $1`, [T]));
    return { pass: r.ok && r.affected === 1, info: describe(r) };
  });
  await check('K4-submit', 'Assignee can submit for review', async () => { const r = await setStatus(U.emp, 'review'); return { pass: r.ok && r.affected === 1, info: describe(r) }; });
  await check('K4-selfapprove', 'Assignee cannot approve own task (Done)', async () => { const r = await setStatus(U.emp, 'done'); return { pass: code(r, '42501'), info: describe(r) }; });
  await q(`update public.tasks set reviewer_id = $1 where id = $2`, [U.emp2, T]); // set by the server / a manager
  await check('K4-note', 'Requesting changes requires a note', async () => { const r = await setStatus(U.emp2, 'changes_requested'); return { pass: code(r, '23514'), info: describe(r) }; });
  await check('K4-changes', 'Reviewer can request changes', async () => { const r = await setStatus(U.emp2, 'changes_requested', 'Fix the header'); return { pass: r.ok && r.affected === 1, info: describe(r) }; });
  await check('K4-resubmit', 'Assignee can resubmit', async () => { await setStatus(U.emp, 'in_progress'); const r = await setStatus(U.emp, 'review'); return { pass: r.ok && r.affected === 1, info: describe(r) }; });
  await check('K4-approve', 'Reviewer can approve; completed_at + 100%', async () => {
    const r = await setStatus(U.emp2, 'done');
    return { pass: r.ok && !!r.rows[0]?.completed_at && r.rows[0]?.progress_percent === 100, info: describe(r) };
  });
  await check('K4-reopen-deny', 'Assignee cannot reopen a Done task', async () => { const r = await setStatus(U.emp, 'in_progress'); return { pass: code(r, '42501'), info: describe(r) }; });
  await check('K4-reopen-pm', 'Project manager can reopen', async () => { const r = await setStatus(U.pm, 'in_progress'); return { pass: r.ok && r.affected === 1, info: describe(r) }; });
  await check('K4-history', 'Review history recorded and readable by the team', async () => {
    const h = await asUser(U.emp, () => tryQ(`select action from public.task_activity where task_id = $1 order by created_at, id`, [T]));
    const actions = h.rows.map((x) => x.action);
    const need = ['created', 'status_changed', 'progress_updated', 'review_submitted', 'changes_requested', 'review_approved', 'reopened'];
    return { pass: h.ok && need.every((a) => actions.includes(a)), info: actions.join(',') };
  });
  await check('K4-history-client', 'Client cannot read task history', async () => { const n = await count(U.client, `select count(*)::int n from public.task_activity`); return { pass: n === 0, info: `${n}` }; });

  await check('K4-bypass', 'Member cannot self-approve by reassigning the task and naming themselves reviewer (G-1)', async () => {
    const t2 = (await q(`insert into public.tasks (name, project_id, created_by, assigned_to, status) values ('Bypass', $1, $2, $2, 'review') returning id`, [P, U.emp])).rows[0].id;
    const s1 = await asUser(U.emp, () => tryQ(`update public.tasks set assigned_to = $1, reviewer_id = $2 where id = $3`, [U.emp2, U.emp, t2]));
    const s2 = await asUser(U.emp, () => tryQ(`update public.tasks set status = 'done' where id = $1`, [t2]));
    const done = (await q(`select status from public.tasks where id = $1`, [t2])).rows[0].status === 'done';
    return { pass: !done && !(s1.ok && s1.affected === 1 && s2.ok && s2.affected === 1), info: `step1: ${describe(s1)}; step2: ${describe(s2)}` };
  });

  await check('2C-sub', 'Member can create a subtask', async () => {
    const r = await asUser(U.emp, () => tryQ(`insert into public.tasks (name, project_id, created_by, parent_task_id) values ('Sub', $1, $2, $3) returning id`, [P, U.emp, T]));
    if (r.ok) {
      const ss = await asUser(U.emp, () => tryQ(`insert into public.tasks (name, project_id, created_by, parent_task_id) values ('SubSub', $1, $2, $3)`, [P, U.emp, r.rows[0].id]));
      report.record('2C-sub-depth', 'Sub-subtasks rejected (one level)', code(ss, '23514') ? 'PASS' : 'FAIL', describe(ss));
    }
    return { pass: r.ok, info: describe(r) };
  });
  await check('2C-sub-cross', 'Subtask parent must be in same project', async () => {
    const t3 = (await q(`insert into public.tasks (name, project_id, created_by) values ('Other proj task', $1, $2) returning id`, [P3, U.pm])).rows[0].id;
    const r = await tryQ(`insert into public.tasks (name, project_id, created_by, parent_task_id) values ('Cross', $1, $2, $3)`, [P, U.pm, t3]);
    return { pass: !r.ok, info: describe(r) };
  });

  const mkTask = async (nm, pid = P, extra = {}) => (await q(`insert into public.tasks (name, project_id, created_by, assigned_to) values ($1, $2, $3, $4) returning id`, [nm, pid, extra.created_by || U.pm, extra.assigned_to || null])).rows[0].id;
  const dep = (a, b, uid = U.emp) => asUser(uid, () => tryQ(`insert into public.task_dependencies (task_id, depends_on_task_id) values ($1,$2)`, [a, b]));
  const A = await mkTask('A'), B = await mkTask('B'), C = await mkTask('C');
  await check('2C-dep-self', 'Task cannot depend on itself', async () => { const r = await dep(A, A); return { pass: !r.ok, info: describe(r) }; });
  await check('2C-dep', 'Member can add a dependency', async () => { const r = await dep(A, B); return { pass: r.ok, info: describe(r) }; });
  await check('2C-dep-2cycle', 'Direct cycle rejected', async () => { const r = await dep(B, A); return { pass: !r.ok, info: describe(r) }; });
  await check('2C-dep-3cycle', 'Longer cycle (A→B→C→A) rejected (G-2)', async () => {
    const bc = await dep(B, C); const ca = await dep(C, A);
    return { pass: bc.ok && !ca.ok && ca.code === '23514', info: `B→C ${describe(bc)}; C→A ${describe(ca)}` };
  });

  await check('6F-own', 'Employee can log own time', async () => {
    const r = await asUser(U.emp, () => tryQ(`insert into public.time_entries (user_id, project_id, task_id, hours_logged, entry_date, week_start_date) values ($1,$2,$3,2,current_date,$4)`, [U.emp, P, T, W0]));
    return { pass: r.ok, info: describe(r) };
  });
  await check('SEC-07', 'Employee cannot write time for someone else', async () => {
    const r = await asUser(U.emp, () => tryQ(`insert into public.time_entries (user_id, project_id, hours_logged, entry_date, week_start_date) values ($1,$2,2,current_date,$3)`, [U.emp2, P, W0]));
    return { pass: !r.ok, info: describe(r) };
  });
  let TS = null;
  await check('3G-submit', 'Employee can submit own timesheet', async () => {
    const r = await asUser(U.emp, () => tryQ(`insert into public.timesheets (user_id, week_start_date, status, submitted_at, total_hours) values ($1,$2,'submitted',now(),2) returning id`, [U.emp, W0]));
    TS = r.rows[0]?.id || null;
    return { pass: r.ok, info: describe(r) };
  });
  await check('3G-lock', 'Submitted week is locked for new time entries', async () => {
    const r = await asUser(U.emp, () => tryQ(`insert into public.time_entries (user_id, project_id, hours_logged, entry_date, week_start_date) values ($1,$2,1,current_date,$3)`, [U.emp, P, W0]));
    return { pass: code(r, '55006'), info: describe(r) };
  });
  await check('3G-selfapprove', 'Employee cannot approve own timesheet (G-3)', async () => {
    const r = await asUser(U.emp, () => tryQ(`update public.timesheets set status = 'approved' where id = $1`, [TS]));
    const s = (await q(`select status from public.timesheets where id = $1`, [TS])).rows[0]?.status;
    return { pass: denied(r) && s === 'submitted', info: `${describe(r)}; status now ${s}` };
  });
  await check('3G-selfunlock', 'Employee cannot reopen own submitted timesheet to edit hours (G-3)', async () => {
    const r = await asUser(U.emp, () => tryQ(`update public.timesheets set status = 'draft' where id = $1`, [TS]));
    const s = (await q(`select status from public.timesheets where id = $1`, [TS])).rows[0]?.status;
    return { pass: denied(r) && s === 'submitted', info: `${describe(r)}; status now ${s}` };
  });
  await check('2G-review', 'Project manager (approve_timesheets) can see team member timesheet', async () => {
    const n = await count(U.pm, `select count(*)::int n from public.timesheets where id = $1`, [TS]);
    return { pass: n === 1, info: `${n}` };
  });
  await check('2G-approve', 'Project manager can approve the timesheet', async () => {
    const r = await asUser(U.pm, () => tryQ(`update public.timesheets set status = 'approved', reviewed_by = $1, reviewed_at = now() where id = $2`, [U.pm, TS]));
    return { pass: r.ok && r.affected === 1, info: describe(r) };
  });
  await check('2G-scope', "Unrelated employee cannot see others' timesheets", async () => {
    const n = await count(U.outsider, `select count(*)::int n from public.timesheets`);
    return { pass: n === 0, info: `${n}` };
  });

  const tpl = (await q(`insert into public.workflow_templates (name, created_by) values ('Delivery', $1) returning id`, [U.pm])).rows[0].id;
  const node = (await q(`insert into public.workflow_nodes (workflow_template_id, node_type, label, settings) values ($1,'approval','Client Review','{"client_approval":true}') returning id`, [tpl])).rows[0].id;
  const wi = (await q(`insert into public.workflow_instances (workflow_template_id, project_id, current_node_id, status) values ($1,$2,$3,'active') returning id`, [tpl, P, node])).rows[0].id;
  await check('SEC-10', "Cannot record an approval in someone else's name", async () => {
    const r = await asUser(U.emp, () => tryQ(`insert into public.workflow_approvals (workflow_instance_id, node_id, approver_user_id, decision) values ($1,$2,$3,'approved')`, [wi, node, U.emp2]));
    return { pass: !r.ok, info: describe(r) };
  });
  // The app starts workflows with insert ... returning, so the new row must pass the SELECT policy too
  for (const [id, who, label] of [['WF-start-pm', 'pm', 'Project manager'], ['WF-start-member', 'emp', 'Team member']]) {
    await check(id, `${label} can start a workflow on their project (insert ... returning)`, async () => {
      const r = await asUser(U[who], () => tryQ(`insert into public.workflow_instances (workflow_template_id, project_id, current_node_id, status) values ($1,$2,$3,'active') returning id`, [tpl, P, node]));
      if (r.ok) await q(`delete from public.workflow_instances where id = $1`, [r.rows[0].id]);
      return { pass: r.ok && r.rows.length === 1, info: describe(r) };
    });
  }
  await check('WF-start-outsider', 'Someone not on the project cannot start a workflow on it', async () => {
    const r = await asUser(U.outsider, () => tryQ(`insert into public.workflow_instances (workflow_template_id, project_id, current_node_id, status) values ($1,$2,$3,'active') returning id`, [tpl, P, node]));
    return { pass: !r.ok, info: describe(r) };
  });
  await check('WF-view-scope', 'Workflow instances stay hidden from people outside the project', async () => {
    const n = await count(U.outsider, `select count(*)::int n from public.workflow_instances`);
    const m = await count(U.emp, `select count(*)::int n from public.workflow_instances where id = '${wi}'`);
    return { pass: n === 0 && m === 1, info: `outsider sees ${n}, member sees ${m}` };
  });

  await check('SEC-03', 'Client cannot update workflow instances directly', async () => {
    const r = await asUser(U.client, () => tryQ(`update public.workflow_instances set status = 'completed' where id = $1`, [wi]));
    return { pass: denied(r), info: describe(r) };
  });

  let C1 = null, R1 = null;
  await check('K5-comment', 'Member can comment on a task (project derived by trigger)', async () => {
    const r = await asUser(U.emp, () => tryQ(`insert into public.comments (task_id, content, created_by, mentions) values ($1,'Looks good',$2,$3) returning id, project_id`, [T, U.emp, [U.emp2]]));
    C1 = r.rows[0]?.id || null;
    return { pass: r.ok && r.rows[0].project_id === P, info: describe(r) };
  });
  await check('K5-reply', 'Member can reply', async () => {
    const r = await asUser(U.emp2, () => tryQ(`insert into public.comments (task_id, parent_id, content, created_by) values ($1,$2,'Thanks',$3) returning id`, [T, C1, U.emp2]));
    R1 = r.rows[0]?.id || null;
    return { pass: r.ok, info: describe(r) };
  });
  await check('K5-depth', 'Reply to a reply rejected (one level)', async () => {
    const r = await asUser(U.emp, () => tryQ(`insert into public.comments (task_id, parent_id, content, created_by) values ($1,$2,'nested',$3)`, [T, R1, U.emp]));
    return { pass: !r.ok, info: describe(r) };
  });
  await check('SEC-04', 'Cannot post a comment as another user', async () => {
    const r = await asUser(U.emp, () => tryQ(`insert into public.comments (task_id, content, created_by) values ($1,'spoof',$2)`, [T, U.emp2]));
    return { pass: !r.ok, info: describe(r) };
  });
  await check('K5-perm', 'Non-member cannot comment', async () => {
    const r = await asUser(U.outsider, () => tryQ(`insert into public.comments (task_id, content, created_by) values ($1,'hi',$2)`, [T, U.outsider]));
    return { pass: !r.ok, info: describe(r) };
  });
  await check('K5-client', 'Client cannot read task comments directly', async () => { const n = await count(U.client, `select count(*)::int n from public.comments`); return { pass: n === 0, info: `${n}` }; });
  await check('5E-updcomment', 'Member can comment on a project update', async () => {
    const r = await asUser(U.emp, () => tryQ(`insert into public.comments (update_id, content, created_by) values ($1,'On update',$2)`, [upd, U.emp]));
    return { pass: r.ok, info: describe(r) };
  });

  await check('2I-share-db', 'Employee cannot share an update with the client directly in the database (G-4)', async () => {
    const r = await asUser(U.emp, () => tryQ(`insert into public.project_updates (project_id, content, created_by, client_visible) values ($1,'shared by employee',$2,true)`, [P, U.emp]));
    return { pass: code(r, '42501'), info: describe(r) };
  });
  await check('4D-status-db', 'Employee cannot create a deliverable already Approved / sent to client (G-5)', async () => {
    const r = await asUser(U.emp, () => tryQ(`insert into public.deliverables (project_id, name, status, submitted_by) values ($1,'Logo','approved',$2)`, [P, U.emp]));
    return { pass: code(r, '42501'), info: describe(r) };
  });
  const fileP = (await q(`insert into public.project_files (project_id, file_name, storage_path, size_bytes, uploaded_by) values ($1::uuid,'spec.pdf',$1::text || '/f1/spec.pdf',100,$2) returning id`, [P, U.emp])).rows[0].id;
  await check('4E-share-db', 'Employee cannot share own file with the client directly in the database (G-5)', async () => {
    const r = await asUser(U.emp, () => tryQ(`update public.project_files set client_visible = true where id = $1`, [fileP]));
    return { pass: denied(r), info: describe(r) };
  });

  await check('2E-ms-emp', 'Employee cannot create project milestones', async () => {
    const r = await asUser(U.emp, () => tryQ(`insert into public.milestones (name, date, project_id) values ('Launch', current_date, $1)`, [P]));
    return { pass: !r.ok, info: describe(r) };
  });
  await check('2E-ms-pm', 'Project manager can create project milestones', async () => {
    const r = await asUser(U.pm, () => tryQ(`insert into public.milestones (name, date, project_id) values ('Launch', current_date, $1)`, [P]));
    return { pass: r.ok, info: describe(r) };
  });
  await check('2E-tpl-emp', 'Employee cannot create project templates', async () => {
    const r = await asUser(U.emp, () => tryQ(`insert into public.project_templates (name, created_by) values ('T', $1)`, [U.emp]));
    return { pass: !r.ok, info: describe(r) };
  });
  await check('2E-tpl-pm', 'Project manager can create project templates', async () => {
    const r = await asUser(U.pm, () => tryQ(`insert into public.project_templates (name, created_by) values ('T', $1)`, [U.pm]));
    return { pass: r.ok, info: describe(r) };
  });
  await check('1-settings-emp', 'Employee cannot change company settings', async () => {
    const r = await asUser(U.emp, () => tryQ(`update public.app_settings set company_name = 'x'`));
    return { pass: denied(r), info: describe(r) };
  });
  await check('1-settings-admin', 'Superadmin can change company settings', async () => {
    const r = await asUser(U.admin, () => tryQ(`update public.app_settings set company_name = 'Acme Studio'`));
    return { pass: r.ok && r.affected === 1, info: describe(r) };
  });
  await check('6-notify-forge', 'Users cannot create notifications for others', async () => {
    const r = await asUser(U.emp, () => tryQ(`insert into public.notifications (user_id, title, message, type) values ($1,'x','y','info')`, [U.emp2]));
    return { pass: !r.ok, info: describe(r) };
  });
  await q(`update public.projects set archived_at = now() where id = $1`, [P2]);
  await check('2B-archive', 'Archived project is read-only (no new tasks)', async () => {
    const r = await asUser(U.emp, () => tryQ(`insert into public.tasks (name, project_id, created_by) values ('late', $1, $2)`, [P2, U.emp]));
    return { pass: !r.ok, info: describe(r) };
  });
  await check('2B-archive-read', 'Archived project still readable by its team', async () => {
    const n = await count(U.emp, `select count(*)::int n from public.projects where id = $1`, [P2]);
    return { pass: n === 1, info: `${n}` };
  });

  // ================================================================== PART 2: regression checks for the nine fixes
  // ---- G-1 task fields, assignee, reviewer
  const TG = await mkTask('Created by emp', P, { created_by: U.emp, assigned_to: U.emp });
  const TX = await mkTask('Created by pm', P, { created_by: U.pm, assigned_to: U.emp2 });
  const TU = await mkTask('Unassigned', P, { created_by: U.pm });
  const TU2 = await mkTask('Unassigned 2', P, { created_by: U.pm });
  const asEmp = (sql, params) => asUser(U.emp, () => tryQ(sql, params));
  await check('G1-details-deny', 'Non-creator member cannot change title / priority / deadline', async () => {
    const r = await asEmp(`update public.tasks set name = 'renamed', priority = 'urgent', due_date = current_date where id = $1`, [TX]);
    return { pass: code(r, '42501'), info: describe(r) };
  });
  await check('G1-details-creator', 'Creator can change their own task details', async () => {
    const r = await asEmp(`update public.tasks set name = 'Renamed by creator', priority = 'high', due_date = current_date + 3 where id = $1`, [TG]);
    return { pass: r.ok && r.affected === 1, info: describe(r) };
  });
  await check('G1-description', 'Any member can still edit the description (same as the API)', async () => {
    const r = await asEmp(`update public.tasks set description = 'notes' where id = $1`, [TX]);
    return { pass: r.ok && r.affected === 1, info: describe(r) };
  });
  await check('G1-assignee-work', 'Assignee who did not create the task can still start it and update progress', async () => {
    const r = await asUser(U.emp2, () => tryQ(`update public.tasks set status = 'in_progress', progress_percent = 30 where id = $1`, [TX]));
    return { pass: r.ok && r.affected === 1, info: describe(r) };
  });
  await check('G1-reassign-deny', "Non-creator member cannot reassign someone else's task", async () => {
    const r = await asEmp(`update public.tasks set assigned_to = $1 where id = $2`, [U.emp, TX]);
    return { pass: code(r, '42501'), info: describe(r) };
  });
  await check('G1-selfassign', 'Member can take an unassigned task (self-assign)', async () => {
    const r = await asEmp(`update public.tasks set assigned_to = $1 where id = $2`, [U.emp, TU]);
    return { pass: r.ok && r.affected === 1, info: describe(r) };
  });
  await check('G1-assign-other-deny', 'Non-creator member cannot assign an unassigned task to someone else', async () => {
    const r = await asEmp(`update public.tasks set assigned_to = $1 where id = $2`, [U.emp2, TU2]);
    return { pass: code(r, '42501'), info: describe(r) };
  });
  await check('G1-reviewer-deny', 'Creator who is not a manager cannot choose the reviewer', async () => {
    const r = await asEmp(`update public.tasks set reviewer_id = $1 where id = $2`, [U.emp2, TG]);
    return { pass: code(r, '42501'), info: describe(r) };
  });
  await check('G1-reviewer-insert-deny', 'Non-manager cannot set a reviewer when creating a task', async () => {
    const r = await asEmp(`insert into public.tasks (name, project_id, created_by, assigned_to, reviewer_id) values ('x', $1, $2, $2, $3)`, [P, U.emp, U.emp2]);
    return { pass: code(r, '42501'), info: describe(r) };
  });
  await check('G1-reviewer-pm', 'Project manager can choose the reviewer', async () => {
    const r = await asUser(U.pm, () => tryQ(`update public.tasks set reviewer_id = $1 where id = $2`, [U.emp2, TG]));
    return { pass: r.ok && r.affected === 1, info: describe(r) };
  });
  await check('G1-reviewer-not-assignee', 'Reviewer cannot be the assignee (even when a manager sets it)', async () => {
    const r = await asUser(U.pm, () => tryQ(`update public.tasks set reviewer_id = $1 where id = $2`, [U.emp2, TX]));
    return { pass: code(r, '23514'), info: describe(r) };
  });
  await check('G1-creator-locked', 'Task creator cannot be changed (no taking over creator rights)', async () => {
    const r = await asEmp(`update public.tasks set created_by = $1 where id = $2`, [U.emp, TX]);
    return { pass: code(r, '42501'), info: describe(r) };
  });
  await check('G1-creator-coerced', 'On insert, the creator is always the caller (spoofed creator ignored)', async () => {
    const r = await asEmp(`insert into public.tasks (name, project_id, created_by) values ('spoof', $1, $2) returning created_by`, [P, U.emp2]);
    return { pass: r.ok && r.rows[0].created_by === U.emp, info: r.ok ? `created_by = ${r.rows[0].created_by === U.emp ? 'caller' : 'spoofed user'}` : describe(r) };
  });
  await check('G1-assignee-member', 'Cannot assign a task to a non-member or a client (SEC-09, database part)', async () => {
    const a = await asEmp(`insert into public.tasks (name, project_id, created_by, assigned_to) values ('o', $1, $2, $3)`, [P, U.emp, U.outsider]);
    const b = await asEmp(`insert into public.tasks (name, project_id, created_by, assigned_to) values ('c', $1, $2, $3)`, [P, U.emp, U.client]);
    const c = await asUser(U.pm, () => tryQ(`update public.tasks set assigned_to = $1 where id = $2`, [U.outsider, TX]));
    return { pass: code(a, '23514') && code(b, '23514') && code(c, '23514'), info: `outsider: ${describe(a)}; client: ${describe(b)}; pm→outsider: ${describe(c)}` };
  });
  await check('G1-move-deny', 'Non-manager cannot move a task to another project', async () => {
    const r = await asEmp(`update public.tasks set project_id = $1 where id = $2`, [P3, TG]);
    return { pass: !r.ok, info: describe(r) };
  });
  await check('G1-manager-ok', 'Project manager can still edit details and reassign', async () => {
    const r = await asUser(U.pm, () => tryQ(`update public.tasks set name = 'PM edit', priority = 'low', assigned_to = $1 where id = $2`, [U.emp, TX]));
    return { pass: r.ok && r.affected === 1, info: describe(r) };
  });

  // ---- G-2 dependency cycles
  await check('G2-4cycle', 'Cycle of four tasks rejected', async () => {
    const [a, b, c, d] = [await mkTask('W'), await mkTask('X'), await mkTask('Y'), await mkTask('Z')];
    const steps = [await dep(a, b), await dep(b, c), await dep(c, d)];
    const close = await dep(d, a);
    return { pass: steps.every((s) => s.ok) && code(close, '23514'), info: `chain ${steps.map((s) => (s.ok ? 'ok' : s.code)).join('/')}; closing edge ${describe(close)}` };
  });
  await check('G2-diamond', 'Non-cyclic shared dependencies are still allowed (A→B, A→C, B→D, C→D)', async () => {
    const [a, b, c, d] = [await mkTask('DA'), await mkTask('DB'), await mkTask('DC'), await mkTask('DD')];
    const rs = [await dep(a, b), await dep(a, c), await dep(b, d), await dep(c, d)];
    return { pass: rs.every((r) => r.ok), info: rs.map(describe).join('; ') };
  });

  // ---- G-3 timesheets
  await q(`insert into public.time_entries (user_id, project_id, hours_logged, entry_date, week_start_date) values ($1,$2,3,$3::date,$3::date)`, [U.emp2, P, W1]);
  const asEmp2 = (sql, params) => asUser(U.emp2, () => tryQ(sql, params));
  await check('G3-insert-approved', 'Employee cannot create a timesheet that is already approved', async () => {
    const r = await asEmp2(`insert into public.timesheets (user_id, week_start_date, status, total_hours) values ($1,$2,'approved',3)`, [U.emp2, W1]);
    return { pass: code(r, '42501'), info: describe(r) };
  });
  await check('G3-insert-reviewfields', 'Employee cannot fill in review fields', async () => {
    const r = await asEmp2(`insert into public.timesheets (user_id, week_start_date, status, total_hours, review_note) values ($1,$2,'submitted',3,'looks fine')`, [U.emp2, W1]);
    return { pass: code(r, '42501'), info: describe(r) };
  });
  let TS2 = null;
  await check('G3-submit', 'Employee can submit a clean timesheet', async () => {
    const r = await asEmp2(`insert into public.timesheets (user_id, week_start_date, status, total_hours) values ($1,$2,'submitted',3) returning id, submitted_at`, [U.emp2, W1]);
    TS2 = r.rows[0]?.id || null;
    return { pass: r.ok && !!r.rows[0].submitted_at, info: describe(r) };
  });
  await check('G3-hours-locked', 'Employee cannot change hours on a submitted timesheet', async () => {
    const r = await asEmp2(`update public.timesheets set total_hours = 40 where id = $1`, [TS2]);
    return { pass: code(r, '55006'), info: describe(r) };
  });
  await check('G3-approver-hours', 'Approver cannot change the submitted hours', async () => {
    const r = await asUser(U.pm, () => tryQ(`update public.timesheets set total_hours = 1 where id = $1`, [TS2]));
    return { pass: code(r, '42501'), info: describe(r) };
  });
  await check('G3-reject', 'Approver can reject with a note', async () => {
    const r = await asUser(U.pm, () => tryQ(`update public.timesheets set status = 'rejected', review_note = 'Missing Friday' where id = $1`, [TS2]));
    return { pass: r.ok && r.affected === 1, info: describe(r) };
  });
  await check('G3-resubmit', 'Employee can resubmit a rejected timesheet', async () => {
    const r = await asEmp2(`update public.timesheets set status = 'submitted' where id = $1`, [TS2]);
    return { pass: r.ok && r.affected === 1, info: describe(r) };
  });
  await check('G3-reviewer-recorded', 'Approval always records the real approver (spoofed reviewed_by ignored)', async () => {
    const r = await asUser(U.pm, () => tryQ(`update public.timesheets set status = 'approved', reviewed_by = $1 where id = $2 returning reviewed_by`, [U.emp, TS2]));
    return { pass: r.ok && r.rows[0]?.reviewed_by === U.pm, info: r.ok ? `reviewed_by = ${r.rows[0]?.reviewed_by === U.pm ? 'approver' : 'spoofed user'}` : describe(r) };
  });
  await check('G3-draft-not-approvable', 'A draft timesheet cannot be approved (must be submitted first)', async () => {
    await q(`insert into public.time_entries (user_id, project_id, hours_logged, entry_date, week_start_date) values ($1,$2,2,$3::date,$3::date)`, [U.emp2, P, W2]);
    const d = (await asEmp2(`insert into public.timesheets (user_id, week_start_date, status, total_hours) values ($1,$2,'draft',2) returning id`, [U.emp2, W2])).rows[0]?.id;
    const r = await asUser(U.pm, () => tryQ(`update public.timesheets set status = 'approved' where id = $1`, [d]));
    return { pass: code(r, '23514'), info: describe(r) };
  });
  await check('G3-other-pm', 'A project manager from another project cannot approve', async () => {
    const r = await asUser(U.pm2, () => tryQ(`update public.timesheets set status = 'rejected', review_note = 'x' where id = $1`, [TS2]));
    return { pass: denied(r), info: describe(r) };
  });

  // ---- G-4 client visibility of updates / issues
  await check('G4-internal-ok', 'Employee can still post an internal update', async () => {
    const r = await asEmp(`insert into public.project_updates (project_id, content, created_by) values ($1,'internal',$2) returning id`, [P, U.emp]);
    if (r.ok) {
      const flip = await asEmp(`update public.project_updates set client_visible = true where id = $1`, [r.rows[0].id]);
      report.record('G4-flip-deny', 'Employee cannot later switch their own update to client-visible', code(flip, '42501') ? 'PASS' : 'FAIL', describe(flip));
    }
    return { pass: r.ok, info: describe(r) };
  });
  await check('G4-pm-share', 'Project manager can share an update with the client', async () => {
    const r = await asUser(U.pm, () => tryQ(`update public.project_updates set client_visible = true where id = $1`, [upd]));
    return { pass: r.ok && r.affected === 1, info: describe(r) };
  });
  await check('G4-issue-deny', 'Employee cannot make an issue visible to the client', async () => {
    const r = await asEmp(`insert into public.project_issues (project_id, content, created_by, client_visible) values ($1,'bug',$2,true)`, [P, U.emp]);
    return { pass: code(r, '42501'), info: describe(r) };
  });
  await check('G4-issue-internal', 'Employee can still report an internal issue', async () => {
    const r = await asEmp(`insert into public.project_issues (project_id, content, created_by) values ($1,'bug',$2)`, [P, U.emp]);
    return { pass: r.ok, info: describe(r) };
  });

  // ---- G-5 deliverables and project files
  await check('G5-draft-ok', 'Employee can create a draft deliverable; submitter is always the caller', async () => {
    const r = await asEmp(`insert into public.deliverables (project_id, name, status, submitted_by) values ($1,'Draft logo','draft',$2) returning id, submitted_by`, [P, U.emp2]);
    if (r.ok) {
      const up = await asEmp(`update public.deliverables set status = 'client_review' where id = $1`, [r.rows[0].id]);
      report.record('G5-update-deny', 'Employee cannot move a deliverable to client review / approved', denied(up) ? 'PASS' : 'FAIL', describe(up));
    }
    return { pass: r.ok && r.rows[0].submitted_by === U.emp, info: r.ok ? `submitted_by = ${r.rows[0].submitted_by === U.emp ? 'caller' : 'spoofed user'}` : describe(r) };
  });
  await check('G5-submitter-flow', 'Submitter can edit a draft and submit it for review; cannot record approval; cannot delete once submitted', async () => {
    const id = (await asEmp(`insert into public.deliverables (project_id, name, status) values ($1,'Banner','draft') returning id`, [P])).rows[0]?.id;
    const edit = await asEmp(`update public.deliverables set name = 'Banner v2' where id = $1`, [id]);
    const approve = await asEmp(`update public.deliverables set approved_by = $1, approved_at = now() where id = $2`, [U.emp, id]);
    const submit = await asEmp(`update public.deliverables set status = 'pending_review', submitted_at = now() where id = $1`, [id]);
    const del = await asEmp(`delete from public.deliverables where id = $1`, [id]);
    const still = (await q(`select status from public.deliverables where id = $1`, [id])).rows[0]?.status;
    return {
      pass: edit.ok && edit.affected === 1 && code(approve, '42501') && submit.ok && submit.affected === 1 && denied(del) && still === 'pending_review',
      info: `edit: ${describe(edit)}; approve: ${describe(approve)}; submit: ${describe(submit)}; delete: ${describe(del)}; status ${still}`,
    };
  });
  await check('G5-draft-delete', 'Submitter can delete their own draft', async () => {
    const id = (await asEmp(`insert into public.deliverables (project_id, name, status) values ($1,'Throwaway','draft') returning id`, [P])).rows[0]?.id;
    const r = await asEmp(`delete from public.deliverables where id = $1`, [id]);
    return { pass: r.ok && r.affected === 1, info: describe(r) };
  });
  await check('G5-sharedfields-deny', 'Employee cannot create a deliverable with sharing / approval fields', async () => {
    const r = await asEmp(`insert into public.deliverables (project_id, name, status, shared_at) values ($1,'x','pending_review',now())`, [P]);
    return { pass: code(r, '42501'), info: describe(r) };
  });
  await check('G5-file-project', 'A deliverable cannot attach a file from another project (applies to managers too)', async () => {
    const otherFile = (await q(`insert into public.project_files (project_id, file_name, storage_path, size_bytes, uploaded_by) values ($1::uuid,'secret.pdf',$1::text || '/f2/secret.pdf',100,$2) returning id`, [P3, U.pm])).rows[0].id;
    const r = await asUser(U.pm, () => tryQ(`insert into public.deliverables (project_id, name, status, file_id) values ($1,'x','draft',$2)`, [P, otherFile]));
    return { pass: code(r, '23514'), info: describe(r) };
  });
  await check('G5-rename-ok', 'Uploader can rename their file', async () => {
    const r = await asEmp(`update public.project_files set file_name = 'spec-v2.pdf' where id = $1`, [fileP]);
    return { pass: r.ok && r.affected === 1, info: describe(r) };
  });
  await check('G5-path-deny', "Uploader cannot repoint a file at another object (storage path / project fixed)", async () => {
    const r = await asEmp(`update public.project_files set storage_path = $1::text || '/f2/secret.pdf' where id = $2`, [P3, fileP]);
    return { pass: code(r, '42501'), info: describe(r) };
  });
  await check('G5-insert-deny', 'Signed-in users cannot insert file rows directly (uploads go through the server)', async () => {
    const r = await asEmp(`insert into public.project_files (project_id, file_name, storage_path, size_bytes, uploaded_by) values ($1::uuid,'x.pdf',$1::text || '/x/x.pdf',10,$2)`, [P, U.emp]);
    return { pass: code(r, '42501'), info: describe(r) };
  });
  await check('G5-server-insert', 'The server (service role) can still store file rows', async () => {
    const r = await asService(() => tryQ(`insert into public.project_files (project_id, file_name, storage_path, size_bytes, uploaded_by) values ($1::uuid,'s.pdf',$1::text || '/s/s.pdf',10,$2)`, [P, U.emp]));
    return { pass: r.ok, info: describe(r) };
  });
  await check('G5-pm-share', 'Project manager can share a file with the client', async () => {
    const r = await asUser(U.pm, () => tryQ(`update public.project_files set client_visible = true where id = $1`, [fileP]));
    return { pass: r.ok && r.affected === 1, info: describe(r) };
  });

  // ---- G-6 budget privacy
  await check('G6-pm-write', 'Project manager can set budget and hourly rate', async () => {
    const r = await asUser(U.pm, () => tryQ(`insert into public.project_financials (project_id, budget, hourly_rate, updated_by) values ($1, 50000, 80, $2)
                                               on conflict (project_id) do update set budget = excluded.budget, hourly_rate = excluded.hourly_rate`, [P, U.pm]));
    return { pass: r.ok, info: describe(r) };
  });
  await check('G6-pm-read', 'Project manager can read the budget', async () => { const n = await count(U.pm, `select count(*)::int n from public.project_financials where project_id = $1`, [P]); return { pass: n === 1, info: `${n}` }; });
  await check('G6-viewer-read', 'Org-wide viewer (view_all_projects) can read the budget', async () => { const n = await count(U.viewer, `select count(*)::int n from public.project_financials`); return { pass: n === 1, info: `${n}` }; });
  await check('G6-emp-read', 'Employee on the project cannot read the budget', async () => { const n = await count(U.emp, `select count(*)::int n from public.project_financials`); return { pass: n === 0, info: `${n}` }; });
  await check('G6-emp-projects', 'Employee cannot read budget through the projects table (column does not exist)', async () => {
    const r = await asEmp(`select budget from public.projects where id = $1`, [P]);
    return { pass: code(r, '42703'), info: describe(r) };
  });
  await check('G6-emp-write', 'Employee cannot create or change a budget', async () => {
    const a = await asEmp(`insert into public.project_financials (project_id, budget) values ($1, 1)`, [P2]);
    const b = await asEmp(`update public.project_financials set budget = 1 where project_id = $1`, [P]);
    return { pass: !a.ok && denied(b), info: `insert: ${describe(a)}; update: ${describe(b)}` };
  });
  await check('G6-other-pm', 'A project manager from another project cannot read or write the budget', async () => {
    const n = await count(U.pm2, `select count(*)::int n from public.project_financials`);
    const w = await asUser(U.pm2, () => tryQ(`update public.project_financials set budget = 1 where project_id = $1`, [P]));
    return { pass: n === 0 && denied(w), info: `read ${n}; write ${describe(w)}` };
  });
  await check('G6-client', 'Client cannot read budgets', async () => { const n = await count(U.client, `select count(*)::int n from public.project_financials`); return { pass: n === 0, info: `${n}` }; });

  // ---- Notifications: workflow steps and project status (trigger-based)
  {
    const notes = async (uid, type) => (await q(`select title, message, link from public.notifications where user_id = $1 and type = $2 order by created_at`, [uid, type])).rows;
    const roleNode = (await q(`insert into public.workflow_nodes (workflow_template_id, node_type, label, entity_id) values ($1,'role','Build',$2) returning id`, [tpl, R.emp])).rows[0].id;
    const pmNode = (await q(`insert into public.workflow_nodes (workflow_template_id, node_type, label, entity_id) values ($1,'approval','Sign-off',$2) returning id`, [tpl, R.pm])).rows[0].id;
    const addStep = (nodeId, branch, assignee = null) => q(`insert into public.workflow_active_steps (workflow_instance_id, node_id, branch_id, status, assigned_user_id) values ($1,$2,$3,'active',$4) returning id`, [wi, nodeId, branch, assignee]);

    await addStep(node, 'n1'); // client-approval step
    await check('WF-notify-client', 'A client-approval step notifies the project\'s client users, not other accounts or staff', async () => {
      const c = await notes(U.client, 'approval_request'), c2 = await notes(U.client2, 'approval_request'), e = await notes(U.emp, 'approval_request');
      return { pass: c.length === 1 && c[0].link === '/client-portal/approvals' && c2.length === 0 && e.length === 0, info: `client ${c.length}, other client ${c2.length}, employee ${e.length}` };
    });
    const s2 = (await addStep(roleNode, 'n2', U.emp2)).rows[0].id;
    await check('WF-notify-assignee', 'A step assigned to a person notifies that person only', async () => {
      const a = await notes(U.emp2, 'workflow_step'), b = await notes(U.emp, 'workflow_step');
      return { pass: a.length === 1 && b.length === 0 && /Build/.test(a[0].message), info: `assignee ${a.length}, other holder ${b.length}` };
    });
    await check('WF-notify-nodup', 'Re-saving the same assignee does not notify twice', async () => {
      await q(`update public.workflow_active_steps set assigned_user_id = $1 where id = $2`, [U.emp2, s2]);
      return { pass: (await notes(U.emp2, 'workflow_step')).length === 1 };
    });
    await addStep(pmNode, 'n3'); // unassigned approval step: holders of the role
    await check('WF-notify-role', 'An unassigned approval step notifies the holders of its role, never clients', async () => {
      const a = await notes(U.pm, 'approval_request'), b = await notes(U.pm2, 'approval_request'), c = await notes(U.client, 'approval_request');
      return { pass: a.length === 1 && b.length === 1 && c.length === 1 /* only the earlier client step */, info: `pm ${a.length}, pm2 ${b.length}, client total ${c.length}` };
    });
    await check('WF-notify-reactivate', 'A step that is completed and re-activated notifies again', async () => {
      await q(`update public.workflow_active_steps set status = 'completed' where id = $1`, [s2]);
      await q(`update public.workflow_active_steps set status = 'active', activated_at = now() + interval '1 second' where id = $1`, [s2]);
      return { pass: (await notes(U.emp2, 'workflow_step')).length === 2 };
    });

    const pshared = (await q(`insert into public.projects (name, account_id, created_by, shared_with_client, status) values ('Status shared',$1,$2,true,'planning') returning id`, [acct.id, U.pm])).rows[0].id;
    const pinternal = (await q(`insert into public.projects (name, account_id, created_by, shared_with_client, status) values ('Status internal',$1,$2,false,'planning') returning id`, [acct.id, U.pm])).rows[0].id;
    await q(`update public.projects set status = 'in_progress' where id in ($1,$2)`, [pshared, pinternal]);
    await check('PRJ-status-notify', 'A status change on a shared project notifies its client; internal projects and other accounts stay silent', async () => {
      const c = (await q(`select message from public.notifications where user_id = $1 and type = 'project_status' and project_id = $2`, [U.client, pshared])).rows;
      const i = (await q(`select 1 from public.notifications where type = 'project_status' and project_id = $1`, [pinternal])).rows;
      const o = (await q(`select 1 from public.notifications where user_id = $1 and type = 'project_status'`, [U.client2])).rows;
      return { pass: c.length === 1 && /In Progress/.test(c[0].message) && i.length === 0 && o.length === 0, info: `client ${c.length}, internal ${i.length}, other account ${o.length}` };
    });
    await check('PRJ-status-same', 'Saving a project without changing its status sends nothing', async () => {
      await q(`update public.projects set description = 'x' where id = $1`, [pshared]);
      return { pass: (await q(`select 1 from public.notifications where type = 'project_status' and project_id = $1`, [pshared])).rows.length === 1 };
    });
  }

  // ---- Scheduling: a task cannot start while its dependencies are not done
  {
    const mk = async (nm, assignee) => (await q(`insert into public.tasks (name, project_id, created_by, assigned_to, status) values ($1,$2,$3,$4,'todo') returning id`, [nm, P, U.pm, assignee])).rows[0].id;
    const pre = await mk('Design', U.emp2), post = await mk('Build', U.emp);
    await q(`insert into public.task_dependencies (task_id, depends_on_task_id) values ($1,$2)`, [post, pre]);
    const start = (uid, id) => asUser(uid, () => tryQ(`update public.tasks set status = 'in_progress' where id = $1`, [id]));
    await check('SCH-block', 'An assignee cannot start a task whose dependency is not done (names what it waits for)', async () => {
      const r = await start(U.emp, post);
      return { pass: code(r, '23514') && /Waiting for: Design/.test(r.error || r.message || describe(r)), info: describe(r) };
    });
    await check('SCH-manager', 'A project manager may start it early', async () => {
      const r = await start(U.pm, post);
      await q(`update public.tasks set status = 'todo' where id = $1`, [post]);
      return { pass: r.ok, info: describe(r) };
    });
    await check('SCH-unblock', 'Once the dependency is done the assignee can start', async () => {
      await q(`update public.tasks set status = 'done' where id = $1`, [pre]);
      const r = await start(U.emp, post);
      return { pass: r.ok, info: describe(r) };
    });
    await check('SCH-independent', 'Tasks without dependencies start normally', async () => {
      const free = await mk('Free task', U.emp);
      const r = await start(U.emp, free);
      return { pass: r.ok, info: describe(r) };
    });
  }

  // ---- Role escalation guard: U.viewer holds the Executive role (has manage_user_roles)
  {
    // System roles come from supabase/seed.sql, which this harness does not run
    await q(`insert into public.roles (id, name, permissions, is_system_role, hierarchy_level) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Superadmin', '{}', true, 100) on conflict (id) do nothing`);
    const superRole = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const pdRole = await roleId('Project Director');
    const assign = (actor, user, role) => asUser(actor, () => tryQ(`insert into public.user_roles (user_id, role_id) values ($1,$2)`, [user, role]));
    await check('ESC-self-superadmin', 'A role manager cannot give themselves the Superadmin role', async () => {
      const r = await assign(U.viewer, U.viewer, superRole);
      return { pass: denied(r), info: describe(r) };
    });
    await check('ESC-other-superadmin', 'A role manager cannot give anyone else the Superadmin role', async () => {
      const r = await assign(U.viewer, U.emp2, superRole);
      return { pass: denied(r), info: describe(r) };
    });
    await check('ESC-self-any', 'Nobody but a superadmin changes their own roles', async () => {
      const r = await assign(U.viewer, U.viewer, R.emp);
      return { pass: denied(r), info: describe(r) };
    });
    await check('ESC-ceiling', 'A role manager cannot hand out a role with permissions they do not hold (Executive → Project Director)', async () => {
      const r = await assign(U.viewer, U.emp2, pdRole);
      return { pass: denied(r), info: describe(r) };
    });
    await check('ESC-within', 'A role manager can assign a role within their own permissions (Executive → Employee)', async () => {
      const helper = (await q(`insert into public.roles (name, permissions, is_system_role, hierarchy_level) values ('Helper (test)', '{"view_projects":true}', false, 10) returning id`)).rows[0].id;
      const r = await assign(U.viewer, U.emp2, helper);
      await q(`delete from public.user_roles where role_id = $1`, [helper]);
      await q(`delete from public.roles where id = $1`, [helper]);
      return { pass: r.ok, info: describe(r) };
    });
    await check('ESC-remove-superadmin', "A role manager cannot remove a superadmin's role", async () => {
      await q(`insert into public.user_roles (user_id, role_id) values ($1,$2) on conflict do nothing`, [U.admin, superRole]);
      const r = await asUser(U.viewer, () => tryQ(`delete from public.user_roles where user_id = $1`, [U.admin]));
      const still = (await q(`select count(*)::int n from public.user_roles where user_id = $1`, [U.admin])).rows[0].n;
      // Either refused or a no-op (the Executive cannot even see other users' role rows); the row must survive
      return { pass: still === 1, info: `${describe(r)}; superadmin role rows left: ${still}` };
    });
    await check('ESC-superadmin-ok', 'A superadmin can still assign any role', async () => {
      const r = await assign(U.admin, U.emp2, pdRole);
      await q(`delete from public.user_roles where user_id = $1 and role_id = $2`, [U.emp2, pdRole]);
      return { pass: r.ok, info: describe(r) };
    });

    // A department admin (manage_departments) editing role definitions
    const deptAdminRole = (await q(`insert into public.roles (name, permissions, is_system_role, hierarchy_level) values ('Dept Admin (test)', '{"manage_departments":true,"view_projects":true}', false, 40) returning id`)).rows[0].id;
    await q(`insert into public.user_roles (user_id, role_id) values ($1,$2)`, [U.outsider, deptAdminRole]);
    const asDept = (sql, params) => asUser(U.outsider, () => tryQ(sql, params));
    await check('ESC-role-self-widen', 'A department admin cannot add a permission they lack to their own role', async () => {
      const r = await asDept(`update public.roles set permissions = permissions || '{"manage_all_projects":true}' where id = $1`, [deptAdminRole]);
      const has = (await q(`select permissions ? 'manage_all_projects' as x from public.roles where id = $1`, [deptAdminRole])).rows[0].x;
      return { pass: !r.ok && !has, info: describe(r) };
    });
    await check('ESC-role-system', 'A department admin cannot edit a system role', async () => {
      const r = await asDept(`update public.roles set description = 'x' where id = $1`, [superRole]);
      return { pass: !r.ok, info: describe(r) };
    });
    await check('ESC-role-create-ceiling', 'A department admin can create roles only with permissions they hold', async () => {
      const a = await asDept(`insert into public.roles (name, permissions, is_system_role, hierarchy_level) values ('Viewer (test)', '{"view_projects":true}', false, 10) returning id`);
      const b = await asDept(`insert into public.roles (name, permissions, is_system_role, hierarchy_level) values ('Boss (test)', '{"manage_projects":true}', false, 10)`);
      const c = await asDept(`insert into public.roles (name, permissions, is_system_role, hierarchy_level) values ('Fake super (test)', '{}', true, 100)`);
      if (a.ok) await q(`delete from public.roles where id = $1`, [a.rows[0].id]);
      return { pass: a.ok && !b.ok && !c.ok, info: `within: ${describe(a)}; beyond: ${describe(b)}; system: ${describe(c)}` };
    });
    await q(`delete from public.user_roles where user_id = $1 and role_id = $2`, [U.outsider, deptAdminRole]);
    await q(`delete from public.roles where id = $1`, [deptAdminRole]);
  }

  // ---- SEC-12: audit log is server-written, superadmin-readable, append-only
  {
    await asService(() => tryQ(`insert into public.audit_log (actor_id, action, entity_type, entity_id, project_id, details) values ($1,'override_access','project',$2,$2,'{"level":"manage"}')`, [U.admin, P]));
    const readable = async (uid) => count(uid, `select count(*)::int n from public.audit_log`);
    await check('SEC12-read', 'Only a superadmin can read the audit log', async () => {
      const a = await readable(U.admin), e = await readable(U.emp), p = await readable(U.pm), c = await readable(U.client);
      return { pass: a >= 1 && e === 0 && p === 0 && c === 0, info: `superadmin ${a}, employee ${e}, manager ${p}, client ${c}` };
    });
    await check('SEC12-write', 'Signed-in users cannot write to the audit log, not even superadmins', async () => {
      const mk = (uid) => asUser(uid, () => tryQ(`insert into public.audit_log (actor_id, action, entity_type) values ($1,'x','x')`, [uid]));
      const [a, b] = [await mk(U.emp), await mk(U.admin)];
      return { pass: !a.ok && !b.ok, info: `employee: ${describe(a)}; superadmin: ${describe(b)}` };
    });
    await check('SEC12-append-only', 'Audit rows cannot be changed or deleted, even by the server', async () => {
      const u = await asService(() => tryQ(`update public.audit_log set action = 'tampered'`));
      const d = await asService(() => tryQ(`delete from public.audit_log`));
      return { pass: !u.ok && !d.ok && (await q(`select count(*)::int n from public.audit_log where action = 'tampered'`)).rows[0].n === 0, info: `update: ${describe(u)}; delete: ${describe(d)}` };
    });
    await check('SEC12-actor-deleted', 'A user who appears in the audit log can be deleted; the entry keeps their id in details', async () => {
      const gone = (await q(`insert into auth.users (email) values ('audit.actor@test.local') returning id`)).rows[0].id;
      await asService(() => tryQ(`insert into public.audit_log (actor_id, action, entity_type) values ($1,'user_suspend','user')`, [gone]));
      const del = await tryQ(`delete from public.user_profiles where id = $1`, [gone]);
      const row = (await q(`select actor_id, action, details from public.audit_log where details->>'deleted_actor_id' = $1`, [gone])).rows[0];
      return { pass: del.ok && row?.actor_id === null && row?.action === 'user_suspend', info: del.ok ? `entry kept: action=${row?.action}, actor_id=${row?.actor_id}` : describe(del) };
    });
    await check('SEC12-unlink-only', 'Clearing the actor is the only change allowed: changing it to someone else is refused', async () => {
      const r = await asService(() => tryQ(`update public.audit_log set actor_id = $1 where actor_id = $2`, [U.emp, U.admin]));
      const s = await asService(() => tryQ(`update public.audit_log set actor_id = null, action = 'x' where actor_id = $1`, [U.admin]));
      return { pass: !r.ok && !s.ok, info: `reassign: ${describe(r)}; clear + edit: ${describe(s)}` };
    });
  }

  // ---- D-1 project completes when its workflow completes
  const wi4 = (await q(`insert into public.workflow_instances (workflow_template_id, project_id, current_node_id, status) values ($1,$2,$3,'active') returning id`, [tpl, P4, node])).rows[0].id;
  await check('D1-direct-blocked', 'An employee cannot update the project row directly (why the old code failed silently)', async () => {
    const r = await asEmp(`update public.projects set status = 'complete' where id = $1`, [P4]);
    return { pass: denied(r), info: describe(r) };
  });
  await check('D1-complete', 'When an employee finishes the last workflow step, the project becomes complete with completed_at', async () => {
    const r = await asEmp(`update public.workflow_instances set status = 'completed', completed_at = now() where id = $1`, [wi4]);
    const p = (await q(`select status, completed_at from public.projects where id = $1`, [P4])).rows[0];
    return { pass: r.ok && r.affected === 1 && p.status === 'complete' && !!p.completed_at, info: `instance update: ${describe(r)}; project: ${p.status}, completed_at ${p.completed_at ? 'set' : 'empty'}` };
  });
  await check('D1-manager-path', 'The original completion update (status + completed_at) now works for a manager', async () => {
    const r = await asUser(U.pm, () => tryQ(`update public.projects set status = 'complete', completed_at = now() where id = $1`, [P]));
    await q(`update public.projects set status = 'in_progress', completed_at = null where id = $1`, [P]);
    return { pass: r.ok && r.affected === 1, info: describe(r) };
  });

  // ---- D-2 workflow history rows use the real columns
  await check('D2-history', 'Team member can record "started", auto-routed and out-of-order history rows', async () => {
    const rows = [];
    for (const t of ['normal', 'auto', 'out_of_order']) {
      rows.push(await asEmp(`insert into public.workflow_history (workflow_instance_id, from_node_id, to_node_id, transitioned_by, transition_type, notes) values ($1,$2,$2,$3,$4,'x')`, [wi, node, U.emp, t]));
    }
    return { pass: rows.every((r) => r.ok), info: rows.map(describe).join('; ') };
  });
  await check('D2-old-shape', 'The old insert shape (handed_off_by / branch_id) is rejected by the database', async () => {
    const r = await asEmp(`insert into public.workflow_history (workflow_instance_id, from_node_id, to_node_id, handed_off_by, branch_id) values ($1,$2,$2,$3,'main')`, [wi, node, U.emp]);
    return { pass: code(r, '42703'), info: describe(r) };
  });

  // ---- D-3 workflow project updates + workflow link
  await check('D3-update-ok', 'Workflow project update with created_by and no update_type is saved', async () => {
    const r = await asEmp(`insert into public.project_updates (project_id, content, created_by) values ($1,'**Workflow Reset**',$2)`, [P, U.emp]);
    return { pass: r.ok, info: describe(r) };
  });
  await check('D3-old-shape', 'The old shapes fail: update_type column / missing created_by', async () => {
    const a = await asEmp(`insert into public.project_updates (project_id, content, created_by, update_type) values ($1,'x',$2,'workflow')`, [P, U.emp]);
    const b = await asEmp(`insert into public.project_updates (project_id, content) values ($1,'x')`, [P]);
    return { pass: code(a, '42703') && !b.ok, info: `update_type: ${describe(a)}; no created_by: ${describe(b)}` };
  });
  await check('D3-link', 'projects.workflow_instance_id can be written by a project manager', async () => {
    const r = await asUser(U.pm, () => tryQ(`update public.projects set workflow_instance_id = $1 where id = $2`, [wi, P]));
    return { pass: r.ok && r.affected === 1, info: describe(r) };
  });

  // ---- Creating projects in an account you manage (accounts.account_manager_id, not a member row)
  const managed = (await q(`insert into public.accounts (name, account_manager_id) values ('Managed by pm2', $1) returning id`, [U.pm2])).rows[0].id;
  const empManaged = (await q(`insert into public.accounts (name, account_manager_id) values ('Managed by emp', $1) returning id`, [U.emp])).rows[0].id;
  const newProject = (uid, acct, name) => asUser(uid, () => tryQ(`insert into public.projects (name, account_id, created_by) values ($1,$2,$3) returning id`, [name, acct, uid]));
  await check('PRJ-insert-account-manager', 'A user with manage_projects can create a project in an account they manage (not a member)', async () => {
    const r = await newProject(U.pm2, managed, 'First project of a new client');
    return { pass: r.ok && r.affected === 1, info: describe(r) };
  });
  await check('PRJ-insert-other-account', "manage_projects alone does not allow creating projects in someone else's account", async () => {
    const r = await newProject(U.pm, managed, 'Not my account');
    return { pass: denied(r), info: describe(r) };
  });
  await check('PRJ-insert-manager-no-permission', 'Managing an account without manage_projects does not allow creating projects', async () => {
    const r = await newProject(U.emp, empManaged, 'No permission');
    return { pass: denied(r), info: describe(r) };
  });

  // ---- Direct department membership (department_members)
  const dept = (await q(`insert into public.departments (name) values ('Tech (members test)') returning id`)).rows[0].id;
  const addMember = (actor, user) => asUser(actor, () => tryQ(`insert into public.department_members (department_id, user_id, added_by) values ($1,$2,$3)`, [dept, user, actor]));
  await check('DEPT-member-superadmin', 'A superadmin can add someone to a department', async () => {
    const r = await addMember(U.admin, U.pm);
    return { pass: r.ok && r.affected === 1, info: describe(r) };
  });
  await check('DEPT-member-role-manager', 'Someone who manages user roles (Executive) can add people to departments', async () => {
    const r = await addMember(U.viewer, U.emp2);
    return { pass: r.ok && r.affected === 1, info: describe(r) };
  });
  await check('DEPT-member-employee-refused', 'An employee cannot add anyone (or themselves) to a department', async () => {
    const a = await addMember(U.emp, U.emp);
    const b = await addMember(U.emp, U.outsider);
    return { pass: denied(a) && denied(b), info: `self: ${describe(a)}; other: ${describe(b)}` };
  });
  await check('DEPT-member-unique', 'The same person cannot be added to the same department twice', async () => {
    const r = await addMember(U.admin, U.pm);
    return { pass: code(r, '23505'), info: describe(r) };
  });
  await check('DEPT-member-read', 'Staff can see department members; a client sees none of them', async () => {
    const staff = (await asUser(U.emp, () => tryQ(`select count(*)::int n from public.department_members where department_id = $1`, [dept]))).rows[0]?.n;
    const client = await asUser(U.client, () => tryQ(`select count(*)::int n from public.department_members`));
    return { pass: staff === 2 && client.ok && client.rows[0].n === 0, info: `employee sees ${staff}, client sees ${client.rows[0]?.n}` };
  });
  await check('DEPT-member-remove', 'Only an admin or role manager can remove a membership', async () => {
    const byEmp = await asUser(U.emp, () => tryQ(`delete from public.department_members where department_id = $1 and user_id = $2`, [dept, U.emp2]));
    const byAdmin = await asUser(U.admin, () => tryQ(`delete from public.department_members where department_id = $1 and user_id = $2`, [dept, U.emp2]));
    return { pass: denied(byEmp) && byAdmin.ok && byAdmin.affected === 1, info: `employee: ${describe(byEmp)}; admin: ${describe(byAdmin)}` };
  });
  await check('DEPT-member-cascade', 'Deleting a department removes its memberships', async () => {
    await q(`delete from public.departments where id = $1`, [dept]);
    const left = (await q(`select count(*)::int n from public.department_members where department_id = $1`, [dept])).rows[0].n;
    return { pass: left === 0, info: `${left} left` };
  });

  await db.close();
}
