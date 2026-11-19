// Shared helpers for the local database tests.
// - createDatabase(): fresh in-memory PostgreSQL (PGlite) + Supabase shim + every migration, in order
// - sessions(db): run SQL as anon / a signed-in user (RLS applies) / the owner (no RLS)
// - Report: collects PASS / FAIL / ERROR results without ever crashing the run
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DB_TESTS_DIR = path.resolve(here, '..');
export const ROOT = path.resolve(DB_TESTS_DIR, '..', '..');
export const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');

async function loadPGlite() {
  try {
    return (await import('@electric-sql/pglite')).PGlite;
  } catch {
    throw new Error('PGlite is not installed. Run "npm install" in the project folder first (dev dependency @electric-sql/pglite).');
  }
}

/**
 * Migration files in apply order. DB_TEST_SKIP_MIGRATIONS (comma-separated filename prefixes)
 * leaves some out, e.g. to show that the rule checks fail without a fix migration.
 */
export function migrationFiles() {
  const skip = (process.env.DB_TEST_SKIP_MIGRATIONS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => !skip.some((prefix) => f.startsWith(prefix)))
    .sort();
}

/** Short excerpt of the SQL around an error position, for readable failure messages. */
function excerpt(sql, position) {
  const pos = Number(position);
  if (!pos) return '';
  const start = Math.max(0, pos - 200);
  const line = sql.slice(0, pos).split('\n').length;
  return `around line ${line}:\n${sql.slice(start, pos + 150).split('\n').map((l) => '      | ' + l).join('\n')}`;
}

/**
 * Fresh database with the shim and all migrations applied in filename order.
 * Never throws for a failing migration: returns { db, migrations: [{ file, ok, error, context }] }
 * and stops at the first failure (later migrations depend on earlier ones).
 */
export async function createDatabase() {
  const PGlite = await loadPGlite();
  const db = new PGlite();
  await db.exec(fs.readFileSync(path.join(DB_TESTS_DIR, 'supabase-shim.sql'), 'utf8'));
  const migrations = [];
  for (const file of migrationFiles()) {
    let sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    // pg_dump artefact PGlite cannot honour (owner role does not exist locally)
    sql = sql.replace(/ALTER SCHEMA "public" OWNER TO "pg_database_owner";/g, '');
    // Each migration starts with normal session settings, like a fresh connection
    await db.exec('RESET ROLE; SET row_security = on; SET search_path TO public, extensions; SET check_function_bodies = true;');
    try {
      await db.exec(sql);
      migrations.push({ file, ok: true });
    } catch (e) {
      migrations.push({ file, ok: false, error: `${e.code || ''} ${e.message}`.trim(), context: excerpt(sql, e.position) });
      break;
    }
  }
  // The baseline dump turns off row security etc. for its own session; restore normal settings
  await db.exec('RESET ROLE; SET row_security = on; SET search_path TO public, extensions; SET check_function_bodies = true;');
  return { db, migrations, allApplied: migrations.length === migrationFiles().length && migrations.every((m) => m.ok) };
}

/** Run SQL under different identities. Errors are returned, never thrown, by tryQ. */
export function sessions(db) {
  const clearClaims = () => db.query(`select set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claim.role', '', false)`);
  return {
    /** As the database owner: no JWT, no RLS (like a migration or the SQL editor). */
    q: (sql, params) => db.query(sql, params),
    async tryQ(sql, params) {
      try {
        const r = await db.query(sql, params);
        return { ok: true, rows: r.rows, affected: r.affectedRows ?? 0 };
      } catch (e) {
        return { ok: false, code: e.code, msg: e.message, rows: [], affected: 0 };
      }
    },
    /** As a signed-in user (role authenticated, auth.uid() = uid). RLS and triggers apply. */
    async asUser(uid, fn) {
      await db.exec('RESET ROLE');
      await db.query(`select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.role', 'authenticated', false)`, [uid]);
      await db.exec('SET ROLE authenticated');
      try { return await fn(); } finally { await db.exec('RESET ROLE'); await clearClaims(); }
    },
    /** As the anonymous role (anon JWT, no user). */
    async asAnon(fn) {
      await db.exec('RESET ROLE');
      await db.query(`select set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claim.role', 'anon', false)`);
      await db.exec('SET ROLE anon');
      try { return await fn(); } finally { await db.exec('RESET ROLE'); await clearClaims(); }
    },
    /** As the server with the service-role key (RLS bypassed, triggers see role = service_role). */
    async asService(fn) {
      await db.exec('RESET ROLE');
      await db.query(`select set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claim.role', 'service_role', false)`);
      await db.exec('SET ROLE service_role');
      try { return await fn(); } finally { await db.exec('RESET ROLE'); await clearClaims(); }
    },
  };
}

/** A denied write either errors or (RLS filter) changes zero rows. */
export const denied = (r) => !r.ok || r.affected === 0;
export const describe = (r) => (r.ok ? `allowed, ${r.affected} row(s)` : `${r.code} ${r.msg}`);

export class Report {
  constructor(suite) {
    this.suite = suite;
    this.results = [];
  }
  record(id, name, status, info = '') {
    this.results.push({ id, name, status, info });
  }
  /**
   * Run one check. fn returns true/false or { pass, info }. Exceptions become ERROR results
   * (the run continues), so one broken check never hides the others.
   */
  async check(id, name, fn) {
    try {
      const r = await fn();
      const pass = typeof r === 'object' && r !== null ? !!r.pass : !!r;
      const info = typeof r === 'object' && r !== null ? r.info || '' : '';
      this.record(id, name, pass ? 'PASS' : 'FAIL', info);
    } catch (e) {
      this.record(id, name, 'ERROR', e && e.message ? e.message : String(e));
    }
  }
  get counts() {
    const c = { PASS: 0, FAIL: 0, ERROR: 0 };
    for (const r of this.results) c[r.status]++;
    return c;
  }
  get ok() {
    return this.counts.FAIL === 0 && this.counts.ERROR === 0;
  }
  print({ verbose = false } = {}) {
    console.log(`\n=== ${this.suite} ===`);
    for (const r of this.results) {
      if (r.status === 'PASS' && !verbose) continue;
      const tag = r.status === 'PASS' ? 'PASS ' : r.status === 'FAIL' ? 'FAIL ' : 'ERROR';
      console.log(`${tag}  ${r.id.padEnd(18)} ${r.name}${r.info && r.status !== 'PASS' ? `\n       -> ${r.info}` : ''}`);
    }
    const c = this.counts;
    console.log(`${this.suite}: ${c.PASS} passed, ${c.FAIL} failed, ${c.ERROR} errors (${this.results.length} checks)`);
  }
}
