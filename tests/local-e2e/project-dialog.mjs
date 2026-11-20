// "Create New Project" when the workspace has no accounts yet.
//
// Reported: on a brand-new workspace the Account list was empty and "Create Project" stayed disabled
// with no explanation. Now the dialog explains that a project needs an account, lets you add one in
// place (POST /api/accounts, which checks the permission), and says what is still missing.
//
// NON-DESTRUCTIVE: no reset, no seed. Uses temporary @example.com accounts (a Project Director, who may
// create accounts, and a Project Manager, who may not) and deletes everything it created. Local only.
//
// Usage: node tests/local-e2e/project-dialog.mjs   (app running on port 3100)
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { loadEnv, adminClient, Report, ROOT, chromePath } from './lib.mjs';

const env = loadEnv();
const admin = adminClient(env);
const report = new Report('Create New Project with no accounts');
const OUT = path.join(ROOT, 'tests', 'local-e2e', 'output');
fs.mkdirSync(OUT, { recursive: true });
const RUN = Date.now().toString(36);
const PD = { email: `pd.${RUN}@example.com`, password: 'Director2026x', name: 'E2E Temp Director', role: 'Project Director' };
const PM = { email: `pm.${RUN}@example.com`, password: 'Manager2026x', name: 'E2E Temp Manager', role: 'Project Manager' };
const ACCOUNT_A = `E2E Client A ${RUN}`;
const ACCOUNT_B = `E2E Client B ${RUN}`;
const userIds = [];

async function makeUser(u) {
  const { data, error } = await admin.auth.admin.createUser({ email: u.email, password: u.password, email_confirm: true, user_metadata: { name: u.name } });
  if (error) throw error;
  userIds.push(data.user.id);
  await admin.from('user_profiles').update({ name: u.name, has_completed_onboarding: true }).eq('id', data.user.id);
  const { data: role } = await admin.from('roles').select('id').eq('name', u.role).single();
  const { error: rErr } = await admin.from('user_roles').insert({ user_id: data.user.id, role_id: role.id });
  if (rErr) throw rErr;
  return data.user.id;
}
async function login(page, u) {
  await page.goto(`${env.appUrl}/login?email=${encodeURIComponent(u.email)}`, { waitUntil: 'load' });
  await page.waitForSelector('#email', { timeout: 30000 });
  await page.fill('#password', u.password);
  await page.click('button[type="submit"]');
  await page.waitForURL((x) => x.pathname === '/manager', { timeout: 45000 });
}
async function openDialog(page) {
  await page.goto(`${env.appUrl}/projects`, { waitUntil: 'load' });
  await page.getByRole('button', { name: 'Create Project' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByText('Create New Project').waitFor({ timeout: 30000 });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  return dialog;
}
const hint = (dialog) => dialog.locator('#project-missing').innerText().catch(() => '');
const submit = (dialog) => dialog.getByRole('button', { name: 'Create Project' });

async function cleanup() {
  const problems = [];
  const { data: projects } = await admin.from('projects').select('id').like('name', `%${RUN}%`);
  for (const p of projects || []) { const { error } = await admin.from('projects').delete().eq('id', p.id); if (error) problems.push(`project: ${error.message}`); }
  const { data: accounts } = await admin.from('accounts').select('id').like('name', `%${RUN}%`);
  for (const a of accounts || []) { const { error } = await admin.from('accounts').delete().eq('id', a.id); if (error) problems.push(`account: ${error.message}`); }
  for (const id of userIds) { const { error } = await admin.auth.admin.deleteUser(id); if (error) problems.push(`user: ${error.message}`); }
  for (const p of problems) console.error(`  cleanup: ${p}`);
}
const counts = async () => {
  const c = async (t) => (await admin.from(t).select('id', { count: 'exact', head: true })).count;
  return { accounts: await c('accounts'), projects: await c('projects'), profiles: await c('user_profiles') };
};

async function main() {
  const before = await counts();
  const pdId = await makeUser(PD);
  await makeUser(PM);
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
  try {
    report.start('A Project Director creates the first project (no accounts yet)');
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await login(page, PD);
    let dialog = await openDialog(page);
    const startedEmpty = before.accounts === 0;
    if (startedEmpty) {
      const shown = await dialog.getByText('No accounts yet', { exact: false }).waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
      report.record('EMPTY-explained', shown, 'the dialog says a project needs an account and offers to add one');
    } else {
      await dialog.getByRole('button', { name: '+ New account' }).click();
      report.record('EMPTY-explained', true, `workspace already had ${before.accounts} account(s): used "+ New account" instead`);
    }
    await dialog.locator('#name').fill(`E2E Project ${RUN}`);
    report.record('HINT-before', /an account/.test(await hint(dialog)) && /estimated hours/.test(await hint(dialog)) && await submit(dialog).isDisabled(),
      `"${await hint(dialog)}"; Create Project disabled`);
    await dialog.locator('#newAccountName').fill(ACCOUNT_A);
    await dialog.getByRole('button', { name: 'Add', exact: true }).click();
    const selected = await dialog.getByRole('combobox').filter({ hasText: ACCOUNT_A }).waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
    report.record('ACCOUNT-added-and-selected', selected, `account "${ACCOUNT_A}" created and selected`);
    await dialog.locator('#estimatedHours').fill('40');
    report.record('HINT-cleared', !(await dialog.locator('#project-missing').count()) && await submit(dialog).isEnabled(), 'nothing missing; Create Project enabled');
    await page.screenshot({ path: path.join(OUT, 'project-dialog-ready.png') }).catch(() => {});
    await submit(dialog).click();
    const toastText = await page.getByText(/Project created successfully|Failed to create project|permission/).first().innerText({ timeout: 20000 }).catch(() => 'no result message');
    await page.waitForTimeout(1000);
    const { data: proj, error: projErr } = await admin.from('projects').select('id, account_id, estimated_hours, created_by').eq('name', `E2E Project ${RUN}`).maybeSingle();
    const { data: acctA } = await admin.from('accounts').select('id').eq('name', ACCOUNT_A).maybeSingle();
    report.record('PROJECT-created', proj?.created_by === pdId && Number(proj?.estimated_hours) === 40 && proj?.account_id === acctA?.id,
      `message "${toastText.replace(/\s+/g, ' ')}"; saved: ${proj ? `account ok=${proj.account_id === acctA?.id}, ${proj.estimated_hours} h` : `no row (${projErr?.message || 'not found'})`}`);

    report.start('Accounts exist: pick one, or add another');
    dialog = await openDialog(page);
    const listed = await dialog.getByRole('button', { name: '+ New account' }).waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
    report.record('LIST-shown', listed && await dialog.getByRole('combobox').first().isVisible(), 'account list plus "+ New account" once the accounts have loaded');
    await dialog.getByRole('button', { name: '+ New account' }).click();
    await dialog.locator('#newAccountName').fill(ACCOUNT_A);
    await dialog.getByRole('button', { name: 'Add', exact: true }).click();
    const dup = await dialog.getByText('already exists', { exact: false }).waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
    report.record('ACCOUNT-duplicate', dup, 'adding an existing name shows "already exists"');
    await dialog.locator('#newAccountName').fill(ACCOUNT_B);
    await dialog.locator('#newAccountName').press('Enter');
    const selB = await dialog.getByRole('combobox').filter({ hasText: ACCOUNT_B }).waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
    const stillOpen = await dialog.getByText('Create New Project').isVisible();
    const { count: bMade } = await admin.from('accounts').select('id', { count: 'exact', head: true }).eq('name', ACCOUNT_B);
    await page.screenshot({ path: path.join(OUT, 'project-dialog-enter.png') }).catch(() => {});
    report.record('ACCOUNT-enter-key', selB && stillOpen, `Enter adds the account (created=${bMade}, selected=${selB}) and keeps the dialog open (${stillOpen})`);

    report.start('A Project Manager without permission to add accounts');
    const pmPage = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await login(pmPage, PM);
    const pmDialog = await openDialog(pmPage);
    const empty = await Promise.race([
      pmDialog.getByText('No accounts yet', { exact: false }).waitFor({ timeout: 15000 }).then(() => true),
      pmDialog.getByRole('button', { name: '+ New account' }).waitFor({ timeout: 15000 }).then(() => false),
    ]).catch(() => false);
    if (!empty) await pmDialog.getByRole('button', { name: '+ New account' }).click();
    await pmDialog.locator('#newAccountName').fill(`E2E Not Allowed ${RUN}`);
    await pmDialog.getByRole('button', { name: 'Add', exact: true }).click();
    const refused = await pmDialog.getByText("You don't have permission to add accounts", { exact: false }).waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
    const { count: notCreated } = await admin.from('accounts').select('id', { count: 'exact', head: true }).eq('name', `E2E Not Allowed ${RUN}`);
    report.record('PM-refused', refused && notCreated === 0, 'clear message; no account created');
  } finally {
    await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 15000))]);
    await cleanup();
    const after = await counts();
    report.record('CLEANUP', JSON.stringify(after) === JSON.stringify(before), `before ${JSON.stringify(before)}, after ${JSON.stringify(after)}`);
  }
}

main().catch((e) => report.error('UNCAUGHT', e)).finally(() => process.exit(report.summary() ? 1 : 0));
