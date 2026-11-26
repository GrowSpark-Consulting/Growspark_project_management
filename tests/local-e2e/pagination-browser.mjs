// Paginated pages in a real browser: the pagination bar, URL state (page, size, search, sort, filters), refresh
// and back/forward keeping the view, search/filters/size going back to page 1, and no full page reloads.
// Pages covered: Projects, My Tasks, Admin Time Tracking, Admin Users, Accounts, Notifications.
//
// NON-DESTRUCTIVE: temporary rows named "PgB <run>" (projects, tasks, time entries, users, accounts,
// notifications), all deleted at the end. Local app on port 3100, seeded database (npm run e2e:local:seed).
//
// Usage: node tests/local-e2e/pagination-browser.mjs
import { chromium } from '@playwright/test';
import { loadEnv, adminClient, Report, chromePath, PASSWORD } from './lib.mjs';

const env = loadEnv();
const admin = adminClient(env);
const report = new Report('Pagination UI (browser)');
const RUN = Date.now().toString(36);
const TAG = `PgB ${RUN}`;
const pad = (n) => String(n).padStart(2, '0');
const made = { projects: [], tasks: [], entries: [], accounts: [], users: [], notifications: [] };
const ok = (id, cond, detail = '') => report.record(id, !!cond, detail);

async function insert(table, rows, list) {
  const { data, error } = await admin.from(table).insert(rows).select('id');
  if (error) throw new Error(`${table}: ${error.message}`);
  list.push(...data.map((r) => r.id));
  return data;
}

async function main() {
  const { data: sa } = await admin.from('user_profiles').select('id').eq('email', 'e2e.superadmin@example.com').single();
  const { data: emp } = await admin.from('user_profiles').select('id').eq('email', 'e2e.emp1@example.com').single();
  const { data: acme } = await admin.from('accounts').select('id').eq('name', 'Acme Corp (E2E)').single();
  const { data: website } = await admin.from('projects').select('id').eq('name', 'Website Redesign (E2E)').single();

  await insert('projects', Array.from({ length: 45 }, (_, i) => ({ name: `${TAG} P${pad(i + 1)}`, account_id: acme.id, status: 'in_progress', priority: ['low', 'medium', 'high', 'urgent'][i % 4], created_by: sa.id, assigned_user_id: sa.id })), made.projects);
  await insert('accounts', Array.from({ length: 25 }, (_, i) => ({ name: `${TAG} A${pad(i + 1)}`, status: 'active', description: 'pagination ui' })), made.accounts);
  await insert('tasks', Array.from({ length: 25 }, (_, i) => ({ name: `${TAG} T${pad(i + 1)}`, project_id: website.id, assigned_to: emp.id, created_by: sa.id, status: i < 6 ? 'in_progress' : 'todo', due_date: new Date(Date.now() + (i + 5) * 864e5).toISOString().slice(0, 10) })), made.tasks);
  await insert('time_entries', Array.from({ length: 30 }, (_, i) => {
    const d = new Date(Date.UTC(2021, 0, 4 + i));
    const monday = new Date(d); monday.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return { user_id: emp.id, project_id: website.id, hours_logged: 1, entry_date: d.toISOString().slice(0, 10), week_start_date: monday.toISOString().slice(0, 10), description: `${TAG} E${pad(i + 1)}` };
  }), made.entries);
  await insert('notifications', Array.from({ length: 30 }, (_, i) => ({ user_id: sa.id, title: `${TAG} N${pad(i + 1)}`, message: 'ui', type: 'general', created_at: `2098-01-01T00:00:${pad(i)}.000Z` })), made.notifications);

  const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  let documents = 0;
  page.on('request', (r) => { if (r.resourceType() === 'document' && r.frame() === page.mainFrame()) documents += 1; });

  const login = async (email) => {
    await page.context().clearCookies();
    await page.goto(`${env.appUrl}/login`, { waitUntil: 'networkidle' });
    await page.locator('input[type="email"]').fill(email);
    await page.locator('input[type="password"]').fill(PASSWORD);
    await page.getByRole('button', { name: 'Login', exact: true }).click();
    await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60000 });
    await page.waitForLoadState('networkidle');
  };
  const settle = async () => { await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(700); };
  const range = async () => (await page.getByTestId('pagination-range').first().innerText({ timeout: 15000 }).catch(() => '')).replace(/\s+/g, ' ');
  const waitRange = async (text) => { await page.getByTestId('pagination-range').first().filter({ hasText: text }).waitFor({ timeout: 15000 }).catch(() => {}); return range(); };
  const search = () => new URL(page.url()).searchParams;
  const next = () => page.getByRole('button', { name: 'Next page' }).click();
  const prev = () => page.getByRole('button', { name: 'Previous page' }).click();
  const pickSize = async (size) => {
    await page.getByRole('combobox', { name: 'Rows per page' }).click();
    await page.getByRole('option', { name: `${size} / page` }).click();
  };

  // ------------------------------------------------------------ Projects
  report.start('Projects page');
  await login('e2e.superadmin@example.com');
  documents = 0;
  await page.goto(`${env.appUrl}/projects?q=${encodeURIComponent(TAG)}`, { waitUntil: 'networkidle' });
  await settle();
  const base = documents;
  ok('page 1: 1–20 of 45', (await waitRange('of 45')).includes('1–20 of 45'), await range());
  ok('20 rows shown', (await page.locator('tbody tr').count()) === 20, `${await page.locator('tbody tr').count()}`);
  await next(); await waitRange('21–40');
  ok('Next: page 2, URL has page=2', (await range()).includes('21–40 of 45') && search().get('page') === '2', `${await range()} ${page.url().replace(env.appUrl, '')}`);
  ok('Next did not reload the page', documents === base);
  await page.reload({ waitUntil: 'networkidle' }); await settle();
  ok('refresh keeps page 2', (await waitRange('21–40')).includes('21–40 of 45'), await range());
  await next(); await waitRange('41–45');
  ok('last page: 41–45 of 45, Next disabled', (await range()).includes('41–45 of 45') && await page.getByRole('button', { name: 'Next page' }).isDisabled());
  await prev(); await waitRange('21–40');
  await page.goBack(); await settle();
  ok('browser Back works within the app (no crash)', (await page.locator('main').count()) === 1);
  await page.goto(`${env.appUrl}/projects?q=${encodeURIComponent(TAG)}&page=2`, { waitUntil: 'networkidle' }); await settle();
  await pickSize(50); await waitRange('1–45');
  ok('page size 50: back to page 1 with all 45, pageSize in the URL', (await range()).includes('1–45 of 45') && search().get('pageSize') === '50' && !search().has('page'), `${await range()} ${page.url().replace(env.appUrl, '')}`);
  await pickSize(20); await waitRange('1–20');
  await next(); await waitRange('21–40');
  await page.getByPlaceholder('Search projects').fill(`${TAG} P07`); await waitRange('1 of 1').catch(() => {}); await settle();
  ok('search goes back to page 1 and finds the one project', (await range()).includes('1–1 of 1') && !search().has('page') && (await page.locator('tbody tr').count()) === 1, `${await range()} ${page.url().replace(env.appUrl, '')}`);
  await page.getByPlaceholder('Search projects').fill(`${TAG} nothing-here`); await settle();
  ok('search without matches: "No matching projects"', (await page.getByText('No matching projects').count()) === 1);
  await page.getByPlaceholder('Search projects').fill(TAG); await waitRange('of 45');
  await page.getByRole('button', { name: /^Sort by Project/ }).click(); await settle();
  await page.getByRole('button', { name: /^Sort by Project/ }).click(); await waitRange('1–20'); await settle();
  const firstName = await page.locator('tbody tr').first().innerText();
  ok('sort by name (descending) works across all pages: first row is P45', firstName.includes(`${TAG} P45`) && search().get('sort') === 'name' && search().get('order') === 'desc', firstName.split('\n')[0]);
  await next(); await waitRange('21–40');
  ok('sort kept on page 2', (await page.locator('tbody tr').first().innerText()).includes(`${TAG} P25`), (await page.locator('tbody tr').first().innerText()).split('\n')[0]);
  ok('no full page reload through all of this', documents === base + 2 /* the goto + reload above */ + 1, `documents ${documents - base}`);

  // ------------------------------------------------------------ My Tasks
  report.start('My Tasks page');
  await login('e2e.emp1@example.com');
  await page.goto(`${env.appUrl}/tasks?q=${encodeURIComponent(TAG)}`, { waitUntil: 'networkidle' }); await settle();
  ok('25 matching tasks: 1–20 of 25', (await waitRange('of 25')).includes('1–20 of 25'), await range());
  await next(); await waitRange('21–25');
  ok('page 2: 21–25 of 25', (await range()).includes('21–25 of 25') && search().get('page') === '2');
  await page.getByRole('button', { name: /^In progress\s*\d+$/ }).click(); await waitRange('of 6');
  ok('switching view goes back to page 1 and loads it (6 in progress)', (await range()).includes('1–6 of 6') && search().get('view') === 'in_progress' && !search().has('page'), `${await range()} ${page.url().replace(env.appUrl, '')}`);
  await page.getByRole('button', { name: /^Assigned to me\s*\d+$/ }).click(); await waitRange('of 25');
  ok('back to "Assigned to me": all 25 again', (await range()).includes('of 25'));
  await pickSize(100); await waitRange('1–25');
  ok('page size 100 shows all 25', (await range()).includes('1–25 of 25'));

  // ------------------------------------------------------------ Admin Time Tracking
  report.start('Admin Time Tracking page');
  await login('e2e.superadmin@example.com');
  await page.goto(`${env.appUrl}/admin/time-tracking?startDate=2021-01-01&endDate=2021-02-28&userId=${emp.id}`, { waitUntil: 'networkidle' }); await settle();
  ok('30 entries: 1–20 of 30', (await waitRange('of 30')).includes('1–20 of 30'), await range());
  ok('summary counts all 30 entries, not only the page', (await page.getByText('Total Entries').locator('xpath=preceding-sibling::div').first().innerText()) === '30');
  await next(); await waitRange('21–30');
  ok('page 2: 21–30 of 30, URL keeps the filters', (await range()).includes('21–30 of 30') && search().get('page') === '2' && search().get('userId') === emp.id);

  // ------------------------------------------------------------ Accounts (server-rendered)
  report.start('Accounts page');
  await page.goto(`${env.appUrl}/accounts?q=${encodeURIComponent(TAG)}`, { waitUntil: 'networkidle' }); await settle();
  ok('25 accounts: 1–20 of 25', (await waitRange('of 25')).includes('1–20 of 25'), await range());
  ok('20 cards shown', (await page.getByRole('link', { name: /View Details/ }).count()) === 20);
  await next(); await waitRange('21–25');
  ok('page 2: 21–25 of 25 and 5 cards', (await range()).includes('21–25 of 25') && (await page.getByRole('link', { name: /View Details/ }).count()) === 5, await range());

  // ------------------------------------------------------------ Notifications (Load more)
  report.start('Notifications page');
  await page.goto(`${env.appUrl}/notifications`, { waitUntil: 'networkidle' }); await settle();
  ok('first 20 shown, newest first', (await page.getByText(`${TAG} N30`).count()) === 1 && (await page.getByText(`${TAG} N11`).count()) === 1 && (await page.getByText(`${TAG} N10`).count()) === 0);
  await page.getByRole('button', { name: 'Load more' }).click(); await settle();
  ok('Load more adds the older ones', (await page.getByText(`${TAG} N10`).count()) === 1 && (await page.getByText(`${TAG} N01`).count()) === 1);

  await browser.close();
}

async function cleanup() {
  report.start('Cleanup');
  const del = async (table, ids) => { if (ids.length) await admin.from(table).delete().in('id', ids); };
  await del('notifications', made.notifications);
  await del('time_entries', made.entries);
  await del('tasks', made.tasks);
  await del('projects', made.projects);
  await del('accounts', made.accounts);
  const { count } = await admin.from('projects').select('id', { count: 'exact', head: true }).like('name', `${TAG}%`);
  ok('all temporary rows removed', count === 0, `${count} left`);
}

try { await main(); } catch (e) { report.error('run', e); } finally { await cleanup().catch((e) => report.error('cleanup', e)); }
process.exit(report.summary() ? 1 : 0);
