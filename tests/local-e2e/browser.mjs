// Local browser pass: log in through the real login page as each role, check the landing
// page and role guards, open every main screen, and record crashes, server errors and
// console errors. Screenshots go to tests/local-e2e/output/ (gitignored).
// Usage: node tests/local-e2e/browser.mjs   (after the seed and `npm run dev`)
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { loadEnv, Report, PASSWORD, ROOT } from './lib.mjs';
import { seed, IDS, PERSONAS } from './seed.mjs';

const env = loadEnv();
const report = new Report('Local browser pass');
const OUT = path.join(ROOT, 'tests', 'local-e2e', 'output');
fs.mkdirSync(OUT, { recursive: true });
const warnings = [];

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  if (!fs.existsSync(base)) return undefined;
  const dirs = fs.readdirSync(base).filter((d) => d.startsWith('chromium_headless_shell-')).sort().reverse();
  for (const d of dirs) {
    const exe = path.join(base, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return undefined; // let Playwright use its own default
}

const PLAN = {
  superadmin: { landing: '/manager', pages: ['/manager', '/admin', '/admin/users', '/admin/roles', '/admin/settings', '/admin/invitations', '/admin/client-portal', '/admin/client-feedback', '/admin/workflows', '/admin/time-tracking', '/accounts', '/departments', '/analytics', '/projects'] },
  pm: { landing: '/manager', pages: ['/manager', '/manager/team', '/manager/approvals', '/manager/timesheets', '/manager/reports', '/manager/templates', '/projects', `/projects/${IDS.website}`, '/tasks', '/timesheets', '/calendar', '/capacity', '/notifications', `/accounts/${IDS.acme}`] },
  emp1: { landing: '/dashboard', pages: ['/dashboard', '/tasks', '/projects', `/projects/${IDS.website}`, '/timesheets', '/calendar', '/performance', '/notifications', '/profile', '/time-entries', '/capacity'], blocked: ['/manager', '/admin/users'] },
  client: { landing: '/client-portal', pages: ['/client-portal', '/client-portal/projects', `/client-portal/projects/${IDS.website}`, '/client-portal/approvals', '/client-portal/notifications', '/client-portal/profile'], blocked: ['/dashboard', '/projects'] },
};

const ERROR_TEXT = /Application error|Unhandled Runtime Error|Something went wrong|Internal Server Error|This page could not be found/i;

async function visit(page, persona, urlPath, track) {
  track.reset();
  try {
    const res = await page.goto(env.appUrl + urlPath, { waitUntil: 'load', timeout: 180000 });
    // Pages poll (notifications, clock), so "network idle" may never come; cap the wait
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const finalPath = new URL(page.url()).pathname;
    const bodyText = (await page.locator('body').innerText({ timeout: 10000 }).catch(() => '')) || '';
    const errText = bodyText.match(ERROR_TEXT)?.[0];
    const slug = `${persona}${urlPath.replace(/[^a-z0-9]+/gi, '-')}`.replace(/-+$/, '');
    await page.screenshot({ path: path.join(OUT, `${slug}.png`) }).catch(() => {});
    return { status: res?.status() ?? 0, finalPath, errText, ...track.snapshot() };
  } catch (e) {
    return { status: 0, finalPath: '', errText: e.message.split('\n')[0], ...track.snapshot() };
  }
}

function tracker(page) {
  let pageErrors = [], consoleErrors = [], serverErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message.split('\n')[0]));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().split('\n')[0].slice(0, 200)); });
  page.on('response', (r) => {
    if (r.status() >= 500 && r.url().startsWith(env.appUrl)) serverErrors.push(`${r.status()} ${new URL(r.url()).pathname}`);
  });
  return {
    reset() { pageErrors = []; consoleErrors = []; serverErrors = []; },
    snapshot() { return { pageErrors: [...pageErrors], consoleErrors: [...new Set(consoleErrors)], serverErrors: [...new Set(serverErrors)] }; },
  };
}

async function main() {
  await seed({ quiet: true });
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
  try {
    for (const [persona, plan] of Object.entries(PLAN)) {
      report.start(`${persona} (${PERSONAS[persona].role})`);
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await context.addInitScript(() => { try { localStorage.setItem('gs-theme', 'light'); } catch { /* ignore */ } });
      const page = await context.newPage();
      const track = tracker(page);

      // Log in through the real form
      try {
        await page.goto(`${env.appUrl}/login`, { waitUntil: 'domcontentloaded', timeout: 180000 });
        await page.fill('#email', PERSONAS[persona].email);
        await page.fill('input[type="password"]', PASSWORD);
        // Record every page the browser passes through, so detours (e.g. via /welcome) are visible
        const path_ = [];
        const onNav = (f) => { if (f === page.mainFrame()) path_.push(new URL(f.url()).pathname); };
        page.on('framenavigated', onNav);
        await page.click('button[type="submit"]');
        await page.waitForURL((u) => u.pathname.startsWith(plan.landing), { timeout: 60000 }).catch(() => {});
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        page.off('framenavigated', onNav);
        const landed = new URL(page.url()).pathname;
        const detour = path_.filter((p) => !['/login', '/', plan.landing].includes(p));
        report.record(`LOGIN-${persona}`, landed.startsWith(plan.landing) && detour.length === 0, `landed on ${landed}, expected ${plan.landing}; route ${[...new Set(path_)].join(' → ')}`);
      } catch (e) {
        report.error(`LOGIN-${persona}`, e);
        await context.close();
        continue;
      }

      for (const urlPath of plan.pages) {
        const r = await visit(page, persona, urlPath, track);
        const problems = [];
        if (r.status >= 400 || r.status === 0) problems.push(`HTTP ${r.status}`);
        if (r.errText) problems.push(`shows "${r.errText}"`);
        if (r.pageErrors.length) problems.push(`page errors: ${r.pageErrors.join(' | ')}`);
        if (r.serverErrors.length) problems.push(`server errors: ${r.serverErrors.join(', ')}`);
        const redirected = r.finalPath && r.finalPath !== urlPath ? ` → ${r.finalPath}` : '';
        report.record(`PAGE ${urlPath}`, problems.length === 0, problems.length ? problems.join('; ') : `ok${redirected}`);
        if (r.consoleErrors.length) warnings.push(`${persona} ${urlPath}: ${r.consoleErrors.join(' | ')}`);
      }
      // Role guards: either a redirect away (clients are redirected client-side once their
      // profile loads, so allow time) or an access message rendered in place.
      const DENIED = /not authori[sz]ed|access denied|don't have (access|permission)|permission|You need a manager role/i;
      for (const urlPath of plan.blocked || []) {
        await visit(page, persona, urlPath, track);
        await page.waitForURL((u) => u.pathname !== urlPath, { timeout: 30000 }).catch(() => {});
        const finalPath = new URL(page.url()).pathname;
        const denied = finalPath === urlPath ? await page.locator('body').innerText().then((t) => DENIED.test(t)).catch(() => false) : false;
        await page.screenshot({ path: path.join(OUT, `${persona}-guard${urlPath.replace(/[^a-z0-9]+/gi, '-')}.png`) }).catch(() => {});
        report.record(`GUARD ${urlPath}`, finalPath !== urlPath || denied, `ended on ${finalPath}${denied ? ' (access message shown)' : ''}`);
      }
      await context.close();
    }
  } finally {
    // The headless shell can hang on close on Windows; don't let that block the report
    await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 15000))]);
  }
}

main()
  .catch((e) => report.error('UNCAUGHT', e))
  .finally(() => {
    if (warnings.length) {
      console.log(`\nConsole errors (not counted as failures, ${warnings.length} pages):`);
      for (const w of warnings) console.log(`  WARN ${w}`);
    }
    console.log(`\nScreenshots: ${path.relative(ROOT, OUT)}`);
    const failed = report.summary();
    process.exit(failed ? 1 : 0);
  });
