// Shared helpers for the local end-to-end tests.
// Safety: every script refuses to run unless Supabase is on localhost / 127.0.0.1.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..', '..');
export const PASSWORD = 'Test1234!';
export const COOKIE_NAME = 'sb-project-management-auth';

/** Read KEY=VALUE lines from .env.development.local (local Docker keys only). */
export function loadEnv() {
  const file = path.join(ROOT, '.env.development.local');
  if (!fs.existsSync(file)) {
    throw new Error('Missing .env.development.local. Start local Supabase and create it first (see tests/local-e2e/README.md).');
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
  return { url, anon, service, appUrl: (env.E2E_APP_URL || 'http://localhost:3100').replace(/\/$/, ''), cronSecret: env.CRON_SECRET || null };
}

export function adminClient(env) {
  return createClient(env.url, env.service, { auth: { autoRefreshToken: false, persistSession: false } });
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
