// Invitation links opened in a browser where someone else (the manager) is already signed in.
//
// Reported: the manager sent an employee invitation, opened the link in the same browser, set the
// password, and ended up in the MANAGER portal, because accepting did not sign the new person in and
// /login then reused the manager's session. Now accepting signs this browser in as the new person and
// opens their own portal; the page warns first; and /login?email=<someone else> shows the login form.
//
// NON-DESTRUCTIVE: does not reset or seed anything. It creates its own temporary @example.com
// accounts, invitations and client account, and deletes them at the end. Local Supabase only.
//
// Usage: node tests/local-e2e/invite-same-browser.mjs   (app running on port 3100)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { loadEnv, adminClient, Report, ROOT, chromePath } from './lib.mjs';

const env = loadEnv(); // throws unless local
const admin = adminClient(env);
const report = new Report('Invitation opened where another account is signed in');
const OUT = path.join(ROOT, 'tests', 'local-e2e', 'output');
fs.mkdirSync(OUT, { recursive: true });
const RUN = Date.now().toString(36);
const MGR = { email: `inv.mgr.${RUN}@example.com`, password: 'Manager2026x', name: 'E2E Temp Manager' };
const EMP = { email: `inv.emp.${RUN}@example.com`, password: 'Employee2026x', name: 'E2E Temp Employee' };
const CLI = { email: `inv.cli.${RUN}@example.com`, password: 'Client2026xy', name: 'E2E Temp Client' };
const made = { users: [], invitations: [], clientInvitations: [], accounts: [] };
const pathOf = (page) => new URL(page.url()).pathname;
const EMPLOYEE_PORTAL = ['/dashboard']; // no first-time tutorial: a new employee stays on their dashboard

async function counts() {
  const { count: profiles } = await admin.from('user_profiles').select('id', { count: 'exact', head: true });
  const { count: invites } = await admin.from('user_invitations').select('id', { count: 'exact', head: true });
  return { profiles, invites };
}
const profileFromPage = (page) => page.evaluate(async () => {
  const r = await fetch('/api/profile', { cache: 'no-store' });
  return { status: r.status, email: (await r.json().catch(() => null))?.profile?.email ?? null };
});
async function loginUI(page, who) {
  await page.goto(`${env.appUrl}/login?email=${encodeURIComponent(who.email)}`, { waitUntil: 'load' });
  await page.waitForSelector('#email', { timeout: 30000 });
  await page.fill('#email', who.email);
  await page.fill('#password', who.password);
  await page.click('button[type="submit"]');
}
const waitFor = (page, test, timeout = 45000) => page.waitForURL((u) => test(u.pathname), { timeout }).then(() => true).catch(() => false);

async function setup() {
  const roleId = async (name) => (await admin.from('roles').select('id').eq('name', name).single()).data.id;
  const { data: m, error } = await admin.auth.admin.createUser({ email: MGR.email, password: MGR.password, email_confirm: true, user_metadata: { name: MGR.name } });
  if (error) throw error;
  made.users.push(m.user.id);
  await admin.from('user_profiles').update({ name: MGR.name, has_completed_onboarding: true }).eq('id', m.user.id);
  const { error: rErr } = await admin.from('user_roles').insert({ user_id: m.user.id, role_id: await roleId('Project Manager') });
  if (rErr) throw rErr;
  const expires = new Date(Date.now() + 86400000).toISOString();
  const empToken = crypto.randomBytes(32).toString('hex');
  const { data: inv, error: iErr } = await admin.from('user_invitations').insert({
    email: EMP.email, name: EMP.name, role_id: await roleId('Employee'), invited_by: m.user.id, token: empToken, expires_at: expires, status: 'pending',
  }).select('id').single();
  if (iErr) throw iErr;
  made.invitations.push(inv.id);
  const { data: acct, error: aErr } = await admin.from('accounts').insert({ name: `E2E Temp Client Co ${RUN}` }).select('id').single();
  if (aErr) throw aErr;
  made.accounts.push(acct.id);
  const cliToken = crypto.randomBytes(32).toString('hex');
  const { data: cinv, error: cErr } = await admin.from('client_portal_invitations').insert({
    account_id: acct.id, email: CLI.email, token: cliToken, invited_by: m.user.id, expires_at: expires, status: 'pending',
  }).select('id').single();
  if (cErr) throw cErr;
  made.clientInvitations.push(cinv.id);
  return { empToken, cliToken };
}

// Order matters (foreign keys): the invited people's profiles point at their invitation and at the
// manager; the invitations point at the manager; the client points at the account.
async function cleanup() {
  const problems = [];
  const note = (what, error) => { if (error) problems.push(`${what}: ${error.message}`); };
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  for (const u of (data?.users || []).filter((x) => [EMP.email, CLI.email].includes(x.email))) note(`user ${u.email}`, (await admin.auth.admin.deleteUser(u.id)).error);
  for (const id of made.invitations) note('invitation', (await admin.from('user_invitations').delete().eq('id', id)).error);
  for (const id of made.clientInvitations) note('client invitation', (await admin.from('client_portal_invitations').delete().eq('id', id)).error);
  for (const id of made.users) note(`user ${id}`, (await admin.auth.admin.deleteUser(id)).error);
  for (const id of made.accounts) note('account', (await admin.from('accounts').delete().eq('id', id)).error);
  for (const p of problems) console.error(`  cleanup: ${p}`);
}

async function main() {
  const before = await counts();
  const { empToken, cliToken } = await setup();
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    const route = [];
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) route.push(new URL(f.url()).pathname); });

    report.start('The manager is signed in and opens the employee invitation in the same browser');
    await loginUI(page, MGR);
    report.record('SETUP-manager-signed-in', await waitFor(page, (p) => p === '/manager'), `manager login → ${pathOf(page)}`);
    await page.goto(`${env.appUrl}/invite/${empToken}`, { waitUntil: 'load' });
    await page.waitForSelector('#invite-password', { timeout: 30000 });
    const warning = page.getByText('This browser is signed in as', { exact: false });
    report.record('EMP-warning', await warning.isVisible() && (await warning.innerText()).includes(MGR.email), 'the page says who is signed in and that they will be signed out here');
    await page.fill('#invite-password', EMP.password);
    await page.fill('#invite-confirm-password', EMP.password);
    route.length = 0;
    await page.getByRole('button', { name: 'Create Account' }).click();
    const empLanded = await waitFor(page, (p) => EMPLOYEE_PORTAL.includes(p));
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.screenshot({ path: path.join(OUT, 'invite-same-browser-employee.png') }).catch(() => {});
    report.record('EMP-lands-employee-portal', empLanded && !route.includes('/manager'), `after Create Account: ${[...new Set(route)].join(' → ')}`);
    const empMe = await profileFromPage(page);
    report.record('EMP-signed-in-as-employee', empMe.status === 200 && empMe.email === EMP.email, `this browser is now ${empMe.email}`);
    await page.waitForTimeout(3000);
    const body = await page.locator('body').innerText();
    report.record('EMP-no-tutorial', pathOf(page) === '/dashboard' && !/Follow the tutorial|Step d+ of d+/i.test(body), `after 3 s still on ${pathOf(page)}, no tutorial shown`);
    await page.goto(`${env.appUrl}/manager`, { waitUntil: 'load' });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    report.record('EMP-no-manager-portal', !/Set up your workspace|Active projects/.test(await page.locator('body').innerText()), `employee opens /manager → ${pathOf(page)} (no manager content)`);

    report.start('/login?email=<someone else> while signed in');
    await page.goto(`${env.appUrl}/login?email=${encodeURIComponent(MGR.email)}`, { waitUntil: 'load' });
    const formShown = await page.waitForSelector('#email', { timeout: 30000 }).then(() => true).catch(() => false);
    report.record('LOGIN-other-email-shows-form', formShown && pathOf(page) === '/login' && (await page.inputValue('#email')) === MGR.email, `stays on ${pathOf(page)} with ${formShown ? await page.inputValue('#email') : 'no form'}`);
    await page.fill('#password', MGR.password);
    await page.click('button[type="submit"]');
    report.record('LOGIN-manager-back', await waitFor(page, (p) => p === '/manager'), `manager signs in again → ${pathOf(page)}`);

    report.start('The manager opens the client invitation in the same browser');
    await page.goto(`${env.appUrl}/client-invite/${cliToken}`, { waitUntil: 'load' });
    await page.waitForSelector('#client-password', { timeout: 30000 });
    report.record('CLI-warning', await page.getByText('This browser is signed in as', { exact: false }).isVisible(), 'warning shown');
    await page.fill('#client-name', CLI.name);
    await page.fill('#client-password', CLI.password);
    await page.fill('#client-confirm-password', CLI.password);
    route.length = 0;
    await page.getByRole('button', { name: /Create Account|Accept/ }).first().click();
    const cliLanded = await waitFor(page, (p) => p.startsWith('/client-portal'));
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.screenshot({ path: path.join(OUT, 'invite-same-browser-client.png') }).catch(() => {});
    report.record('CLI-lands-client-portal', cliLanded && !route.includes('/manager'), `after Create Account: ${[...new Set(route)].join(' → ')}`);
    const cliMe = await profileFromPage(page);
    report.record('CLI-signed-in-as-client', cliMe.status === 200 && cliMe.email === CLI.email, `this browser is now ${cliMe.email}`);

    report.start('A fresh browser (the employee on their own device)');
    const fresh = await (await browser.newContext()).newPage();
    await loginUI(fresh, EMP);
    report.record('EMP-login-own-device', await waitFor(fresh, (p) => EMPLOYEE_PORTAL.includes(p)), `employee login → ${pathOf(fresh)}`);
  } finally {
    await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 15000))]);
    await cleanup();
    const after = await counts();
    report.record('CLEANUP', after.profiles === before.profiles && after.invites === before.invites, `profiles ${before.profiles} → ${after.profiles}, invitations ${before.invites} → ${after.invites}`);
  }
}

main().catch((e) => report.error('UNCAUGHT', e)).finally(() => process.exit(report.summary() ? 1 : 0));
