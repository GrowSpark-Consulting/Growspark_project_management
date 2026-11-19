// Suite: application code vs. database schema.
// Builds the schema from the migration files, then scans every Supabase query chain in
// app/, components/ and lib/ (.from(table) + select list, filters, insert/update keys).
// Any table or column that the migrations never create is a failure, unless it is in
// KNOWN_PRE_EXISTING below (older code not changed by this work, reported as "known").
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, MIGRATIONS_DIR } from '../lib/harness.mjs';

export const name = 'Schema drift (code vs. migrations)';

// Pre-existing references to things that do not exist. Each one is listed in
// IMPLEMENTATION_CHECKLIST.md. Remove an entry when it is fixed.
const KNOWN_PRE_EXISTING = {
  'user_profiles.is_approved': 'D-4 signup-approval service (lib/user-approval-service.ts)',
  'user_profiles.approved_at': 'D-4 signup-approval service',
  'user_profiles.approved_by': 'D-4 signup-approval service',
  'user_profiles.approval_requested_at': 'D-4 signup-approval service',
  'pending_user_approvals': 'D-4 signup-approval service',
  'form_templates.fields': 'D-5 legacy form service (lib/form-service.ts); live table uses "schema"',
  'form_templates.is_active': 'D-5 legacy form service',
  'project_contributors': 'Optional table, handled gracefully (app/projects/[projectId]/page.tsx)',
  'project_issues.updated_at': 'Unused helper updateIssueContent (lib/project-issues-service.ts)',
  'account_kanban_configs.count': 'Not a column: count option parsed as one by this checker',
};

function splitTopLevel(s) {
  let depth = 0, cur = '';
  const parts = [];
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  parts.push(cur);
  return parts;
}

export function schemaFromMigrations() {
  const schema = {};
  const add = (t, c) => (schema[t] ||= new Set()).add(c);
  const norm = (s) => s.replace(/"/g, '').replace(/^public\./, '').trim();
  for (const f of fs.readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith('.sql')).sort()) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8').replace(/--[^\n]*/g, '');
    let m;
    const ct = /CREATE TABLE (?:IF NOT EXISTS )?([\w".]+)\s*\(([\s\S]*?)\n\);/gi;
    while ((m = ct.exec(sql))) {
      const t = norm(m[1]);
      schema[t] ||= new Set();
      for (const p of splitTopLevel(m[2])) {
        const w = p.trim().match(/^"?([a-z_][a-z0-9_]*)"?\s+/i);
        if (w && !/^(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|EXCLUDE)$/i.test(w[1])) add(t, w[1]);
      }
    }
    const at = /ALTER TABLE (?:IF EXISTS )?(?:ONLY )?([\w".]+)([\s\S]*?);/gi;
    while ((m = at.exec(sql))) {
      const t = norm(m[1]);
      let c;
      const ac = /ADD COLUMN (?:IF NOT EXISTS )?"?([a-z_][a-z0-9_]*)"?/gi;
      while ((c = ac.exec(m[2]))) add(t, c[1]);
      const rn = /RENAME COLUMN "?(\w+)"? TO "?(\w+)"?/gi;
      while ((c = rn.exec(m[2]))) add(t, c[2]);
    }
    const cv = /CREATE (?:OR REPLACE )?VIEW ([\w".]+)/gi;
    while ((m = cv.exec(sql))) schema[norm(m[1])] = new Set(['*VIEW*']);
  }
  return schema;
}

function walk(p, out = []) {
  if (!fs.existsSync(p)) return out;
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(p)) if (e !== 'node_modules' && !e.startsWith('.')) walk(path.join(p, e), out);
  } else if (/\.(ts|tsx)$/.test(p)) out.push(p);
  return out;
}

const FILTERS = ['eq', 'neq', 'is', 'in', 'gte', 'lte', 'gt', 'lt', 'order', 'not', 'contains', 'ilike', 'like', 'overlaps'];

export function scanCode(schema) {
  const findings = new Map(); // key -> [locations]
  const files = ['app', 'components', 'lib'].flatMap((d) => walk(path.join(ROOT, d)));
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const re = /\.from\(\s*'([a-z_]+)'\s*\)/g;
    let m;
    while ((m = re.exec(src))) {
      const table = m[1];
      const where = `${path.relative(ROOT, f).split(path.sep).join('/')}:${src.slice(0, m.index).split('\n').length}`;
      const note = (key) => { if (!findings.has(key)) findings.set(key, []); findings.get(key).push(where); };
      if (!schema[table]) { note(table); continue; }
      if (schema[table].has('*VIEW*')) continue;
      let end = src.indexOf('.from(', m.index + 5);
      if (end < 0) end = src.length;
      let chain = src.slice(m.index, Math.min(end, m.index + 900));
      const stop = chain.search(/\n\s*\n|;\s*\n\s*(const|let|if|return|await|for)\b/);
      if (stop > 0) chain = chain.slice(0, stop);
      const cols = new Set();
      const sel = /\.select\(\s*(['`])([\s\S]*?)\1/.exec(chain);
      if (sel && !sel[2].includes('${')) {
        for (let p of splitTopLevel(sel[2])) {
          p = p.trim();
          if (!p || p === '*' || p.includes('(') || p.includes('!')) continue;
          p = p.replace(/::\w+$/, '');
          if (p.includes(':')) p = p.split(':')[1].trim();
          if (/^[a-z_][a-z0-9_]*$/.test(p)) cols.add(p);
        }
      }
      for (const fn of FILTERS) {
        const fr = new RegExp(`\\.${fn}\\(\\s*'([a-z_][a-z0-9_]*)'`, 'g');
        let c;
        while ((c = fr.exec(chain))) cols.add(c[1]);
      }
      const wr = /\.(insert|update|upsert)\(\s*\[?\s*\{/g;
      let w;
      while ((w = wr.exec(chain))) {
        let i = w.index + w[0].length, depth = 1, body = '';
        while (i < chain.length && depth > 0) {
          const ch = chain[i];
          if ('{(['.includes(ch)) depth++;
          if ('})]'.includes(ch)) depth--;
          body += depth === 1 ? ch : ' ';
          i++;
        }
        for (const k of body.matchAll(/(?:^|,|\{)\s*([a-z_][a-z0-9_]*)\s*(?=[:,}]|$)/g)) {
          if (!['true', 'false', 'null'].includes(k[1])) cols.add(k[1]);
        }
      }
      for (const c of cols) if (!schema[table].has(c)) note(`${table}.${c}`);
    }
  }
  return { findings, fileCount: files.length };
}

export async function run(report) {
  const schema = schemaFromMigrations();
  const { findings, fileCount } = scanCode(schema);
  const unknown = [...findings.entries()].filter(([k]) => !KNOWN_PRE_EXISTING[k]);
  const known = [...findings.entries()].filter(([k]) => KNOWN_PRE_EXISTING[k]);

  await report.check('DRIFT-new', `No code references a table or column the migrations never create (${fileCount} files scanned)`, () => ({
    pass: unknown.length === 0,
    info: unknown.map(([k, locs]) => `${k}  <- ${locs.slice(0, 3).join(', ')}${locs.length > 3 ? ` (+${locs.length - 3})` : ''}`).join('\n          '),
  }));

  // Regression guards for the fixed defects: these references must stay gone.
  const fixed = {
    'D-1': ['projects.completed_at'],
    'D-2': ['workflow_history.handed_off_by', 'workflow_history.handed_off_to', 'workflow_history.handed_off_at', 'workflow_history.out_of_order', 'workflow_history.branch_id'],
    'D-3': ['project_updates.update_type', 'projects.workflow_instance_id'],
    'G-6': ['projects.budget', 'projects.hourly_rate'],
  };
  for (const [id, keys] of Object.entries(fixed)) {
    await report.check(`${id} drift`, `${id}: code and schema agree (${keys.join(', ')})`, () => {
      const bad = keys.filter((k) => findings.has(k));
      return { pass: bad.length === 0, info: bad.map((k) => `${k} <- ${findings.get(k).slice(0, 3).join(', ')}`).join('; ') };
    });
  }

  for (const [k, locs] of known) {
    report.record('KNOWN', `Known pre-existing (not fixed): ${k} — ${KNOWN_PRE_EXISTING[k]}`, 'PASS', locs.slice(0, 2).join(', '));
  }
  for (const k of Object.keys(KNOWN_PRE_EXISTING)) {
    if (!findings.has(k)) report.record('KNOWN-gone', `Allowlist entry no longer needed: ${k} (remove it from KNOWN_PRE_EXISTING)`, 'PASS');
  }
}
