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
}
