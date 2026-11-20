// The whole onboarding journey in a real browser, on a brand-new LOCAL installation (tests A–G):
//   A fresh install → company registration → auto sign-in → Manager dashboard
//   B logout and login again (wrong password refused with a clear message)
//   C session survives reload, other Manager routes, /login and /signup while signed in
//   D duplicate / concurrent / abandoned registrations
//   E employee invitation → accept in the browser → employee portal only
//   F client invitation → accept in the browser → client portal with only their shared projects
//   G security: anonymous, wrong portal, APIs, self sign-up, forged cookie, suspended account
//
// DESTRUCTIVE FOR THE LOCAL DATABASE ONLY (resets it twice). Refuses unless the Supabase URL is
// local and you pass --reset-local-db; refuses to delete non-test accounts unless you also pass
// --wipe-local-accounts. Uses only @example.com test accounts and a "E2E Test Company" workspace.
// At the end it re-creates the standard E2E test users (seed.mjs).
//
// Usage: node tests/local-e2e/onboarding-browser.mjs --reset-local-db   (app running on port 3100)
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { loadEnv, adminClient, call, signIn, Report, ROOT, resetLocalDb, chromePath, COOKIE_NAME, isoDate, addDays } from './lib.mjs';
import { seed } from './seed.mjs';

if (!process.argv.includes('--reset-local-db')) {
  console.error('This test resets the LOCAL Supabase database. Re-run with --reset-local-db to confirm.');
  process.exit(2);
}
const env = loadEnv();
const report = new Report('Onboarding journey (browser)');
const OUT = path.join(ROOT, 'tests', 'local-e2e', 'output');
fs.mkdirSync(OUT, { recursive: true });
const RUN = Date.now().toString(36);
const MANAGER = { email: `owner.${RUN}@example.com`, password: 'Workspace2026', name: 'E2E Owner' };
const COMPANY = { companyName: 'E2E Test Company', workspaceName: 'E2E Workspace', workspaceSlug: 'e2e-workspace', phone: '+91 98765 43210' };
const EMPLOYEE = { email: `emp.${RUN}@example.com`, password: 'Employee2026', name: 'E2E New Employee' };
const CLIENT = { email: `client.${RUN}@example.com`, password: 'Client2026x', name: 'E2E New Client' };
const admin = adminClient(env);
const path_ = (page) => new URL(page.url()).pathname;
const text = (page) => page.locator('body').innerText().catch(() => '');
const settle = (page) => page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `onboarding-${name}.png`) }).catch(() => {});
const counts = async () => {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const { count } = await admin.from('user_profiles').select('id', { count: 'exact', head: true });
  return { auth: (data?.users || []).length, profiles: count ?? 0 };
};
const register = (body) => call(env, null, 'POST', '/api/register', body);
const validBody = (tag) => ({ ...COMPANY, workspaceSlug: `ws-${tag}`, name: `Racer ${tag}`, email: `racer.${tag}.${RUN}@example.com`, password: 'Workspace2026', acceptTerms: true });

/** fetch() inside the page: uses the browser's own session cookie. */
const apiIn = (page, method, url, body) => page.evaluate(async ([m, u, b]) => {
  const r = await fetch(u, { method: m, headers: b ? { 'Content-Type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined });
  let j = null; try { j = await r.json(); } catch { /* not JSON */ }
  return { status: r.status, body: j };
}, [method, url, body]);

async function loginUI(page, email, password) {
  await page.goto(`${env.appUrl}/login`, { waitUntil: 'load' });
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('button[type="submit"]');
}
const waitPath = (page, test, timeout = 30000) => page.waitForURL((u) => test(u.pathname), { timeout }).then(() => true).catch(() => false);

async function main() {
  // ================================================================ D (part 1): concurrency and abandoned claims
  report.start('D. Concurrent and abandoned registrations (fresh installation)');
  await resetLocalDb(env);
  let st = await call(env, null, 'GET', '/api/register');
  report.record('D-fresh-open', st.body?.data?.open === true && st.body?.data?.reason === 'new', `open=${st.body?.data?.open} reason=${st.body?.data?.reason}`);
  const fr = await call(env, null, 'GET', '/api/onboarding/check-first-run');
  report.record('D-first-run-agrees', fr.body?.firstRun === true, `check-first-run says firstRun=${fr.body?.firstRun}`);

  await admin.from('app_settings').update({ registered_at: new Date().toISOString(), registered_by: null }).eq('id', true);
  st = await call(env, null, 'GET', '/api/register');
  const busy = await register(validBody('busy'));
  report.record('D-in-progress', st.body?.data?.reason === 'in_progress' && busy.status === 409 && busy.body?.reason === 'in_progress',
    `fresh claim → open=${st.body?.data?.open} reason=${st.body?.data?.reason}; POST ${busy.status}: ${busy.body?.error}`);
  await admin.from('app_settings').update({ registered_at: new Date(Date.now() - 10 * 60000).toISOString() }).eq('id', true);
  st = await call(env, null, 'GET', '/api/register');
  report.record('D-abandoned-reopens', st.body?.data?.open === true && st.body?.data?.reason === 'abandoned', `claim 10 min old, no manager → open=${st.body?.data?.open} reason=${st.body?.data?.reason}`);

  const race = await Promise.all(['r1', 'r2', 'r3', 'r4'].map((t) => register(validBody(t))));
  const won = race.filter((r) => r.status === 201).length;
  const c1 = await counts();
  const { data: s1 } = await admin.from('app_settings').select('registered_by').eq('id', true).single();
  report.record('D-race-one-winner', won === 1 && race.every((r) => r.status === 201 || r.status === 409) && c1.auth === 1 && c1.profiles === 1 && !!s1.registered_by,
    `4 simultaneous registrations → ${race.map((r) => r.status).join(', ')}; auth users ${c1.auth}, profiles ${c1.profiles}`);

  // ================================================================ A: fresh install, register in the browser
  report.start('A. Fresh installation: register in the browser');
  await resetLocalDb(env);
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const route = [];
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) route.push(new URL(f.url()).pathname); });
    let registerPosts = 0;
    page.on('request', (r) => { if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/register') registerPosts++; });

    await page.goto(`${env.appUrl}/`, { waitUntil: 'load', timeout: 120000 });
    const onSignup = await waitPath(page, (p) => p === '/signup');
    await page.waitForSelector('#companyName', { timeout: 30000 }).catch(() => {});
    report.record('A-first-run-to-signup', onSignup && await page.locator('#companyName').isVisible(), `/ → ${path_(page)}`);

    await page.fill('#companyName', COMPANY.companyName);
    await page.fill('#workspaceName', COMPANY.workspaceName);
    await page.fill('#workspaceSlug', COMPANY.workspaceSlug);
    await page.fill('#name', MANAGER.name);
    await page.fill('#email', MANAGER.email);
    await page.fill('#password', MANAGER.password);
    await page.fill('#phone', COMPANY.phone);
    await page.check('input[type="checkbox"]');
    // Double-click on purpose: only one registration may be sent
    await page.locator('button[type="submit"]').dblclick();
    const landed = await waitPath(page, (p) => p.startsWith('/manager'), 60000);
    await settle(page);
    await shot(page, 'A-manager');
    const chain = [...new Set(route)];
    report.record('A-lands-on-manager', landed && path_(page) === '/manager' && !route.includes('/login'), `route ${chain.join(' → ')}`);
    report.record('A-one-request', registerPosts === 1, `${registerPosts} POST /api/register for a double click`);
    const cookies = await ctx.cookies();
    report.record('A-session-cookie', cookies.some((c) => c.name.startsWith(COOKIE_NAME)), `cookies: ${cookies.map((c) => c.name).join(', ')}`);
    const dash = await text(page);
    report.record('A-dashboard', /Set up your workspace/.test(dash) && !/Something went wrong|Application error/i.test(dash), 'Manager dashboard with the setup checklist');

    const { data: ws } = await admin.from('app_settings').select('company_name, workspace_name, workspace_slug, registered_at, registered_by, terms_accepted_at').eq('id', true).single();
    const { data: prof } = await admin.from('user_profiles').select('id, email, is_superadmin, is_active, has_completed_onboarding').eq('email', MANAGER.email).maybeSingle();
    const { data: roles } = await admin.from('user_roles').select('roles!user_roles_role_id_fkey(name)').eq('user_id', prof?.id);
    const { data: au } = await admin.auth.admin.getUserById(prof?.id);
    const c2 = await counts();
    report.record('A-workspace-linked', ws.workspace_slug === COMPANY.workspaceSlug && ws.registered_by === prof?.id && !!ws.terms_accepted_at,
      `${ws.workspace_name} /${ws.workspace_slug}, registered_by is the manager: ${ws.registered_by === prof?.id}`);
    report.record('A-manager-account', prof?.is_superadmin === true && prof?.is_active !== false && !!au?.user?.email_confirmed_at
      && (roles || []).some((r) => (Array.isArray(r.roles) ? r.roles[0] : r.roles)?.name === 'Superadmin'),
      `superadmin=${prof?.is_superadmin}, confirmed=${!!au?.user?.email_confirmed_at}, roles=${(roles || []).map((r) => (Array.isArray(r.roles) ? r.roles[0] : r.roles)?.name).join(',')}`);
    report.record('A-no-duplicates', c2.auth === 1 && c2.profiles === 1, `auth users ${c2.auth}, profiles ${c2.profiles}`);

    // ================================================================ C: session persistence
    report.start('C. Session survives reload and navigation');
    await page.reload({ waitUntil: 'load' });
    await settle(page);
    report.record('C-reload', path_(page) === '/manager' && /Set up your workspace/.test(await text(page)), `after reload: ${path_(page)}`);
    for (const p of ['/manager/team', '/manager/approvals', '/projects', '/admin/settings']) {
      await page.goto(env.appUrl + p, { waitUntil: 'load' });
      await settle(page);
      report.record(`C-route ${p}`, path_(page) === p && !/Login to your account/.test(await text(page)), `opened ${p} → ${path_(page)}`);
    }
    await page.goto(`${env.appUrl}/login`, { waitUntil: 'load' });
    report.record('C-login-when-signed-in', await waitPath(page, (p) => p === '/manager'), `/login → ${path_(page)}`);
    await page.goto(`${env.appUrl}/signup`, { waitUntil: 'load' });
    report.record('C-signup-when-signed-in', await waitPath(page, (p) => p === '/manager'), `/signup → ${path_(page)}`);
    const tab2 = await ctx.newPage();
    await tab2.goto(`${env.appUrl}/manager`, { waitUntil: 'load' });
    await settle(tab2);
    report.record('C-new-tab', path_(tab2) === '/manager', `second tab → ${path_(tab2)}`);
    await tab2.close();
    const me = await apiIn(page, 'GET', '/api/profile');
    report.record('C-api-session', me.status === 200 && me.body?.profile?.email === MANAGER.email, `GET /api/profile from the page → ${me.status}`);

    // ================================================================ E/F setup (as the manager, from the browser)
    const acct = await apiIn(page, 'POST', '/api/accounts', { name: `E2E Client Co ${RUN}`, status: 'active' });
    const other = await apiIn(page, 'POST', '/api/accounts', { name: `E2E Other Co ${RUN}`, status: 'active' });
    const acctId = acct.body?.account?.id || acct.body?.data?.id || acct.body?.id;
    const otherId = other.body?.account?.id || other.body?.data?.id || other.body?.id;
    const mkProject = async (name, accountId, shared) => {
      const r = await apiIn(page, 'POST', '/api/projects', { name, accountId, start_date: isoDate(), end_date: isoDate(addDays(30)), status: 'planning' });
      const id = r.body?.project?.id || r.body?.data?.id || r.body?.id;
      // New projects are shared with the client by default (column default true): set it explicitly
      if (id) await apiIn(page, 'PATCH', `/api/projects/${id}`, { shared_with_client: shared });
      return id;
    };
    const P1 = await mkProject(`E2E Shared Project ${RUN}`, acctId, true);
    const P2 = await mkProject(`E2E Internal Project ${RUN}`, acctId, false);
    const P3 = await mkProject(`E2E Other Client Project ${RUN}`, otherId, true);
    report.record('EF-setup', !!(acctId && otherId && P1 && P2 && P3), `accounts ${acct.status}/${other.status}; projects ${[P1, P2, P3].filter(Boolean).length}/3`);

    // ================================================================ E: employee invitation
    report.start('E. Employee invitation');
    const { data: empRole } = await admin.from('roles').select('id').eq('name', 'Employee').single();
    const inv = await apiIn(page, 'POST', '/api/invitations', { email: EMPLOYEE.email, name: EMPLOYEE.name, roleId: empRole.id, send_email: false, projectIds: [P1], phone: '+91 90000 00009' });
    const empToken = inv.body?.invitation?.token;
    report.record('E-invite', inv.status === 201 && !!empToken && /wa\.me/.test(inv.body?.whatsappUrl || ''), `status ${inv.status}, WhatsApp link ${!!inv.body?.whatsappUrl}`);

    const ectx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const ep = await ectx.newPage();
    await ep.goto(`${env.appUrl}/invite/${empToken}`, { waitUntil: 'load' });
    await ep.waitForSelector('#invite-password', { timeout: 30000 }).catch(() => {});
    await ep.fill('#invite-password', EMPLOYEE.password);
    await ep.fill('#invite-confirm-password', EMPLOYEE.password);
    await ep.locator('button:not([disabled])', { hasText: /accept|create|join/i }).first().click();
    // Accepting signs the new employee in and opens their portal (a brand-new employee may be moved to the tutorial)
    const accepted = await waitPath(ep, (p) => ['/dashboard', '/welcome'].includes(p), 45000);
    report.record('E-accept-in-browser', accepted, `invitation accepted → signed in automatically → ${path_(ep)}`);
    await ectx.clearCookies(); // sign out, then prove the chosen password works on the login page
    await loginUI(ep, EMPLOYEE.email, EMPLOYEE.password);
    const empLanded = await waitPath(ep, (p) => p === '/dashboard', 45000);
    await settle(ep);
    await shot(ep, 'E-employee');
    report.record('E-login-lands-dashboard', empLanded, `employee login → ${path_(ep)}`);
    // The server-rendered /manager page must be the refusal. (In the browser a brand-new employee is then
    // moved to the first-time tutorial on /welcome by the existing tutorial; either way no manager content.)
    const mgrHtml = await ep.evaluate(async () => { const r = await fetch('/manager'); return { status: r.status, html: await r.text() }; });
    await ep.goto(`${env.appUrl}/manager`, { waitUntil: 'load' });
    await settle(ep);
    const mgrText = await text(ep);
    report.record('E-no-manager-portal', /You need a manager role/.test(mgrHtml.html) && !/Set up your workspace|Active projects/.test(mgrText),
      `server answers /manager with the refusal; browser ends on ${path_(ep)}`);
    await ep.goto(`${env.appUrl}/client-portal`, { waitUntil: 'load' });
    report.record('E-no-client-portal', await waitPath(ep, (p) => p === '/dashboard'), `employee opens /client-portal → ${path_(ep)}`);
    const eProj = await apiIn(ep, 'GET', `/api/projects/${P1}`);
    const eMgr = await apiIn(ep, 'GET', '/api/manager/overview');
    report.record('E-project-access', eProj.status === 200, `assigned project at invite time → ${eProj.status}`);
    report.record('E-manager-api-refused', eMgr.status === 403, `GET /api/manager/overview → ${eMgr.status}`);
    const { data: eRow } = await admin.from('user_invitations').select('status').eq('token', empToken).single();
    report.record('E-invitation-used', eRow?.status === 'accepted', `invitation status ${eRow?.status}`);

    // ================================================================ F: client invitation
    report.start('F. Client invitation');
    const cinv = await apiIn(page, 'POST', `/api/accounts/${acctId}/invite-client`, { account_id: acctId, email: CLIENT.email, expires_in_days: 7 });
    const clientToken = cinv.body?.invitation?.token || (cinv.body?.acceptUrl || '').split('/').pop();
    report.record('F-invite', cinv.status === 201 && !!clientToken, `status ${cinv.status}`);
    const cctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const cp = await cctx.newPage();
    await cp.goto(`${env.appUrl}/client-invite/${clientToken}`, { waitUntil: 'load' });
    await cp.waitForSelector('#client-password', { timeout: 30000 }).catch(() => {});
    await cp.fill('#client-name', CLIENT.name);
    await cp.fill('#client-position', 'Head of Marketing');
    await cp.fill('#client-password', CLIENT.password);
    await cp.fill('#client-confirm-password', CLIENT.password);
    await cp.locator('button:not([disabled])', { hasText: /accept|create|join/i }).first().click();
    // Accepting signs the new client in and opens the client portal
    report.record('F-accept-in-browser', await waitPath(cp, (p) => p.startsWith('/client-portal'), 45000), `client invitation accepted → signed in automatically → ${path_(cp)}`);
    await cctx.clearCookies(); // sign out, then prove the chosen password works on the login page
    await loginUI(cp, CLIENT.email, CLIENT.password);
    const cLanded = await waitPath(cp, (p) => p.startsWith('/client-portal'), 45000);
    await settle(cp);
    await shot(cp, 'F-client');
    report.record('F-login-lands-portal', cLanded, `client login → ${path_(cp)}`);
    const cList = await apiIn(cp, 'GET', '/api/client/portal/projects');
    const listed = JSON.stringify(cList.body || '');
    report.record('F-sees-own-shared-project', cList.status === 200 && listed.includes(P1) && !listed.includes(P2) && !listed.includes(P3),
      `shared project listed=${listed.includes(P1)}, internal=${listed.includes(P2)}, other client's=${listed.includes(P3)}`);
    const portalText = await text(cp);
    report.record('F-portal-page', !/Something went wrong|Application error/i.test(portalText), 'client portal renders');
    await cp.goto(`${env.appUrl}/manager`, { waitUntil: 'load' });
    report.record('F-no-manager-portal', await waitPath(cp, (p) => p.startsWith('/client-portal')), `client opens /manager → ${path_(cp)}`);
    await cp.goto(`${env.appUrl}/dashboard`, { waitUntil: 'load' });
    await settle(cp);
    report.record('F-no-employee-portal', path_(cp).startsWith('/client-portal'), `client opens /dashboard → ${path_(cp)}`);
    const cApi = await apiIn(cp, 'GET', `/api/projects/${P2}`);
    report.record('F-internal-api-refused', [401, 403, 404].includes(cApi.status), `client reads an internal project → ${cApi.status}`);

    // ================================================================ D (part 2): duplicate company after registration
    report.start('D. Duplicate company after registration');
    const anon = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const ap = await anon.newPage();
    await ap.goto(`${env.appUrl}/signup`, { waitUntil: 'load' });
    await ap.getByText('E2E Workspace is already set up').waitFor({ timeout: 30000 }).catch(() => {});
    await shot(ap, 'D-closed');
    report.record('D-signup-closed', await ap.getByText('E2E Workspace is already set up').isVisible() && !(await ap.locator('#companyName').count()), 'closed message names the workspace; no form');
    const before = await counts();
    const dup = await register({ ...validBody('dup'), email: `dup.${RUN}@example.com` });
    const after = await counts();
    report.record('D-duplicate-refused', dup.status === 409 && dup.body?.reason === 'registered' && after.auth === before.auth, `POST ${dup.status}: ${dup.body?.error}; accounts ${before.auth} → ${after.auth}`);
    const sameEmail = await register({ ...validBody('dupe2'), email: MANAGER.email });
    report.record('D-same-manager-again', sameEmail.status === 409, `same manager registers again → ${sameEmail.status}`);
    await ap.goto(`${env.appUrl}/`, { waitUntil: 'load' });
    await settle(ap);
    report.record('D-no-first-run-loop', path_(ap) === '/' && /Login to your account/.test(await text(ap)), `/ for a visitor → ${path_(ap)} with the login form`);

    // ================================================================ B: logout and login
    report.start('B. Logout and login again');
    await page.goto(`${env.appUrl}/manager`, { waitUntil: 'load' });
    await settle(page);
    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByText('Sign out', { exact: true }).click();
    report.record('B-logout', await waitPath(page, (p) => p === '/login'), `after sign out → ${path_(page)}`);
    await page.goto(`${env.appUrl}/manager`, { waitUntil: 'load' });
    report.record('B-manager-needs-login', await waitPath(page, (p) => p === '/login'), `/manager after logout → ${path_(page)}`);
    await loginUI(page, MANAGER.email, 'WrongPassword1');
    const wrong = await page.getByText('Invalid email or password').waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
    report.record('B-wrong-password', wrong && path_(page) === '/login', 'clear "Invalid email or password" message, still on /login');
    await loginUI(page, MANAGER.email, MANAGER.password);
    report.record('B-login-lands-manager', await waitPath(page, (p) => p === '/manager', 45000), `manager login → ${path_(page)}`);
    await settle(page);
    await page.reload({ waitUntil: 'load' });
    await settle(page);
    report.record('B-session-after-login-reload', path_(page) === '/manager', `reload → ${path_(page)}`);

    // ================================================================ G: security
    report.start('G. Security');
    await ap.goto(`${env.appUrl}/manager`, { waitUntil: 'load' });
    report.record('G-anon-manager', await waitPath(ap, (p) => p === '/login'), `visitor opens /manager → ${path_(ap)}`);
    report.status('G-anon-api', await call(env, null, 'GET', '/api/manager/overview'), 401);
    const selfSignup = await fetch(`${env.url}/auth/v1/signup`, { method: 'POST', headers: { apikey: env.anon, 'content-type': 'application/json' }, body: JSON.stringify({ email: `self.${RUN}@example.com`, password: 'Selfsign123' }) });
    report.record('G-no-self-signup', [403, 422].includes(selfSignup.status), `Supabase self sign-up → ${selfSignup.status}`);
    const forged = await browser.newContext();
    await forged.addCookies([{ name: COOKIE_NAME, value: 'base64-eyJmb3JnZWQiOnRydWV9', url: env.appUrl }]);
    const fp = await forged.newPage();
    await fp.goto(`${env.appUrl}/manager`, { waitUntil: 'load' });
    report.record('G-forged-cookie', await waitPath(fp, (p) => p === '/login'), `forged session cookie → ${path_(fp)}`);
    const emp = await signIn(env, EMPLOYEE.email, EMPLOYEE.password);
    const { data: superRole } = await admin.from('roles').select('id').eq('name', 'Superadmin').single();
    const { error: escErr } = await emp.db.from('user_roles').insert({ user_id: emp.userId, role_id: superRole.id });
    const { data: empRoles } = await admin.from('user_roles').select('role_id').eq('user_id', emp.userId);
    report.record('G-no-self-superadmin', !!escErr && !(empRoles || []).some((r) => r.role_id === superRole.id), `employee grants self Superadmin → ${escErr?.code || 'allowed!'}`);
    const { error: profErr } = await emp.db.from('user_profiles').update({ is_superadmin: true }).eq('id', emp.userId);
    const { data: empProf } = await admin.from('user_profiles').select('is_superadmin').eq('id', emp.userId).single();
    report.record('G-no-self-superadmin-flag', empProf?.is_superadmin !== true, `employee sets is_superadmin → ${profErr?.code || 'ignored'}; still ${empProf?.is_superadmin}`);
    const empId = emp.userId;
    const until = new Date(Date.now() + 2 * 86400000).toISOString();
    const sus = await apiIn(page, 'POST', `/api/users/${empId}/status`, { action: 'suspend', reason: 'E2E check', until });
    const sctx = await browser.newContext();
    const sp = await sctx.newPage();
    await loginUI(sp, EMPLOYEE.email, EMPLOYEE.password);
    const susMsg = await sp.getByText('This account is suspended or deactivated').waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
    report.record('G-suspended-login', sus.status === 200 && susMsg && path_(sp) === '/login', `suspend ${sus.status}; login shows the suspension message`);
    await apiIn(page, 'POST', `/api/users/${empId}/status`, { action: 'activate' });
    const reg = await register(validBody('late'));
    report.record('G-registration-closed', reg.status === 409, `registration after setup → ${reg.status}`);
  } finally {
    await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 15000))]);
  }

  report.start('Restore the E2E test users');
  await seed({ quiet: true });
  report.record('SEED', true, 'standard test users re-created');
}

main().catch((e) => report.error('UNCAUGHT', e)).finally(() => process.exit(report.summary() ? 1 : 0));
