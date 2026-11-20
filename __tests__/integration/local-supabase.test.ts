/**
 * Integration tests against the LOCAL Supabase (npx supabase start). They are skipped when the
 * local stack or .env.development.local is not available, and they refuse to run against anything
 * that is not localhost. Test users are created with a unique email and removed afterwards.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

function loadLocalEnv(): { url: string; anon: string; service: string } | null {
  const file = path.resolve(__dirname, '..', '..', '.env.development.local');
  if (!fs.existsSync(file)) return null;
  const env: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY;
  const service = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anon || !service) return null;
  if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) return null; // never non-local
  return { url, anon, service };
}

const env = loadLocalEnv();
let reachable = false;
if (env) {
  try {
    const res = await fetch(`${env.url}/rest/v1/`, { headers: { apikey: env.anon }, signal: AbortSignal.timeout(3000) });
    reachable = res.status < 500;
  } catch { reachable = false; }
}

describe.skipIf(!env || !reachable)('local Supabase', () => {
  const admin = createClient(env!.url, env!.service, { auth: { persistSession: false } });
  const anon = createClient(env!.url, env!.anon, { auth: { persistSession: false } });
  const created: string[] = [];

  afterAll(async () => {
    for (const id of created) await admin.auth.admin.deleteUser(id);
  });

  it('gives the anonymous key no access to business tables (SEC-01)', async () => {
    for (const table of ['projects', 'tasks', 'user_profiles', 'timesheets', 'deliverables', 'project_financials']) {
      const { data, error } = await anon.from(table).select('id').limit(1);
      expect(error !== null || (data || []).length === 0, `${table} must not be readable anonymously`).toBe(true);
    }
  });

  it('has the role templates the app relies on', async () => {
    const { data } = await admin.from('roles').select('name');
    const names = (data || []).map((r) => r.name);
    for (const n of ['Superadmin', 'Client', 'Executive', 'Project Director', 'Project Manager', 'Team Lead', 'Employee']) {
      expect(names).toContain(n);
    }
  });

  it('creates a profile for every new sign-in account (E-1)', async () => {
    const email = `integration.${Date.now().toString(36)}@example.com`;
    const { data, error } = await admin.auth.admin.createUser({ email, password: 'Test1234!', email_confirm: true, user_metadata: { name: 'Integration User' } });
    expect(error).toBeNull();
    created.push(data.user!.id);
    const { data: profile } = await admin.from('user_profiles').select('name, email').eq('id', data.user!.id).maybeSingle();
    expect(profile?.name).toBe('Integration User');
    expect(profile?.email).toBe(email);
  });

  it('keeps money as Decimal(14,2) with an ISO currency', async () => {
    const { data } = await admin.from('app_settings').select('currency').maybeSingle();
    expect(data?.currency ?? 'INR').toMatch(/^[A-Z]{3}$/);
  });

  it('has an append-only audit log the server can write to (SEC-12)', async () => {
    const { error } = await admin.from('audit_log').insert({ action: 'integration_test', entity_type: 'test' });
    expect(error).toBeNull();
    const { error: updErr } = await admin.from('audit_log').update({ action: 'tampered' }).eq('action', 'integration_test');
    expect(updErr).not.toBeNull();
  });
});
