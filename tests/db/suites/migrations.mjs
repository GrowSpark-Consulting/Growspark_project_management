// Suite: every migration applies, in order, to a clean database; the resulting schema
// contains what the application code expects (and no longer contains what it must not).
import { createDatabase, sessions, migrationFiles } from '../lib/harness.mjs';

export const name = 'Migrations (clean database)';

export async function run(report) {
  const { db, migrations } = await createDatabase();
  const total = migrationFiles().length;

  for (const m of migrations) {
    await report.check(`MIG ${m.file.slice(0, 14)}`, `Applies cleanly: ${m.file}`, () => ({
      pass: m.ok,
      info: m.ok ? '' : `${m.error}\n${m.context || ''}`,
    }));
  }
  if (migrations.length < total) {
    const skipped = migrationFiles().slice(migrations.length);
    for (const f of skipped) report.record(`MIG ${f.slice(0, 14)}`, `Applies cleanly: ${f}`, 'FAIL', 'not run: an earlier migration failed');
    return; // schema checks would only repeat the failure
  }

  const { q } = sessions(db);
  const columns = async (table) =>
    (await q(`select column_name from information_schema.columns where table_schema = 'public' and table_name = $1`, [table])).rows.map((r) => r.column_name);
  const hasTable = async (table) => (await q(`select to_regclass($1) is not null as ok`, [`public.${table}`])).rows[0].ok;
  const triggers = async (table) =>
    (await q(`select tgname from pg_trigger where tgrelid = $1::regclass and not tgisinternal`, [`public.${table}`])).rows.map((r) => r.tgname);
  const rlsOn = async (table) => (await q(`select relrowsecurity from pg_class where oid = $1::regclass`, [`public.${table}`])).rows[0]?.relrowsecurity === true;

  await report.check('SCHEMA-tables', 'New tables exist: timesheets, task_activity, comments, project_files, project_templates, app_settings, project_financials', async () => {
    const want = ['timesheets', 'task_activity', 'comments', 'project_files', 'project_templates', 'app_settings', 'project_financials'];
    const missing = [];
    for (const t of want) if (!(await hasTable(t))) missing.push(t);
    return { pass: missing.length === 0, info: missing.length ? `missing: ${missing.join(', ')}` : '' };
  });

  await report.check('SCHEMA-rls', 'Row-level security is on for every public table', async () => {
    const off = (await q(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
                          where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity order by 1`)).rows.map((r) => r.relname);
    return { pass: off.length === 0, info: off.length ? `RLS off: ${off.join(', ')}` : '' };
  });

  await report.check('G-6 schema', 'projects has no budget / hourly_rate columns (moved to project_financials)', async () => {
    const cols = await columns('projects');
    const leaked = cols.filter((c) => c === 'budget' || c === 'hourly_rate');
    const fin = await columns('project_financials');
    return { pass: leaked.length === 0 && fin.includes('budget') && fin.includes('hourly_rate') && (await rlsOn('project_financials')), info: leaked.length ? `still on projects: ${leaked.join(', ')}` : '' };
  });

  await report.check('MONEY types', 'Money columns are Decimal(14,2): project budget, hourly rate, company default rate', async () => {
    const { rows } = await q(`select table_name, column_name, numeric_precision, numeric_scale from information_schema.columns
                              where table_schema = 'public' and ((table_name = 'project_financials' and column_name in ('budget','hourly_rate'))
                                 or (table_name = 'app_settings' and column_name = 'default_hourly_rate')) order by 1, 2`);
    const bad = rows.filter((r) => r.numeric_precision !== 14 || r.numeric_scale !== 2);
    return { pass: rows.length === 3 && bad.length === 0, info: rows.map((r) => `${r.table_name}.${r.column_name}=${r.numeric_precision},${r.numeric_scale}`).join(' ') };
  });
  await report.check('MONEY currency', 'Currency is an ISO code (default INR) on project budgets and company settings', async () => {
    const { rows: [pid] } = await q(`insert into public.accounts (name) values ('Currency test') returning id`);
    const { rows: [proj] } = await q(`insert into public.projects (name, account_id) values ('Currency test', $1) returning id`, [pid.id]);
    const def = (await q(`insert into public.project_financials (project_id, budget) values ($1, 482000.50) returning currency, budget`, [proj.id])).rows[0];
    let lowerRejected = false;
    try { await q(`update public.project_financials set currency = 'inr' where project_id = $1`, [proj.id]); } catch { lowerRejected = true; }
    let wordRejected = false;
    try { await q(`update public.app_settings set currency = 'RUPEE'`); } catch { wordRejected = true; }
    const company = (await q(`select currency from public.app_settings limit 1`)).rows[0]?.currency;
    return {
      pass: def.currency === 'INR' && Number(def.budget) === 482000.5 && lowerRejected && wordRejected && company === 'INR',
      info: `default=${def.currency} budget=${def.budget} lowercase-rejected=${lowerRejected} word-rejected=${wordRejected} company=${company}`,
    };
  });

  await report.check('AUTH profile trigger', 'A new auth user gets a user_profiles row (on_auth_user_created), and re-running the function is harmless', async () => {
    const trig = (await q(`select count(*)::int as n from pg_trigger where tgrelid = 'auth.users'::regclass and not tgisinternal
                           and tgfoid = 'public.handle_new_user()'::regprocedure`)).rows[0].n;
    const { rows: [u] } = await q(`insert into auth.users (email, raw_user_meta_data) values ('trigger.check@test.local', '{"name":"Trigger Check"}') returning id`);
    const prof = (await q(`select name, email from public.user_profiles where id = $1`, [u.id])).rows[0];
    // A second (hand-made) trigger calling the same function must not fail with a duplicate key
    await q(`create trigger zz_duplicate_profile_trigger after insert on auth.users for each row execute function public.handle_new_user()`);
    let dupOk = true;
    try { await q(`insert into auth.users (email) values ('trigger.dup@test.local')`); } catch { dupOk = false; }
    await q(`drop trigger zz_duplicate_profile_trigger on auth.users`);
    return {
      pass: trig === 1 && prof?.name === 'Trigger Check' && prof?.email === 'trigger.check@test.local' && dupOk,
      info: `triggers=${trig} profile=${prof ? prof.name : 'missing'} duplicate-safe=${dupOk}`,
    };
  });

  await report.check('D-5 form_templates', 'form_templates has is_active (default true) and a read-only "fields" derived from "schema" (array or {fields})', async () => {
    const a = (await q(`insert into public.form_templates (name, schema) values ('A', '[{"id":"f1","type":"text"}]') returning is_active, fields`)).rows[0];
    const b = (await q(`insert into public.form_templates (name, schema) values ('B', '{"fields":[{"id":"f2"}]}') returning fields`)).rows[0];
    const c = (await q(`insert into public.form_templates (name, schema) values ('C', '{}') returning fields`)).rows[0];
    let writable = true;
    try { await q(`update public.form_templates set fields = '[]' where name = 'A'`); } catch { writable = false; }
    return { pass: a.is_active === true && a.fields[0]?.id === 'f1' && b.fields[0]?.id === 'f2' && Array.isArray(c.fields) && c.fields.length === 0 && !writable,
      info: `active=${a.is_active} array=${a.fields?.length} object=${b.fields?.length} empty=${c.fields?.length} fields-writable=${writable}` };
  });

  await report.check('D-1 schema','projects.completed_at exists (written when a project completes)', async () => (await columns('projects')).includes('completed_at'));
  await report.check('D-3 schema', 'projects.workflow_instance_id exists (link written when a workflow starts)', async () => (await columns('projects')).includes('workflow_instance_id'));

  await report.check('D-3 no-ambiguity', 'Only one foreign-key relationship between projects and workflow_instances (keeps API joins unambiguous)', async () => {
    const { rows } = await q(`select conname from pg_constraint where contype = 'f'
                              and ((conrelid = 'public.projects'::regclass and confrelid = 'public.workflow_instances'::regclass)
                                or (conrelid = 'public.workflow_instances'::regclass and confrelid = 'public.projects'::regclass))`);
    return { pass: rows.length === 1, info: rows.map((r) => r.conname).join(', ') };
  });

  await report.check('SCHEMA-triggers', 'Rule triggers installed (tasks, timesheets, updates, issues, deliverables, files, workflow instances)', async () => {
    const want = {
      tasks: ['enforce_task_field_rules', 'enforce_task_status_transition', 'log_task_activity', 'validate_task_parent'],
      task_dependencies: ['validate_task_dependency'],
      timesheets: ['enforce_timesheet_rules'],
      time_entries: ['enforce_timesheet_lock'],
      project_updates: ['enforce_client_visibility'],
      project_issues: ['enforce_client_visibility'],
      deliverables: ['enforce_deliverable_rules'],
      project_files: ['enforce_project_file_rules'],
      workflow_instances: ['complete_project_when_workflow_completes'],
      user_profiles: ['protect_profile_privileged_columns'],
      comments: ['prepare_comment'],
    };
    const missing = [];
    for (const [table, names] of Object.entries(want)) {
      const have = await triggers(table);
      for (const n of names) if (!have.includes(n)) missing.push(`${table}.${n}`);
    }
    return { pass: missing.length === 0, info: missing.length ? `missing: ${missing.join(', ')}` : '' };
  });

  await report.check('SCHEMA-anon', 'The anon role has no table privileges in public', async () => {
    const { rows } = await q(`select table_name, privilege_type from information_schema.role_table_grants
                              where grantee = 'anon' and table_schema = 'public' limit 5`);
    return { pass: rows.length === 0, info: rows.map((r) => `${r.table_name}:${r.privilege_type}`).join(', ') };
  });

  await report.check('SCHEMA-bucket', 'Private storage bucket "project-files" (10 MB) created', async () => {
    const { rows } = await q(`select public, file_size_limit from storage.buckets where id = 'project-files'`);
    return { pass: rows.length === 1 && rows[0].public === false && Number(rows[0].file_size_limit) === 10485760, info: JSON.stringify(rows) };
  });

  await db.close();

  // ------------------------------------------------------------------ company registration (fresh installation)
  // A separate, empty database: registration only finishes when no other users exist.
  const fresh = await createDatabase();
  if (!fresh.allApplied) { report.record('REG-db', 'Fresh database for registration checks', 'FAIL', 'migrations did not apply'); return; }
  const R = sessions(fresh.db);
  const rq = R.q;
  await rq(`insert into public.app_settings (id) values (true) on conflict do nothing`);
  if (!(await rq(`select 1 from public.roles where name = 'Superadmin' and is_system_role`)).rows.length) {
    await rq(`insert into public.roles (name, permissions, is_system_role, hierarchy_level) values ('Superadmin', '{}', true, 100)`);
  }
  const claim = () => rq(`update public.app_settings set registered_at = now(), registered_by = null, workspace_name = 'Test WS' where id = true`);
  const newUser = async (email) => (await rq(`insert into auth.users (email) values ($1) returning id`, [email])).rows[0].id;
  const finish = (uid, email) => R.asService(() => R.tryQ(`select public.complete_workspace_registration($1, $2, 'Owner', '+911234567890')`, [uid, email]));
  const stateOf = async (uid) => (await rq(`select p.is_superadmin, (select count(*)::int from public.user_roles ur join public.roles r on r.id = ur.role_id where ur.user_id = p.id and r.name = 'Superadmin') as roles,
                                             (select registered_by from public.app_settings where id = true) as registered_by
                                             from public.user_profiles p where p.id = $1`, [uid])).rows[0];

  await report.check('REG-finish-private', 'complete_workspace_registration can only be called by the server (not anon or signed-in users)', async () => {
    await claim();
    const uid = await newUser('reg.private@test.local');
    const a = await R.asAnon(() => R.tryQ(`select public.complete_workspace_registration($1, 'x@test.local', 'X', null)`, [uid]));
    const u = await R.asUser(uid, () => R.tryQ(`select public.complete_workspace_registration($1, 'x@test.local', 'X', null)`, [uid]));
    const s = await stateOf(uid);
    await rq(`delete from auth.users where id = $1`, [uid]);
    await rq(`delete from public.user_profiles where id = $1`, [uid]);
    return { pass: !a.ok && !u.ok && s.is_superadmin !== true && !s.registered_by, info: `anon=${a.code} authenticated=${u.code}` };
  });

  await report.check('REG-finish-atomic', 'If any part fails, nothing is written (profile stays a normal user, no role, registration not recorded)', async () => {
    await claim();
    const uid = await newUser('reg.atomic@test.local');
    await rq(`create function public.zz_fail_role() returns trigger language plpgsql as $$ begin raise exception 'simulated failure'; end $$`);
    await rq(`create trigger zz_fail_role before insert on public.user_roles for each row execute function public.zz_fail_role()`);
    const r = await finish(uid, 'reg.atomic@test.local');
    await rq(`drop trigger zz_fail_role on public.user_roles`);
    await rq(`drop function public.zz_fail_role()`);
    const s = await stateOf(uid);
    await rq(`delete from auth.users where id = $1`, [uid]);
    await rq(`delete from public.user_profiles where id = $1`, [uid]);
    return { pass: !r.ok && s.is_superadmin !== true && s.roles === 0 && !s.registered_by, info: `error=${r.msg}; superadmin=${s.is_superadmin} roles=${s.roles} registered_by=${s.registered_by}` };
  });

  await report.check('REG-finish-needs-claim', 'Without a registration in progress it refuses (55000)', async () => {
    await rq(`update public.app_settings set registered_at = null, registered_by = null where id = true`);
    const uid = await newUser('reg.noclaim@test.local');
    const r = await finish(uid, 'reg.noclaim@test.local');
    await rq(`delete from auth.users where id = $1`, [uid]);
    await rq(`delete from public.user_profiles where id = $1`, [uid]);
    return { pass: !r.ok && r.code === '55000', info: `${r.code} ${r.msg}` };
  });

  await report.check('REG-finish-ok', 'With a claim held, it makes the new user the superadmin manager with the Superadmin role and records registered_by', async () => {
    await claim();
    const uid = await newUser('reg.owner@test.local');
    const r = await finish(uid, 'reg.owner@test.local');
    const s = await stateOf(uid);
    return { pass: r.ok && s.is_superadmin === true && s.roles === 1 && s.registered_by === uid, info: r.ok ? `superadmin=${s.is_superadmin} roles=${s.roles}` : `${r.code} ${r.msg}` };
  });

  await report.check('REG-finish-once', 'A second finish (another account) is refused once registration is recorded', async () => {
    const uid = await newUser('reg.second@test.local');
    const r = await finish(uid, 'reg.second@test.local');
    const s = await stateOf(uid);
    return { pass: !r.ok && r.code === '55000' && s.is_superadmin !== true, info: `${r.code} ${r.msg}` };
  });

  await report.check('REG-finish-other-users', 'It refuses when the installation already has other users (55000)', async () => {
    await rq(`update public.app_settings set registered_at = now(), registered_by = null where id = true`);
    const uid = await newUser('reg.late@test.local');
    const r = await finish(uid, 'reg.late@test.local');
    return { pass: !r.ok && r.code === '55000' && /already has users/.test(r.msg), info: `${r.code} ${r.msg}` };
  });

  await fresh.db.close();
}
