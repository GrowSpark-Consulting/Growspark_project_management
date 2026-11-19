#!/usr/bin/env node
// Generates app/gs-tokens.css from design/gs-tokens.json (the shared Grow Spark Workspace
// design system: same tokens in Sales & CRM, Project Management and People & HR).
//
//   npm run design:tokens
//
// To update: download tokens.json from the shared design system, replace
// design/gs-tokens.json, run the command above. Never edit app/gs-tokens.css by hand.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'design', 'gs-tokens.json');
const out = path.join(root, 'app', 'gs-tokens.css');

const tokens = JSON.parse(fs.readFileSync(src, 'utf8'));
const themes = (tokens.color?.themes || [{ id: 'light' }]).map((t) => t.id);
const primary = themes[0];
const perTheme = Object.fromEntries(themes.map((t) => [t, []]));
const problems = [];

const valueFor = (value, theme) => {
  if (value && typeof value === 'object') return value[theme] ?? value[primary];
  return value;
};

// Families with themed values: color, shadow. Everything else: one value.
for (const family of ['color', 'shadow']) {
  for (const t of tokens[family]?.tokens || []) {
    for (const theme of themes) {
      const v = valueFor(t.value, theme);
      if (v === undefined || v === null || v === '') { problems.push(`${t.name}: no value for ${theme}`); continue; }
      // an alias "{other}" becomes var(--other)
      const css = typeof v === 'string' && /^\{[^}]+\}$/.test(v) ? `var(--${v.slice(1, -1)})` : v;
      perTheme[theme].push(`  --${t.name}: ${css};`);
    }
  }
}
const flat = [];
for (const [family, def] of Object.entries(tokens)) {
  if (['name', 'version', 'color', 'shadow', 'type', 'meta'].includes(family)) continue;
  for (const t of def?.tokens || []) flat.push(`  --${t.name}: ${t.value};`);
}
for (const [name, stack] of Object.entries(tokens.type?.families || {})) flat.push(`  --font-${name}: ${stack};`);

const header = `/* ${tokens.name || 'Design tokens'} - generated from design/gs-tokens.json by scripts/generate-gs-tokens.mjs. Do not edit. */`;
const css = [
  header,
  `:root, [data-theme="${primary}"] {`,
  ...perTheme[primary],
  ...flat,
  '}',
  ...themes.filter((t) => t !== primary).flatMap((t) => [`[data-theme="${t}"] {`, ...perTheme[t], `  color-scheme: ${t === 'dark' ? 'dark' : 'light'};`, '}']),
  `:root, [data-theme="${primary}"] { color-scheme: ${primary === 'dark' ? 'dark' : 'light'}; }`,
  '',
].join('\n');

fs.writeFileSync(out, css);
const count = perTheme[primary].length + flat.length;
console.log(`Wrote ${path.relative(root, out)}: ${count} tokens, themes: ${themes.join(', ')}${problems.length ? `\nWarnings:\n  ${problems.join('\n  ')}` : ''}`);
