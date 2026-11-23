/**
 * Phase 11 query layer (lib/db/query.ts) against the real Supabase Data API, on the LOCAL database.
 * The same queries go through PostgREST (supabase-js) and through the layer (Prisma); results must match.
 *
 * - Every static select in the codebase (.from('t').select(`...`)) is run both ways, as the server and as a
 *   project manager, so every nested relationship the app uses is compared.
 * - Curated cases: filters, or(), counts, single(), writes, row-level security refusals, anonymous access,
 *   concurrent users and a database function.
 *
 * Needs local Supabase with the e2e seed (npm run e2e:local:seed) and DATABASE_URL in .env.development.local.
 * Skipped otherwise. Never runs against anything but localhost; the rows it writes are removed again.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { config } from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { queryClient, type Runner } from '@/lib/db/query';
import { db } from '@/lib/db';

const ROOT = path.resolve(__dirname, '..', '..');
config({ path: path.join(ROOT, '.env.development.local'), quiet: true });
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const ANON = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY || '';
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const local = (u?: string) => !!u && ['127.0.0.1', 'localhost'].includes(new URL(u).hostname);
const PASSWORD = 'Test1234!';
const PERSONAS = ['superadmin', 'pm', 'emp1', 'emp2', 'outsider', 'client'] as const;
const EMAIL: Record<string, string> = {
  superadmin: 'e2e.superadmin@example.com', pm: 'e2e.pm@example.com', emp1: 'e2e.emp1@example.com',
  emp2: 'e2e.emp2@example.com', outsider: 'e2e.outsider@example.com', client: 'e2e.client@example.com',
};
const WEBSITE = '0e2e0000-0000-4000-8000-00000000b001';

let ready = false;
if (local(URL_) && local(process.env.DATABASE_URL) && SERVICE) {
  try {
    const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } });
    const { data } = await admin.from('user_profiles').select('id').eq('email', EMAIL.pm).maybeSingle();
    ready = !!data;
  } catch {
    ready = false;
  }
}

type Both = { rest: SupabaseClient; layer: ReturnType<typeof queryClient>; id?: string };
const as: Record<string, Both> = {};

/** Stable form for comparison: arrays sorted (nested arrays have no guaranteed order), keys sorted. */
function normalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalize).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, normalize(x)]));
  return v;
}
const outcome = (r: { data: unknown; error: { code?: string } | null; count?: number | null }) =>
  ({ data: r.error ? null : normalize(r.data), code: r.error?.code ?? null, count: r.count ?? null });

/** Every static `.from('table').select(...)` in the app's source. */
function codebaseSelects(): { table: string; select: string; where: string }[] {
  const out = new Map<string, { table: string; select: string; where: string }>();
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!['generated', 'node_modules'].includes(e.name)) walk(p); continue; }
      if (!/\.(ts|tsx)$/.test(e.name)) continue;
      const src = fs.readFileSync(p, 'utf8');
      for (const m of src.matchAll(/\.from\(\s*['"]([a-z_]+)['"]\s*\)\s*\.select\(\s*(`[^`$]*`|'[^']*'|"[^"]*")/g)) {
        const select = m[2].slice(1, -1).replace(/\s+/g, ' ').trim();
        const key = `${m[1]}|${select}`;
        if (!out.has(key)) out.set(key, { table: m[1], select, where: path.relative(ROOT, p) });
      }
    }
  };
  for (const d of ['app', 'lib', 'components']) walk(path.join(ROOT, d));
  return [...out.values()];
}

describe.skipIf(!ready)('query layer matches the Supabase Data API', () => {
  beforeAll(async () => {
    as.system = { rest: createClient(URL_, SERVICE, { auth: { persistSession: false } }), layer: queryClient({ kind: 'system' }) };
    const anonRunner: Runner = { kind: 'user', userId: async () => null };
    as.anon = { rest: createClient(URL_, ANON, { auth: { persistSession: false } }), layer: queryClient(anonRunner) };
    for (const who of PERSONAS) {
      const auth = createClient(URL_, ANON, { auth: { persistSession: false } });
      const { data, error } = await auth.auth.signInWithPassword({ email: EMAIL[who], password: PASSWORD });
      if (error || !data.session) throw new Error(`sign-in ${who}: ${error?.message}`);
      const rest = createClient(URL_, ANON, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${data.session.access_token}` } } });
      const id = data.user.id;
      as[who] = { rest, layer: queryClient({ kind: 'user', userId: async () => id }), id };
    }
  }, 60_000);

  afterAll(async () => {
    await as.system?.rest.from('notifications').delete().like('title', 'qltest-%');
    await db().$disconnect();
  });

  it('every static select in the codebase returns the same rows and nesting, as the server and as a project manager', async () => {
    const selects = codebaseSelects();
    expect(selects.length).toBeGreaterThan(100);
    const mismatches: string[] = [];
    for (const s of selects) {
      for (const who of ['system', 'pm'] as const) {
        const run = (c: Both['rest'] | Both['layer']) => (c as any).from(s.table).select(s.select).limit(25);
        const [a, b] = await Promise.all([run(as[who].rest), run(as[who].layer)]);
        const ra = outcome(a), rb = outcome(b);
        if (JSON.stringify(ra) !== JSON.stringify(rb)) {
          mismatches.push(`${who} ${s.where} ${s.table}: rest ${ra.code ?? `${(a.data || []).length} rows`} vs layer ${rb.code ?? `${(b.data || []).length} rows`}${!ra.code && !rb.code ? ' (different data)' : ` [${b.error?.message ?? ''} | ${a.error?.message ?? ''}]`}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  }, 300_000);

  const cases: { name: string; who: string[]; q: (c: any) => any; ordered?: boolean }[] = [
    { name: 'or() on two columns', who: ['system', 'pm', 'emp1'], q: (c) => c.from('projects').select('id, name').or(`created_by.eq.${as.pm.id},assigned_user_id.eq.${as.pm.id}`) },
    { name: 'in / not is / gte / ilike', who: ['system', 'pm'], q: (c) => c.from('tasks').select('id, status').in('status', ['todo', 'in_progress', 'review']).not('assigned_to', 'is', null).gte('created_at', '2000-01-01').ilike('name', '%') },
    { name: 'filter on a !inner embedded resource', who: ['system', 'pm'], q: (c) => c.from('user_roles').select('user_id, roles!inner(name)').eq('roles.name', 'Employee') },
    { name: 'filter two levels down', who: ['system', 'superadmin'], q: (c) => c.from('user_profiles').select('id, user_roles!inner(roles!inner(name))').eq('user_roles.roles.name', 'Project Manager') },
    { name: 'count only', who: ['system', 'pm', 'emp1'], q: (c) => c.from('tasks').select('*', { count: 'exact', head: true }).eq('project_id', WEBSITE) },
    { name: 'count with rows', who: ['system', 'pm'], q: (c) => c.from('projects').select('id', { count: 'exact' }).order('id').range(0, 1), ordered: true },
    { name: 'nested count', who: ['system'], q: (c) => c.from('roles').select('id, name, user_roles(count)').order('name'), ordered: true },
    { name: 'order, limit and nulls', who: ['system', 'pm'], q: (c) => c.from('projects').select('id, end_date').order('end_date', { ascending: false, nullsFirst: false }).order('id').limit(3), ordered: true },
    { name: 'single() with one row', who: ['system', 'pm'], q: (c) => c.from('user_profiles').select('id, name').eq('id', as.pm.id).single() },
    { name: 'single() with no row', who: ['system', 'pm'], q: (c) => c.from('user_profiles').select('id').eq('id', '00000000-0000-0000-0000-000000000000').single() },
    { name: 'maybeSingle() with no row', who: ['system'], q: (c) => c.from('user_profiles').select('id').eq('id', '00000000-0000-0000-0000-000000000000').maybeSingle() },
    { name: 'filter() and match()', who: ['system'], q: (c) => c.from('projects').select('id').filter('status', 'in', '(planning,in_progress)').match({ priority: 'medium' }) },
    { name: 'a database function', who: ['system', 'pm'], q: (c) => c.rpc('get_project_stakeholders', { project_uuid: WEBSITE }) },
    { name: 'signed-out access to projects', who: ['anon'], q: (c) => c.from('projects').select('id') },
    { name: 'a client sees only their projects', who: ['client'], q: (c) => c.from('projects').select('id, name') },
  ];
  for (const k of cases) {
    it(k.name, async () => {
      for (const who of k.who) {
        const [a, b] = await Promise.all([k.q(as[who].rest), k.q(as[who].layer)]);
        if (k.ordered) {
          expect({ data: b.error ? null : b.data, code: b.error?.code ?? null, count: b.count ?? null }, `${who}`)
            .toEqual({ data: a.error ? null : a.data, code: a.error?.code ?? null, count: a.count ?? null });
        } else {
          expect(outcome(b), `${who}`).toEqual(outcome(a));
        }
      }
    }, 60_000);
  }

  it('keeps concurrent users apart', async () => {
    const who = ['pm', 'emp1', 'emp2', 'outsider', 'client', 'pm', 'emp1', 'client'];
    const ids = (r: any) => (r.data || []).map((x: any) => x.id).sort();
    const rest = await Promise.all(who.map((w) => as[w].rest.from('projects').select('id')));
    const layer = await Promise.all(who.map((w) => as[w].layer.from('projects').select('id')));
    expect(layer.map(ids)).toEqual(rest.map(ids));
    expect(new Set(layer.map((r) => JSON.stringify(ids(r)))).size).toBeGreaterThan(1);
  }, 60_000);

  it('writes: insert, update, upsert and delete return the same rows', async () => {
    const userId = as.emp1.id!;
    const shape = (r: any) => {
      const strip = (x: any) => x && Object.fromEntries(Object.entries(x).filter(([k]) => !['id', 'created_at', 'title'].includes(k)));
      return { data: Array.isArray(r.data) ? r.data.map(strip) : strip(r.data), code: r.error?.code ?? null };
    };
    const ins = async (c: any, tag: string) => c.from('notifications').insert({ user_id: userId, title: `qltest-${tag}`, message: 'm', type: 'test' }).select('*, user_profiles(id, name)').single();
    const [a, b] = await Promise.all([ins(as.system.rest, 'rest'), ins(as.system.layer, 'layer')]);
    expect(shape(b)).toEqual(shape(a));
    const upd = (c: any, id: string) => c.from('notifications').update({ read: true, link: '/x' }).eq('id', id).select('id, read, link');
    const [ua, ub] = await Promise.all([upd(as.system.rest, a.data.id), upd(as.system.layer, b.data.id)]);
    expect(shape(ub)).toEqual(shape(ua));
    const ups = (c: any, id: string) => c.from('notifications').upsert({ id, user_id: userId, title: `qltest-up-${id}`, message: 'm2', type: 'test' }, { onConflict: 'id' }).select('message');
    const [pa, pb] = await Promise.all([ups(as.system.rest, a.data.id), ups(as.system.layer, b.data.id)]);
    expect(shape(pb)).toEqual(shape(pa));
    const noReturn = await as.system.layer.from('notifications').insert({ user_id: userId, title: 'qltest-minimal', message: 'm', type: 'test' });
    expect(noReturn.data).toBeNull();
    expect(noReturn.error).toBeNull();
    const del = (c: any, id: string) => c.from('notifications').delete().eq('id', id).select('message');
    const [da, dbb] = await Promise.all([del(as.system.rest, a.data.id), del(as.system.layer, b.data.id)]);
    expect(shape(dbb)).toEqual(shape(da));
  }, 60_000);

  it('row-level security refuses the same writes', async () => {
    const nl = (c: any) => c.from('newsletters').insert({ title: 'qltest', content: 'x' });
    const [a, b] = await Promise.all([nl(as.emp1.rest), nl(as.emp1.layer)]);
    expect(a.error?.code).toBe('42501');
    expect(b.error?.code).toBe('42501');
    const upd = (c: any) => c.from('projects').update({ description: 'qltest' }).eq('id', WEBSITE).select('id');
    const [ua, ub] = await Promise.all([upd(as.outsider.rest), upd(as.outsider.layer)]);
    expect(outcome(ub)).toEqual(outcome(ua));
    expect(ub.data).toEqual([]);
  }, 60_000);

  it('refuses arbitrary SQL through exec_sql', async () => {
    const r = await as.system.layer.rpc('exec_sql', { query: 'select 1' });
    expect(r.error?.code).toBe('42501');
  });
});
