// Suite: every /api/... URL called from pages, components and lib/ resolves to a route
// file that exports that HTTP method. Catches renamed or deleted routes and wrong methods.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../lib/harness.mjs';

export const name = 'API wiring (UI calls vs. route files)';

// Strings that look like API paths but are not calls (prefix lists)
const IGNORE = new Set(['/api/', '/api/auth', '/api/login', '/api/register', '/api/signup', '/api/password', '/api/reset']);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(tsx?|jsx?)$/.test(e.name)) out.push(p);
  }
  return out;
}

export async function run(report) {
  const apiDir = path.join(ROOT, 'app', 'api');
  const routes = walk(apiDir).filter((f) => /route\.(ts|js)$/.test(f)).map((f) => {
    const segs = path.relative(apiDir, path.dirname(f)).split(path.sep).filter(Boolean);
    const src = fs.readFileSync(f, 'utf8');
    const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].filter((m) =>
      new RegExp(`export\\s+(const|async\\s+function|function)\\s+${m}\\b`).test(src) || new RegExp(`export\\s*\\{[^}]*\\b${m}\\b`).test(src)));
    return { segs, methods, file: path.relative(ROOT, f).split(path.sep).join('/') };
  });
  const match = (urlSegs) => routes
    .filter((r) => r.segs.length === urlSegs.length && r.segs.every((s, i) => s.startsWith('[') || s === urlSegs[i]))
    .sort((a, b) => b.segs.filter((s) => !s.startsWith('[')).length - a.segs.filter((s) => !s.startsWith('[')).length)[0];

  const uiFiles = ['app', 'components', 'lib'].flatMap((d) => walk(path.join(ROOT, d)))
    .filter((f) => !f.includes(path.join('app', 'api') + path.sep));
  const problems = [];
  let checked = 0;
  for (const f of uiFiles) {
    const src = fs.readFileSync(f, 'utf8');
    const re = /([`'"])(\/api\/[^`'"\s]*)\1/g;
    let m;
    while ((m = re.exec(src))) {
      const url = m[2];
      const clean = url.replace(/\$\{[^}]*\}/g, 'X').split('?')[0].replace(/\/$/, '');
      if (IGNORE.has(url) || IGNORE.has(clean)) continue;
      const before = src.slice(Math.max(0, m.index - 40), m.index);
      const after = src.slice(m.index, m.index + 300);
      let method = 'GET';
      if (/apiSend\(\s*$/.test(before)) method = (/,\s*'(GET|POST|PUT|PATCH|DELETE)'/.exec(after.slice(0, 200)) || [])[1] || '?';
      else if (/apiUpload\(\s*$/.test(before)) method = 'POST';
      else if (/fetch\(\s*$/.test(before)) method = (/method:\s*['"](GET|POST|PUT|PATCH|DELETE)['"]/.exec(after) || [])[1] || 'GET';
      checked++;
      const where = `${path.relative(ROOT, f).split(path.sep).join('/')}:${src.slice(0, m.index).split('\n').length}`;
      const r = match(clean.replace(/^\/api\/?/, '').split('/').filter(Boolean));
      if (!r) problems.push(`no route for ${method} ${url}  <- ${where}`);
      else if (method !== '?' && !r.methods.has(method)) problems.push(`${r.file} has no ${method} (has ${[...r.methods].join(',')}) for ${url}  <- ${where}`);
    }
  }
  await report.check('WIRING', `Every API call in the UI matches a route and method (${checked} calls, ${routes.length} routes)`, () => ({
    pass: problems.length === 0,
    info: problems.join('\n          '),
  }));
}
