// Builds the `project` schema baseline for the shared GrowSpark database from the current schema.
//
// Input: a pg_dump of `public` (schema with privileges, --no-owner) and of the reference data, taken from a
// database built fresh from supabase/migrations + supabase/seed.sql (the rehearsal stack does this).
// Output: prisma/migrations/<name>/migration.sql, applied on the shared database by project_migrator.
//
// Rewrites (see the shared database preparation plan, section 3):
//   public.*                      -> project.*
//   auth.uid() / auth.role()      -> project.current_user_id() / project.request_role()
//   extensions.uuid_generate_v4() -> gen_random_uuid()
//   FK user_profiles -> auth.users, handle_new_user()   -> removed (the app creates profiles)
//   grants to anon / authenticated / service_role       -> project_anon / project_user / project_system
//   functions without a pinned search_path              -> pinned to project, pg_temp
//   + one allow-all policy per table for project_system (server jobs), EXECUTE revoked from PUBLIC,
//     default privileges for later objects.
// It fails if anything still points at public, auth, extensions or another schema.
//
// Usage: node scripts/shared-db/build-baseline.mjs --container supabase_db_pm-shared-rehearsal [--out <dir>]
//        node scripts/shared-db/build-baseline.mjs --schema schema.sql --data data.sql [--out <dir>]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const OUT = arg('out', path.join(ROOT, 'prisma', 'migrations', '20261124000000_project_baseline'));

function dump(container, args) {
  return execFileSync('docker', ['exec', container, 'pg_dump', '-U', 'postgres', '-d', 'postgres', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}
const container = arg('container');
const schemaSql = container ? dump(container, ['--schema-only', '-n', 'public', '--no-owner']) : fs.readFileSync(arg('schema'), 'utf8');
const dataSql = container ? dump(container, ['--data-only', '--column-inserts', '-t', 'public.roles', '-t', 'public.app_settings']) : fs.readFileSync(arg('data'), 'utf8');

const clean = (s) => s.replace(/\r\n/g, '\n').split('\n').filter((l) => !/^\\(un)?restrict /.test(l)).join('\n');

// pg_dump writes each object after a header: "-- Name: <name>; Type: <type>; Schema: <schema>; Owner: -"
function sections(sql) {
  const parts = clean(sql).split(/\n--\n-- (?=Name: )/);
  const header = parts.shift();
  return {
    header,
    items: parts.map((p) => {
      const m = p.match(/^Name: (.*?); Type: (.*?); Schema: (.*?); Owner: .*\n--\n/);
      if (!m) throw new Error(`Unexpected dump section: ${p.slice(0, 120)}`);
      return { name: m[1], type: m[2], schema: m[3], body: p.slice(m[0].length).trim() };
    }),
  };
}

const ROLE_MAP = { anon: 'project_anon', authenticated: 'project_user', service_role: 'project_system' };
const REQUEST_ROLES = 'project_user, project_anon, project_system';

function rewrite(body) {
  return body
    .replace(/SET search_path TO 'public', 'pg_temp'/g, "SET search_path TO 'project', 'pg_temp'")
    .replace(/\bauth\.uid\(\)/g, 'project.current_user_id()')
    .replace(/\bauth\.role\(\)/g, 'project.request_role()')
    .replace(/\bextensions\.uuid_generate_v4\(\)/g, 'gen_random_uuid()')
    .replace(/\bpublic\./g, 'project.');
}

function rewriteAcl(body) {
  const out = [];
  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    if (/ TO postgres;$/.test(line)) continue;
    const m = line.match(/^(GRANT|REVOKE) (.*) (TO|FROM) (anon|authenticated|service_role|PUBLIC);$/);
    if (!m) throw new Error(`Unexpected ACL line: ${line}`);
    out.push(`${m[1]} ${rewrite(m[2])} ${m[3]} ${m[4] === 'PUBLIC' ? 'PUBLIC' : ROLE_MAP[m[4]]};`);
  }
  return out.join('\n');
}

// Functions without a pinned search_path get one (lookups stay inside project)
function pinSearchPath(body) {
  if (/\n\s*SET search_path TO /.test(body)) return body;
  return body.replace(/\n(\s*)AS \$/, (m, ws) => `\n${ws}SET search_path TO 'project', 'pg_temp'\n${ws}AS $`);
}

const { header, items } = sections(schemaSql);
const kept = [];
const removed = [];
const rlsTables = [];
for (const it of items) {
  const what = `${it.type} ${it.name}`;
  if (it.type === 'SCHEMA' || (it.type === 'COMMENT' && it.name === 'SCHEMA public') || (it.type === 'ACL' && it.name === 'SCHEMA public')) { removed.push(what); continue; }
  if (/handle_new_user/.test(it.name)) { removed.push(what); continue; }
  if (it.type === 'DEFAULT ACL') { removed.push(`Supabase ${what}`); continue; }
  if (it.type === 'FK CONSTRAINT' && /REFERENCES auth\./.test(it.body)) { removed.push(what); continue; }
  if (it.schema !== 'public' && it.schema !== '-') throw new Error(`Object outside public: ${what} (${it.schema})`);
  let body = it.type === 'ACL' ? rewriteAcl(it.body) : rewrite(it.body);
  if (it.type === 'FUNCTION') body = pinSearchPath(body);
  const rls = body.match(/^ALTER TABLE project\.(\w+) ENABLE ROW LEVEL SECURITY;$/m);
  if (rls) rlsTables.push(rls[1]);
  kept.push(`-- ${it.type}: ${it.name}\n${body}`);
}

const dataRows = clean(dataSql).split('\n').filter((l) => /^INSERT INTO public\./.test(l)).map((l) => l.replace(/^INSERT INTO public\./, 'INSERT INTO project.'));
// pg_dump's session settings, made transaction-local: Prisma records the migration on the same connection
// afterwards and needs its own search_path back
const sessionSettings = header.split('\n')
  .filter((l) => /^SET |^SELECT pg_catalog\.set_config/.test(l))
  .map((l) => l.replace(/^SET /, 'SET LOCAL ').replace(/set_config\('search_path', '', false\)/, "set_config('search_path', '', true)"))
  .join('\n');

const sql = `-- Project Management baseline for the \`project\` schema on the shared GrowSpark database.
-- Generated by scripts/shared-db/build-baseline.mjs from the schema built by supabase/migrations
-- (34 migrations, last 20261122001300) and supabase/seed.sql. Review changes in this file, not in the dump.
--
-- Run as project_migrator (owner of everything created here), after db/shared/roles.sql.
-- Removed: ${removed.join('; ')}.

-- All or nothing: a failure part-way leaves nothing behind.
BEGIN;

${sessionSettings}

-- Who is asking. The server sets these per request, inside the transaction (lib/db withUser / withAnon /
-- withSystem), as PostgREST does from a verified JWT. No SET search_path: the bodies use only pg_catalog,
-- which keeps them inlinable in policies.
CREATE FUNCTION project.current_user_id() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$
  SELECT nullif(coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  ), '')::uuid
$$;
COMMENT ON FUNCTION project.current_user_id() IS 'The signed-in user''s id for this request (replaces auth.uid()); NULL when signed out or for server jobs.';

-- The request's role. The database role decides first, so a project_user request can never pass as a
-- trusted server job even without claims; claims are used only for other roles (the rehearsal harness).
CREATE FUNCTION project.request_role() RETURNS text
    LANGUAGE sql STABLE
    AS $$
  SELECT CASE pg_catalog.current_setting('role', true)
    WHEN 'project_user' THEN 'authenticated'
    WHEN 'project_anon' THEN 'anon'
    WHEN 'project_system' THEN 'service_role'
    ELSE coalesce(
      nullif(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
      nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  END
$$;
COMMENT ON FUNCTION project.request_role() IS 'authenticated / anon / service_role for this request (replaces auth.role()).';

${kept.join('\n\n')}

-- Reference data (system and default roles, the settings row)
${dataRows.join('\n')}

-- Server jobs: project_system may read and write every table through an explicit policy, instead of a
-- role that bypasses row-level security.
${rlsTables.map((t) => `CREATE POLICY project_system_all ON project.${t} TO project_system USING (true) WITH CHECK (true);`).join('\n')}

-- Functions run only for the three request roles (each was granted above, as before)
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA project FROM PUBLIC;
GRANT EXECUTE ON FUNCTION project.current_user_id() TO ${REQUEST_ROLES};
GRANT EXECUTE ON FUNCTION project.request_role() TO ${REQUEST_ROLES};

-- Objects created by later migrations get the same rights. (Per-schema defaults cannot take EXECUTE away
-- from PUBLIC; PUBLIC has no USAGE on project, and each later migration revokes it explicitly.)
ALTER DEFAULT PRIVILEGES IN SCHEMA project GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO project_user, project_system;
ALTER DEFAULT PRIVILEGES IN SCHEMA project GRANT USAGE, SELECT ON SEQUENCES TO project_user, project_system;
ALTER DEFAULT PRIVILEGES IN SCHEMA project GRANT EXECUTE ON FUNCTIONS TO ${REQUEST_ROLES};

COMMIT;
`;

// Nothing may point outside project any more
const code = sql.split('\n').filter((l) => !/^\s*--/.test(l) && !/^COMMENT ON /.test(l)).join('\n');
const leftovers = [...code.matchAll(/\b(public|auth|extensions|storage|realtime|vault|graphql|sales|hr)\.[a-z_]+/g)].map((m) => m[0]);
if (leftovers.length) throw new Error(`References outside project remain: ${[...new Set(leftovers)].join(', ')}`);
for (const role of ['anon', 'authenticated', 'service_role', 'postgres']) {
  if (new RegExp(`\\b(TO|FROM) ${role}\\b`).test(sql)) throw new Error(`Grant to ${role} remains`);
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'migration.sql'), sql);
const lock = path.join(path.dirname(OUT), 'migration_lock.toml');
if (!fs.existsSync(lock)) fs.writeFileSync(lock, '# Please do not edit this file manually\n# It should be added in your version-control system (e.g., Git)\nprovider = "postgresql"\n');
const count = (re) => (sql.match(re) || []).length;
console.log(`Wrote ${path.relative(ROOT, path.join(OUT, 'migration.sql'))}`);
console.log(`  tables ${count(/^CREATE TABLE /gm)}, views ${count(/^CREATE VIEW /gm)}, functions ${count(/^CREATE FUNCTION /gm)}, triggers ${count(/^CREATE TRIGGER /gm)}, policies ${count(/^CREATE POLICY /gm)} (incl. ${rlsTables.length} for project_system), reference rows ${dataRows.length}`);
console.log(`  removed: ${removed.join('; ')}`);
