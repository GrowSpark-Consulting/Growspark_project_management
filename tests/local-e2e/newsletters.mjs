// Newsletters module: browser → API → Prisma (Phase 11, first module).
//
// The welcome page's newsletter card used to query the `newsletters` table straight from the browser.
// It now calls /api/newsletters, which runs every query through Prisma as the signed-in user, so the
// table's row-level security still decides. Checked here through the API and in a real browser,
// including that the browser makes no direct database requests for newsletters any more.
//
// NON-DESTRUCTIVE: temporary @example.com users, one temporary role and their newsletters, all deleted
// at the end, and the counts compared. Local Supabase only (app on port 3100).
//
// Usage: node tests/local-e2e/newsletters.mjs
import { chromium } from '@playwright/test';
import { loadEnv, adminClient, signIn, call, Report, chromePath } from './lib.mjs';

const env = loadEnv();
const admin = adminClient(env);
const report = new Report('Newsletters (browser → API → Prisma)');
const RUN = Date.now().toString(36);
const PASSWORD = 'Newsletter2026x';
const PEOPLE = {
  // Real superadmins also hold the Superadmin role (registration gives it); the welcome page needs a role
  sa: { email: `nl.sa.${RUN}@example.com`, name: `NL Admin ${RUN}`, superadmin: true, role: 'Superadmin' },
  sa2: { email: `nl.sa2.${RUN}@example.com`, name: `NL Admin Two ${RUN}`, superadmin: true, role: 'Superadmin' },
  emp: { email: `nl.emp.${RUN}@example.com`, name: `NL Employee ${RUN}`, role: 'Employee' },
  writer: { email: `nl.writer.${RUN}@example.com`, name: `NL Writer ${RUN}`, role: 'writer' },
};
const S = {};
const made = { users: [], roles: [] };
const visible = (loc, timeout = 15000) => loc.first().waitFor({ timeout }).then(() => true).catch(() => false);
const count = async (table) => (await admin.from(table).select('*', { count: 'exact', head: true })).count;
const counts = async () => ({ newsletters: await count('newsletters'), profiles: await count('user_profiles'), roles: await count('roles') });

async function makeUser(key) {
  const p = PEOPLE[key];
  const { data, error } = await admin.auth.admin.createUser({ email: p.email, password: PASSWORD, email_confirm: true, user_metadata: { name: p.name } });
  if (error) throw error;
  made.users.push(data.user.id);
  await admin.from('user_profiles').update({ name: p.name, is_superadmin: !!p.superadmin, has_completed_onboarding: true }).eq('id', data.user.id);
  if (p.role === 'writer') {
    // Holds manage_newsletters but is not a superadmin: the API lets it through, the database rule must not
    const { data: role, error: rErr } = await admin.from('roles').insert({ name: `NL Writer ${RUN}`, permissions: { view_newsletters: true, manage_newsletters: true }, is_system_role: false, hierarchy_level: 10 }).select('id').single();
    if (rErr) throw rErr;
    made.roles.push(role.id);
    await admin.from('user_roles').insert({ user_id: data.user.id, role_id: role.id });
  } else if (p.role) {
    const { data: role } = await admin.from('roles').select('id').eq('name', p.role).single();
    await admin.from('user_roles').insert({ user_id: data.user.id, role_id: role.id });
  }
  S[key] = await signIn(env, p.email, PASSWORD);
}

async function cleanup() {
  const problems = [];
  if (made.users.length) {
    const { error } = await admin.from('newsletters').delete().in('created_by', made.users);
    if (error) problems.push(`newsletters: ${error.message}`);
  }
  for (const id of made.users) { const { error } = await admin.auth.admin.deleteUser(id); if (error) problems.push(`user: ${error.message}`); }
  for (const id of made.roles) { const { error } = await admin.from('roles').delete().eq('id', id); if (error) problems.push(`role: ${error.message}`); }
  for (const p of problems) console.error(`  cleanup: ${p}`);
}

async function main() {
  const before = await counts();
  let browser;
  try {
    for (const key of Object.keys(PEOPLE)) await makeUser(key);

    report.start('API');
    report.status('API-signed-out', await call(env, null, 'GET', '/api/newsletters'), 401, 'no session, no newsletters');
    const created = await call(env, S.sa, 'POST', '/api/newsletters', { title: `Launch ${RUN}`, content: `Hello team ${RUN}` });
    report.status('API-create', created, 201, 'a superadmin publishes a newsletter');
    const n = created.body?.data || {};
    report.record('API-create-shape', n.is_published === true && !!n.published_at && n.created_by === S.sa.userId && n.user_profiles?.name === PEOPLE.sa.name,
      `published, author "${n.user_profiles?.name}" included, same shape as before`);
    report.record('API-uuid-v7', /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab]/.test(n.id || ''), `new id ${n.id} is UUID v7`);
    const list = await call(env, S.sa, 'GET', '/api/newsletters');
    report.record('API-list', list.status === 200 && (list.body?.data || []).some((x) => x.id === n.id), `${(list.body?.data || []).length} published newsletter(s), newest first`);
    report.status('API-blank-title', await call(env, S.sa, 'POST', '/api/newsletters', { title: '   ', content: 'x' }), 400, 'blank title refused');
    report.status('API-employee-read', await call(env, S.emp, 'GET', '/api/newsletters'), 403, 'no newsletter permission: the card stays hidden for employees, as before');
    report.status('API-employee-create', await call(env, S.emp, 'POST', '/api/newsletters', { title: 'x', content: 'y' }), 403);
    const writer = await call(env, S.writer, 'POST', '/api/newsletters', { title: `Writer ${RUN}`, content: 'y' });
    report.record('API-rls-still-decides', writer.status === 403 && /row-level security/i.test(writer.body?.error || ''),
      `manage_newsletters without superadmin: ${writer.status} "${writer.body?.error}" (the database rule refused it through Prisma)`);
    report.status('API-other-author-edit', await call(env, S.sa2, 'PATCH', `/api/newsletters/${n.id}`, { title: 'not mine' }), 404, 'only the author edits');
    report.status('API-other-author-delete', await call(env, S.sa2, 'DELETE', `/api/newsletters/${n.id}`), 404, 'only the author deletes');
    const edited = await call(env, S.sa, 'PATCH', `/api/newsletters/${n.id}`, { title: `Launch v2 ${RUN}` });
    report.record('API-edit', edited.status === 200 && edited.body?.data?.title === `Launch v2 ${RUN}` && edited.body?.data?.content === `Hello team ${RUN}`,
      `${edited.status}: title changed, content kept`);
    report.status('API-bad-id', await call(env, S.sa, 'PATCH', '/api/newsletters/not-a-uuid', { title: 'x' }), 400);
    const { count: writerRows } = await admin.from('newsletters').select('*', { count: 'exact', head: true }).eq('created_by', S.writer.userId);
    report.record('API-nothing-leaked', writerRows === 0, 'the refused write left no row');

    report.start('Browser (welcome page)');
    browser = await chromium.launch({ executablePath: chromePath(), headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addCookies(S.sa.cookie.split('; ').map((kv) => { const i = kv.indexOf('='); return { name: kv.slice(0, i), value: kv.slice(i + 1), url: env.appUrl }; }));
    const page = await ctx.newPage();
    const direct = [];
    page.on('request', (r) => { if (/\/rest\/v1\/newsletters/.test(r.url())) direct.push(r.url()); });
    await page.goto(`${env.appUrl}/welcome`, { waitUntil: 'load' });
    report.record('UI-list', await visible(page.getByText(`Launch v2 ${RUN}`)), 'the card shows the newsletter from the API');

    await page.getByRole('button', { name: 'Create', exact: true }).first().click();
    let dlg = page.getByRole('dialog');
    await dlg.locator('#title').fill(`Weekly ${RUN}`);
    await dlg.locator('#content').fill(`Notes ${RUN}`);
    await dlg.getByRole('button', { name: 'Create Newsletter' }).click();
    const shown = await visible(page.getByText(`Weekly ${RUN}`, { exact: true }));
    const { data: createdRow } = await admin.from('newsletters').select('id, created_by').eq('title', `Weekly ${RUN}`).maybeSingle();
    report.record('UI-create', shown && createdRow?.created_by === S.sa.userId, 'created in the dialog: listed and stored');

    const rowOf = (title) => page.locator('div.border.rounded-lg').filter({ has: page.locator('h4', { hasText: title }) }).last();
    await rowOf(`Weekly ${RUN}`).getByRole('button').nth(0).click();
    dlg = page.getByRole('dialog');
    await dlg.locator('#title').fill(`Weekly edited ${RUN}`);
    await dlg.getByRole('button', { name: 'Update Newsletter' }).click();
    report.record('UI-edit', await visible(page.getByText('Newsletter updated successfully!')) && await visible(page.getByText(`Weekly edited ${RUN}`, { exact: true })),
      'edited in the dialog: toast and new title');

    await rowOf(`Weekly edited ${RUN}`).getByRole('button').nth(1).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete Newsletter' }).click();
    const toast = await visible(page.getByText('Newsletter deleted successfully!'));
    const { count: left } = await admin.from('newsletters').select('*', { count: 'exact', head: true }).eq('id', createdRow?.id || '00000000-0000-0000-0000-000000000000');
    report.record('UI-delete', toast && left === 0, 'deleted in the dialog: toast and row gone');
    report.record('UI-no-direct-database', direct.length === 0, `${direct.length} browser request(s) to the Supabase data API for newsletters`);
  } catch (e) {
    report.error('UNCAUGHT', e);
  } finally {
    if (browser) await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 15000))]);
    await cleanup();
    const after = await counts();
    report.record('CLEANUP', JSON.stringify(after) === JSON.stringify(before), `before ${JSON.stringify(before)}, after ${JSON.stringify(after)}`);
  }
}

main().finally(() => process.exit(report.summary() ? 1 : 0));
