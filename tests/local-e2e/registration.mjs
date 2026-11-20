// Company registration end to end, on a brand-new local installation.
//
// DESTRUCTIVE FOR THE LOCAL DATABASE ONLY: it runs `npx supabase db reset --local` (re-applies every
// migration and seed.sql) because registration only opens when there are no users. It refuses to run
// unless the Supabase URL is localhost/127.0.0.1 AND you pass --reset-local-db, and it refuses when the
// database holds accounts that aren't test accounts (a workspace you registered yourself) unless you
// also pass --wipe-local-accounts. It registers a clearly-named TEST company ("E2E Test Company"),
// never a real name. Afterwards it re-creates the E2E test users (seed.mjs), so `npm run e2e:local`
// works again; `npm run local:fresh` gives you an empty installation to register your own company.
//
// Usage: node tests/local-e2e/registration.mjs --reset-local-db   (app running on port 3100)
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { loadEnv, adminClient, signIn, call, Report, ROOT, resetLocalDb } from './lib.mjs';
import { seed } from './seed.mjs';

if (!process.argv.includes('--reset-local-db')) {
  console.error('This test resets the LOCAL Supabase database. Re-run with --reset-local-db to confirm.');
  process.exit(2);
}
const env = loadEnv(); // throws unless local
const report = new Report('Company registration');
const OUT = path.join(ROOT, 'tests', 'local-e2e', 'output');
fs.mkdirSync(OUT, { recursive: true });
const RUN = Date.now().toString(36);
const MANAGER = { email: `owner.${RUN}@example.com`, password: 'Workspace2026', name: 'E2E Owner' };

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  if (!fs.existsSync(base)) return undefined;
  for (const d of fs.readdirSync(base).filter((x) => x.startsWith('chromium_headless_shell-')).sort().reverse()) {
    const exe = path.join(base, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return undefined;
}

const post = (body) => call(env, null, 'POST', '/api/register', body);
const valid = { companyName: 'E2E Test Company', workspaceName: 'E2E Workspace', workspaceSlug: 'e2e-workspace', name: MANAGER.name, email: MANAGER.email, password: MANAGER.password, phone: '+91 98765 43210', acceptTerms: true };

async function main() {
  report.start('Fresh local installation');
  await resetLocalDb(env);
  const admin = adminClient(env);
  const { count } = await admin.from('user_profiles').select('id', { count: 'exact', head: true });
  report.record('RESET', count === 0, `${count} users after reset`);
  const st = await call(env, null, 'GET', '/api/register');
  report.record('REG-open', st.status === 200 && st.body?.data?.open === true, `status ${st.status}, open=${st.body?.data?.open}`);

  report.start('Validation (server side)');
  for (const [id, body, field] of [
    ['REG-missing', {}, 'companyName'],
    ['REG-email', { ...valid, email: 'not-an-email' }, 'email'],
    ['REG-password', { ...valid, password: 'password' }, 'password'],
    ['REG-phone', { ...valid, phone: 'call me' }, 'phone'],
    ['REG-slug-reserved', { ...valid, workspaceSlug: 'admin' }, 'workspaceSlug'],
    ['REG-slug-format', { ...valid, workspaceSlug: 'Grow Spark' }, 'workspaceSlug'],
    ['REG-terms', { ...valid, acceptTerms: false }, 'acceptTerms'],
  ]) {
    const r = await post(body);
    report.record(id, r.status === 400 && !!r.body?.fieldErrors?.[field], `status ${r.status}: ${r.body?.fieldErrors?.[field] || r.body?.error}`);
  }
  const slugCheck = await call(env, null, 'GET', '/api/register/slug?slug=e2e-workspace');
  report.record('REG-slug-available', slugCheck.body?.data?.available === true, 'e2e-workspace is available');
  const { count: still } = await admin.from('user_profiles').select('id', { count: 'exact', head: true });
  report.record('REG-nothing-created', still === 0, 'rejected forms created no users');

  report.start('Registration through the page (browser)');
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    const route = [];
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) route.push(new URL(f.url()).pathname); });
    await page.goto(`${env.appUrl}/signup`, { waitUntil: 'load', timeout: 120000 });
    await page.fill('#companyName', valid.companyName);
    const suggested = await page.inputValue('#workspaceSlug');
    report.record('UI-slug-suggested', suggested === 'e2e-test-company', `suggested "${suggested}"`);
    await page.fill('#workspaceName', valid.workspaceName);
    await page.fill('#workspaceSlug', valid.workspaceSlug);
    await page.fill('#name', MANAGER.name);
    await page.fill('#email', MANAGER.email);
    await page.fill('#password', 'weak');
    await page.click('button[type="submit"]');
    report.record('UI-validation', await page.locator('text=Password needs').first().isVisible().catch(() => false), 'weak password message shown, nothing submitted');
    await page.fill('#password', MANAGER.password);
    await page.fill('#phone', valid.phone);
    await page.check('input[type="checkbox"]');
    await page.screenshot({ path: path.join(OUT, 'registration-form.png') });
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/manager'), { timeout: 60000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    const landed = new URL(page.url()).pathname;
    await page.screenshot({ path: path.join(OUT, 'registration-landed.png') });
    const detours = route.filter((p) => !['/signup', '/manager'].includes(p));
    report.record('UI-register-lands-manager', landed === '/manager' && detours.length === 0, `route ${[...new Set(route)].join(' → ')}`);
    const dash = await page.locator('body').innerText().catch(() => '');
    report.record('UI-manager-dashboard', /Active projects|Projects/i.test(dash) && !/Something went wrong|Application error/i.test(dash), 'Manager dashboard rendered');
    report.record('UI-onboarding-checklist', /Set up your workspace/.test(dash) && /Invite employees/.test(dash), 'setup checklist shown on the dashboard');
  } finally {
    await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 15000))]);
  }

  report.start('Workspace created');
  const { data: settings } = await admin.from('app_settings').select('company_name, workspace_name, workspace_slug, company_phone, registered_at, registered_by, terms_version, terms_accepted_at').eq('id', true).single();
  report.record('WS-settings', settings.company_name === valid.companyName && settings.workspace_slug === 'e2e-workspace' && settings.company_phone === '+919876543210' && !!settings.registered_at && !!settings.terms_accepted_at,
    `${settings.workspace_name} /${settings.workspace_slug}, phone ${settings.company_phone}, terms ${settings.terms_version}`);
  const { data: profile } = await admin.from('user_profiles').select('id, name, phone, is_superadmin, is_active').eq('email', MANAGER.email).single();
  report.record('WS-manager', profile?.is_superadmin === true && profile?.is_active !== false && profile?.phone === '+919876543210' && settings.registered_by === profile?.id, `manager ${profile?.name}, superadmin=${profile?.is_superadmin}`);
  const { data: roles } = await admin.from('user_roles').select('roles!user_roles_role_id_fkey(name)').eq('user_id', profile.id);
  report.record('WS-role', (roles || []).some((r) => (Array.isArray(r.roles) ? r.roles[0] : r.roles)?.name === 'Superadmin'), 'Superadmin role assigned');
  const s = await signIn(env, MANAGER.email, MANAGER.password);
  report.status('WS-manager-api', await call(env, s, 'GET', '/api/manager/overview'), 200, 'manager can use the Manager portal APIs');
  const ws = await call(env, s, 'GET', '/e2e-workspace');
  report.record('WS-url', [302, 303, 307, 308].includes(ws.status) && (ws.headers.get('location') || '').endsWith('/'), `GET /e2e-workspace → ${ws.status} ${ws.headers.get('location')}`);
  report.status('WS-url-unknown', await call(env, s, 'GET', '/someoneelse'), 404);

  report.start('Registration is now closed');
  const again = await post({ ...valid, email: `second.${RUN}@example.com`, workspaceSlug: 'another' });
  report.record('REG-closed', again.status === 409 && again.body?.code === 'REGISTRATION_CLOSED', `status ${again.status}: ${again.body?.error}`);
  const dup = await post(valid);
  report.record('REG-duplicate', dup.status === 409, `same company again → ${dup.status}`);
  const st2 = await call(env, null, 'GET', '/api/register');
  report.record('REG-status-closed', st2.body?.data?.open === false && st2.body?.data?.companyName === 'E2E Workspace' && st2.body?.data?.reason === 'registered', `open=${st2.body?.data?.open}, shows "${st2.body?.data?.companyName}"`);
  const selfSignup = await fetch(`${env.url}/auth/v1/signup`, { method: 'POST', headers: { apikey: env.anon, 'content-type': 'application/json' }, body: JSON.stringify({ email: `self.${RUN}@example.com`, password: 'Selfsign123' }) });
  report.record('REG-no-self-signup', selfSignup.status === 422 || selfSignup.status === 403, `Supabase self sign-up → ${selfSignup.status}`);
  report.status('REG-old-setup-gone', await call(env, null, 'POST', '/api/onboarding/complete-setup', {}), 410);
  const { count: users } = await admin.from('user_profiles').select('id', { count: 'exact', head: true });
  report.record('REG-one-user', users === 1, `${users} user(s) after the refused attempts`);

  report.start('Onboarding checklist');
  const ob = async () => (await call(env, s, 'GET', '/api/manager/onboarding')).body?.data;
  let o = await ob();
  const step = (k) => o.steps.find((x) => x.key === k);
  report.record('OB-initial', o.visible && step('company').done && !step('employees').done && !step('project').done && o.completed === 1, `${o.completed}/${o.total} done; company profile done from registration`);
  o = (await call(env, s, 'POST', '/api/manager/onboarding', { action: 'skip', step: 'departments' })).body?.data;
  report.record('OB-skip', step('departments').skipped === true, 'departments skipped');
  await call(env, s, 'PATCH', '/api/settings', { timezone: 'Asia/Kolkata', currency: 'INR' });
  const { data: empRole } = await admin.from('roles').select('id').eq('name', 'Employee').single();
  await call(env, s, 'POST', '/api/invitations', { email: `first.hire.${RUN}@example.com`, name: 'First Hire', roleId: empRole.id, send_email: false });
  o = await ob();
  report.record('OB-progress', step('settings').done && step('employees').done && o.completed === 3, `${o.completed}/${o.total} after saving settings and inviting an employee`);
  o = (await call(env, s, 'POST', '/api/manager/onboarding', { action: 'dismiss' })).body?.data;
  report.record('OB-dismiss', o.dismissed === true, 'checklist hidden');
  o = (await call(env, s, 'POST', '/api/manager/onboarding', { action: 'reopen' })).body?.data;
  report.record('OB-reopen', o.dismissed === false, 'checklist shown again');

  report.start('Restore the E2E test users');
  await seed({ quiet: true });
  report.record('SEED', true, 'test users re-created');
  const pm = await signIn(env, 'e2e.pm@example.com');
  report.record('OB-not-for-managers', (await call(env, pm, 'GET', '/api/manager/onboarding')).body?.data?.visible === false, 'a project manager does not get the workspace checklist');
  report.status('OB-manager-cannot-change', await call(env, pm, 'POST', '/api/manager/onboarding', { action: 'dismiss' }), 403);
  o = await ob();
  report.record('OB-from-real-data', step('project').done && step('team').done && step('clients').done, `projects, teams and clients created elsewhere count: ${o.completed}/${o.total}`);
}

main().catch((e) => report.error('UNCAUGHT', e)).finally(() => process.exit(report.summary() ? 1 : 0));
