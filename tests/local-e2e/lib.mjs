// Shared helpers for the local end-to-end tests.
// Safety: every script refuses to run unless Supabase is on localhost / 127.0.0.1.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..', '..');
export const PASSWORD = 'Test1234!';
export const COOKIE_NAME = 'sb-project-management-auth';

/**
 * Read KEY=VALUE lines from .env.development.local (local Docker keys only), or from the file named by
 * LOCAL_ENV_FILE (the shared-database rehearsal uses .env.rehearsal.local, see scripts/shared-db).
 */
export function loadEnv() {
  const name = process.env.LOCAL_ENV_FILE || '.env.development.local';
  const file = path.join(ROOT, name);
  if (!fs.existsSync(file)) {
    throw new Error(`Missing ${name}. Start local Supabase and create it first (see tests/local-e2e/README.md).`);
  }
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY || env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const service = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anon || !service) throw new Error('.env.development.local must set NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY and SUPABASE_SERVICE_ROLE_KEY');
  const host = new URL(url).hostname;
  if (!['127.0.0.1', 'localhost'].includes(host)) {
    throw new Error(`Refusing to run: Supabase URL ${url} is not local. These tests write data and must only run against local Docker.`);
  }
  return {
    url, anon, service, appUrl: (process.env.E2E_APP_URL || env.E2E_APP_URL || 'http://localhost:3100').replace(/\/$/, ''), cronSecret: env.CRON_SECRET || null,
    // The app's tables live in DB_SCHEMA (project in the shared-database rehearsal); the test clients read them there
    schema: env.DB_SCHEMA || 'public',
    rehearsal: env.REHEARSAL === '1',
  };
}

export function adminClient(env) {
  const client = createClient(env.url, env.service, { auth: { autoRefreshToken: false, persistSession: false }, db: { schema: env.schema || 'public' } });
  if ((env.schema || 'public') !== 'public') {
    // Shared-database rehearsal: the app's tables are not in the Auth database, so the old auth.users
    // trigger (profile on sign-up) and foreign-key cascade (profile gone with the account) do not exist.
    // Tests that create accounts directly through Auth get the same plain profile and cleanup here; the
    // app itself creates profiles in its own flows (see lib/profile-loader.ts).
    const authAdmin = client.auth.admin;
    const createUser = authAdmin.createUser.bind(authAdmin);
    const deleteUser = authAdmin.deleteUser.bind(authAdmin);
    authAdmin.createUser = async (attrs) => {
      const res = await createUser(attrs);
      const u = res.data?.user;
      if (u) {
        const name = (typeof u.user_metadata?.name === 'string' && u.user_metadata.name.trim()) || u.email;
        await client.from('user_profiles').upsert({ id: u.id, email: u.email, name }, { onConflict: 'id', ignoreDuplicates: true });
      }
      return res;
    };
    authAdmin.deleteUser = async (id, ...rest) => {
      const res = await deleteUser(id, ...rest);
      if (!res.error) await client.from('user_profiles').delete().eq('id', id);
      return res;
    };
  }
  return client;
}

/** Playwright's Chromium headless shell (or CHROME_PATH). */
export function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  if (!fs.existsSync(base)) return undefined;
  for (const d of fs.readdirSync(base).filter((x) => x.startsWith('chromium_headless_shell-')).sort().reverse()) {
    const exe = path.join(base, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return undefined;
}

/** Test accounts all use @example.com. Anything else is someone's own local account. */
export const isTestEmail = (email) => /@example\.com$/i.test(email || '');

/**
 * Wipe and rebuild the LOCAL database (`supabase db reset --local`: every migration + seed.sql).
 * Refuses when the database holds accounts that aren't test accounts (for example a workspace you
 * registered yourself in the browser) unless the command line has --wipe-local-accounts.
 */
export async function resetLocalDb(env, { log = console.log } = {}) {
  if (env.rehearsal) {
    // The shared-database rehearsal stack is disposable: rebuild it (mirror + roles + baseline), never
    // the developer's own local database
    log('Rebuilding the rehearsal database (scripts/shared-db/rehearse.mjs)…');
    execSync('node scripts/shared-db/rehearse.mjs --rebuild', { cwd: ROOT, stdio: 'ignore' });
    // The rebuild restarts the database; the Data API the tests read through reconnects and reloads its
    // schema a moment later. Wait until it serves the app's tables and Auth answers.
    for (let i = 0; i < 60; i++) {
      const a = adminClient(env);
      const [db, auth] = await Promise.all([
        a.from('user_profiles').select('id', { count: 'exact', head: true }),
        a.auth.admin.listUsers({ perPage: 1 }).catch((e) => ({ error: e })),
      ]);
      if (!db.error && db.count !== null && !auth.error) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error('The rehearsal database, its Data API or Auth did not come back after the rebuild');
  }
  const admin = adminClient(env);
  const { data, error } = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (error) throw new Error(`Could not list local accounts before the reset: ${error.message}`);
  const own = (data?.users || []).filter((u) => !isTestEmail(u.email));
  if (own.length && !process.argv.includes('--wipe-local-accounts')) {
    throw new Error(`Refusing to reset: the local database has ${own.length} non-test account(s) (${own.map((u) => u.email).join(', ')}). `
      + 'They would be deleted. Re-run with --wipe-local-accounts if that is really what you want.');
  }
  const { data: s } = await admin.from('app_settings').select('workspace_name, registered_by').eq('id', true).maybeSingle();
  if (s?.registered_by && !process.argv.includes('--wipe-local-accounts')) {
    const { data: owner } = await admin.auth.admin.getUserById(s.registered_by);
    if (owner?.user && !isTestEmail(owner.user.email)) {
      throw new Error(`Refusing to reset: workspace "${s.workspace_name}" was registered by ${owner.user.email}. Re-run with --wipe-local-accounts to delete it.`);
    }
  }
  log('Resetting the LOCAL database (supabase db reset --local)…');
  execSync('npx supabase db reset --local', { cwd: ROOT, stdio: 'ignore' });
  // The reset restarts the Auth and Storage services too: wait until the database, Auth and Storage
  // all answer, otherwise the first sign-up or sign-in right after a reset fails.
  // A restarted service can come back on a new address while the API gateway (Kong) keeps the old
  // one (HTTP 502). If that lasts, restart this project's gateway once.
  let gatewayRestarted = false;
  for (let i = 0; i < 60; i++) {
    const a = adminClient(env);
    const [db, auth, storage] = await Promise.all([
      a.from('app_settings').select('id').limit(1),
      a.auth.admin.listUsers({ perPage: 1 }).catch((e) => ({ error: e })),
      a.storage.listBuckets().catch((e) => ({ error: e })),
    ]);
    if (!db.error && !auth.error && !storage.error) return;
    if (i >= 10 && !gatewayRestarted && [auth.error, storage.error].some((e) => e && (e.status === 502 || /502|Bad Gateway/.test(String(e.message))))) {
      const projectId = (fs.readFileSync(path.join(ROOT, 'supabase', 'config.toml'), 'utf8').match(/^project_id\s*=\s*"([^"]+)"/m) || [])[1];
      if (projectId) {
        log(`The API gateway still points at the old Auth/Storage address; restarting supabase_kong_${projectId}…`);
        execSync(`docker restart supabase_kong_${projectId}`, { stdio: 'ignore' });
        gatewayRestarted = true;
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('The local database, Auth or Storage did not come back after the reset');
}

/** Sign in like the browser does and return the auth cookie header plus a user-scoped client. */
export async function signIn(env, email, password = PASSWORD) {
  const jar = new Map();
  const sb = createServerClient(env.url, env.anon, {
    cookieOptions: { name: COOKIE_NAME },
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (list) => list.forEach(({ name, value }) => (value ? jar.set(name, value) : jar.delete(name))),
    },
  });
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`Sign-in failed for ${email}: ${error.message}`);
  const cookie = [...jar].map(([n, v]) => `${n}=${v}`).join('; ');
  const db = createClient(env.url, env.anon, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${data.session.access_token}` } },
    db: { schema: env.schema || 'public' },
  });
  return { email, userId: data.user.id, cookie, db, session: data.session };
}

/** Call the running app as a signed-in user. Returns { status, body, text, headers }. */
export async function call(env, who, method, urlPath, body) {
  const res = await fetch(env.appUrl + urlPath, {
    method,
    redirect: 'manual',
    headers: {
      ...(who ? { cookie: who.cookie } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      origin: env.appUrl,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, body: json, text, headers: res.headers };
}

/** `{ data }`, `{ success, task }` and bare shapes all exist; pick the payload. */
export function payload(r) {
  const b = r.body;
  if (!b || typeof b !== 'object') return b;
  return b.data ?? b.task ?? b.project ?? b.update ?? b.issue ?? b.feedback ?? b;
}

export function isoDate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function addDays(n, from = new Date()) { const d = new Date(from); d.setDate(d.getDate() + n); return d; }
export function mondayOf(d = new Date()) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12);
  const day = x.getDay();
  x.setDate(x.getDate() - day + (day === 0 ? -6 : 1));
  return isoDate(x);
}

/** Collects PASS/FAIL lines and prints a summary. */
export class Report {
  constructor(title) { this.title = title; this.rows = []; this.section = ''; }
  start(section) { this.section = section; console.log(`\n▸ ${section}`); }
  record(id, ok, detail = '') {
    this.rows.push({ section: this.section, id, ok, detail });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${id}${detail ? `  (${detail})` : ''}`);
    return ok;
  }
  /** Expect an HTTP status (or one of several). */
  status(id, r, expected, extra = '') {
    const list = Array.isArray(expected) ? expected : [expected];
    const ok = list.includes(r.status);
    const msg = ok ? `${r.status}${extra ? ` ${extra}` : ''}` : `got ${r.status}, expected ${list.join('/')}: ${(r.body?.error || r.text || '').toString().slice(0, 200)}`;
    return this.record(id, ok, msg);
  }
  error(id, err) { return this.record(id, false, `ERROR ${err?.message || err}`); }
  summary() {
    const failed = this.rows.filter((r) => !r.ok);
    console.log(`\n${this.title}: ${this.rows.length - failed.length}/${this.rows.length} passed`);
    if (failed.length) {
      console.log('\nFailures:');
      for (const f of failed) console.log(`  [${f.section}] ${f.id}: ${f.detail}`);
    }
    return failed.length;
  }
}
