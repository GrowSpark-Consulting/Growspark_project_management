// Creates the local end-to-end test personas and base data. Safe to re-run.
// Usage: node tests/local-e2e/seed.mjs   (local Docker Supabase only)
import { loadEnv, adminClient, PASSWORD, isoDate, addDays, mondayOf } from './lib.mjs';

export const IDS = {
  acme: '0e2e0000-0000-4000-8000-00000000a001',
  globex: '0e2e0000-0000-4000-8000-00000000a002',
  website: '0e2e0000-0000-4000-8000-00000000b001', // Acme, shared with client
  internal: '0e2e0000-0000-4000-8000-00000000b002', // Acme, internal only
  portal: '0e2e0000-0000-4000-8000-00000000b003', // Globex, shared with its client
};

export const PERSONAS = {
  superadmin: { email: 'e2e.superadmin@example.com', name: 'Sam Superadmin', role: 'Superadmin', superadmin: true },
  executive: { email: 'e2e.exec@example.com', name: 'Esha Executive', role: 'Executive' },
  pm: { email: 'e2e.pm@example.com', name: 'Priya Manager', role: 'Project Manager' },
  pm2: { email: 'e2e.pm2@example.com', name: 'Paul OtherManager', role: 'Project Manager' },
  emp1: { email: 'e2e.emp1@example.com', name: 'Arjun Developer', role: 'Employee' },
  emp2: { email: 'e2e.emp2@example.com', name: 'Meera Designer', role: 'Employee' },
  outsider: { email: 'e2e.outsider@example.com', name: 'Omar Outsider', role: 'Employee' },
  client: { email: 'e2e.client@example.com', name: 'Chris AcmeClient', role: 'Client', clientOf: 'acme' },
  client2: { email: 'e2e.client2@example.com', name: 'Gita GlobexClient', role: 'Client', clientOf: 'globex' },
};

async function ensureUser(admin, p, existing) {
  const found = existing.find((u) => u.email?.toLowerCase() === p.email);
  if (found) {
    await admin.auth.admin.updateUserById(found.id, { password: PASSWORD, ban_duration: 'none' });
    return found.id;
  }
  const { data, error } = await admin.auth.admin.createUser({
    email: p.email, password: PASSWORD, email_confirm: true, user_metadata: { name: p.name },
  });
  if (error) throw new Error(`createUser ${p.email}: ${error.message}`);
  return data.user.id;
}

export async function seed({ quiet = false } = {}) {
  const env = loadEnv();
  const admin = adminClient(env);
  const log = (...a) => { if (!quiet) console.log(...a); };

  const { data: roleRows, error: rolesErr } = await admin.from('roles').select('id, name');
  if (rolesErr) throw rolesErr;
  const roleId = (name) => {
    const r = roleRows.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!r) throw new Error(`Role "${name}" is missing. Run: npx supabase db reset`);
    return r.id;
  };

  const { data: list, error: listErr } = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (listErr) throw listErr;
  const ids = {};
  for (const [key, p] of Object.entries(PERSONAS)) ids[key] = await ensureUser(admin, p, list.users);

  // Every persona has its plain profile (normally made by the auth trigger; the shared-database
  // rehearsal has no trigger, and accounts may already exist from an earlier run)
  await admin.from('user_profiles').upsert(
    Object.entries(PERSONAS).map(([key, p]) => ({ id: ids[key], email: p.email, name: p.name })),
    { onConflict: 'id', ignoreDuplicates: true });

  // Wait for the profile trigger
  for (let i = 0; i < 20; i++) {
    const { data } = await admin.from('user_profiles').select('id').in('id', Object.values(ids));
    if ((data || []).length === Object.keys(ids).length) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  // Accounts first (client profiles reference them)
  const check = (r, what) => { if (r.error) throw new Error(`${what}: ${r.error.message}`); return r.data; };
  check(await admin.from('accounts').upsert([
    { id: IDS.acme, name: 'Acme Corp (E2E)', description: 'Local E2E client account', account_manager_id: ids.pm, service_tier: 'enterprise', status: 'active' },
    { id: IDS.globex, name: 'Globex (E2E)', description: 'Second client account for isolation checks', account_manager_id: ids.pm2, service_tier: 'premium', status: 'active' },
  ]), 'accounts');

  for (const [key, p] of Object.entries(PERSONAS)) {
    check(await admin.from('user_profiles').update({
      name: p.name,
      is_superadmin: !!p.superadmin,
      is_client: p.role === 'Client',
      client_account_id: p.clientOf ? IDS[p.clientOf] : null,
      has_completed_onboarding: true,
      is_active: true,
      deactivated_at: null,
      suspended_until: null,
      suspension_reason: null,
    }).eq('id', ids[key]), `profile ${p.email}`);
    await admin.from('user_roles').delete().eq('user_id', ids[key]);
    check(await admin.from('user_roles').insert({ user_id: ids[key], role_id: roleId(p.role) }), `role ${p.email}`);
  }

  const today = new Date();
  check(await admin.from('projects').upsert([
    { id: IDS.website, name: 'Website Redesign (E2E)', description: 'Main E2E project, shared with the Acme client', account_id: IDS.acme, status: 'in_progress', priority: 'high', start_date: isoDate(addDays(-14, today)), end_date: isoDate(addDays(30, today)), created_by: ids.pm, assigned_user_id: ids.pm, shared_with_client: true, archived_at: null, completed_at: null },
    { id: IDS.internal, name: 'Internal Tools (E2E)', description: 'Internal project, never shared with the client', account_id: IDS.acme, status: 'planning', priority: 'medium', start_date: isoDate(addDays(-3, today)), end_date: isoDate(addDays(60, today)), created_by: ids.pm, assigned_user_id: ids.pm, shared_with_client: false, archived_at: null, completed_at: null },
    { id: IDS.portal, name: 'Globex Portal (E2E)', description: 'Other account, managed by pm2', account_id: IDS.globex, status: 'in_progress', priority: 'medium', start_date: isoDate(addDays(-7, today)), end_date: isoDate(addDays(-1, today)), created_by: ids.pm2, assigned_user_id: ids.pm2, shared_with_client: true, archived_at: null, completed_at: null },
  ]), 'projects');

  const assignments = [
    [IDS.website, ids.pm, 'Project Manager'], [IDS.website, ids.emp1, 'Developer'], [IDS.website, ids.emp2, 'Designer'],
    [IDS.internal, ids.pm, 'Project Manager'], [IDS.internal, ids.emp1, 'Developer'],
    [IDS.portal, ids.pm2, 'Project Manager'], [IDS.portal, ids.emp2, 'Designer'],
  ];
  for (const [project_id, user_id, role_in_project] of assignments) {
    const { data: row } = await admin.from('project_assignments').select('id').eq('project_id', project_id).eq('user_id', user_id).maybeSingle();
    if (row) check(await admin.from('project_assignments').update({ removed_at: null, role_in_project }).eq('id', row.id), 'assignment');
    else check(await admin.from('project_assignments').insert({ project_id, user_id, role_in_project, assigned_by: ids.pm }), 'assignment');
  }
  for (const [project_id, user_id] of [[IDS.website, ids.pm], [IDS.website, ids.emp1], [IDS.website, ids.emp2], [IDS.internal, ids.pm], [IDS.portal, ids.pm2]]) {
    const { data: m } = await admin.from('account_members').select('id').eq('user_id', user_id).eq('account_id', project_id === IDS.portal ? IDS.globex : IDS.acme).maybeSingle();
    if (!m) await admin.from('account_members').insert({ user_id, account_id: project_id === IDS.portal ? IDS.globex : IDS.acme });
  }

  const ws = mondayOf(today);
  // Reset per-run state for the E2E personas only, so the flows can be re-run in the same week
  const people = Object.values(ids);
  check(await admin.from('timesheets').delete().in('user_id', people), 'reset timesheets');
  check(await admin.from('time_entries').delete().in('user_id', people).eq('week_start_date', ws), 'reset time entries');
  check(await admin.from('clock_sessions').delete().in('user_id', people).eq('is_active', true), 'reset clock sessions');

  for (const key of ['pm', 'emp1', 'emp2']) {
    await admin.from('user_availability').upsert({ user_id: ids[key], week_start_date: ws, available_hours: 40 }, { onConflict: 'user_id,week_start_date' });
  }

  log('Local E2E personas ready (password for all: ' + PASSWORD + ')');
  for (const [key, p] of Object.entries(PERSONAS)) log(`  ${key.padEnd(10)} ${p.email.padEnd(28)} ${p.role}`);
  return { env, admin, ids };
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('seed.mjs')) {
  seed().catch((e) => { console.error(e.message || e); process.exit(1); });
}
