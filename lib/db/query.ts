/**
 * Phase 11 query layer: the Supabase Data API client interface (`.from(table).select(...).eq(...)`,
 * `.rpc(fn, args)`), executed through Prisma's Postgres connection instead of PostgREST, so existing
 * server code keeps working when the Data API is switched off.
 *
 * - A "user" runner runs every query in withUser (row-level security applies); with no signed-in user
 *   it runs as the anonymous role, as PostgREST did. A "system" runner uses withSystem, and is only
 *   used where the service-role client was used before, after the API's own checks.
 * - Results follow PostgREST: { data, error, count, status, statusText }. Embedded resources are objects
 *   (many-to-one, one-to-one) or arrays (one-to-many); single() fails with PGRST116; JSON is built by
 *   Postgres itself, so values serialize exactly as through the Data API.
 * - Values are always query parameters, cast to the column's type. Table, column and function names are
 *   checked against the database's own catalog.
 *
 * Only the query features this codebase uses are implemented; anything else fails with a clear error.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { withUser, withSystem, withAnon, type Tx } from './index';

export type Runner = { kind: 'system' } | { kind: 'user'; userId: () => Promise<string | null> };

export type PostgrestLikeError = { message: string; details: string | null; hint: string | null; code: string };
export type QueryResult<T = any> = { data: T; error: PostgrestLikeError | null; count: number | null; status: number; statusText: string };

class LayerError extends Error {
  constructor(public code: string, message: string, public details: string | null = null) {
    super(message);
  }
}

// ------------------------------------------------------------------ catalog

type Fk = { name: string; table: string; columns: string[]; refTable: string; refColumns: string[] };
type Fn = { name: string; set: boolean; kind: string; rtype: string; args: { name: string | null; type: string }[] };
type Meta = {
  schema: string;
  columns: Map<string, Map<string, string>>;
  fks: Fk[];
  uniques: Map<string, string[][]>;
  primaryKeys: Map<string, string[]>;
  functions: Map<string, Fn>;
};

const IDENT = /^[a-z_][a-z0-9_]*$/i;
const cache = globalThis as unknown as { __pmQueryMeta?: Promise<Meta> };

function schemaName(): string {
  const schema = process.env.DB_SCHEMA || 'public';
  if (!IDENT.test(schema)) throw new Error('DB_SCHEMA is not a valid schema name');
  return schema;
}

const CATALOG_SQL = `
select json_build_object(
  'columns', (select coalesce(json_agg(json_build_object('t', c.relname, 'c', a.attname, 'type', format_type(a.atttypid, null))), '[]')
     from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = $1 and c.relkind in ('r', 'p', 'v', 'm', 'f') and a.attnum > 0 and not a.attisdropped),
  'fks', (select coalesce(json_agg(json_build_object('name', con.conname, 't', c.relname, 'rt', rc.relname,
       'cols', (select json_agg(a.attname order by k.ord) from unnest(con.conkey) with ordinality k(num, ord)
                join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.num),
       'rcols', (select json_agg(a.attname order by k.ord) from unnest(con.confkey) with ordinality k(num, ord)
                join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.num))), '[]')
     from pg_constraint con join pg_class c on c.oid = con.conrelid join pg_namespace n on n.oid = c.relnamespace
       join pg_class rc on rc.oid = con.confrelid join pg_namespace rn on rn.oid = rc.relnamespace
     where con.contype = 'f' and n.nspname = $1 and rn.nspname = $1),
  'uniques', (select coalesce(json_agg(json_build_object('t', c.relname, 'pk', i.indisprimary,
       'cols', (select json_agg(a.attname order by k.ord) from unnest(i.indkey::int2[]) with ordinality k(num, ord)
                join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.num))), '[]')
     from pg_index i join pg_class c on c.oid = i.indrelid join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = $1 and i.indisunique and i.indpred is null and i.indexprs is null),
  'functions', (select coalesce(json_agg(json_build_object('name', p.proname, 'set', p.proretset, 'kind', t.typtype,
       'rtype', format_type(p.prorettype, null),
       'args', (select coalesce(json_agg(json_build_object('name', (p.proargnames)[k.ord], 'type', format_type(k.typ, null)) order by k.ord), '[]')
                from unnest(p.proargtypes::oid[]) with ordinality k(typ, ord)))), '[]')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_type t on t.oid = p.prorettype
     where n.nspname = $1 and p.prokind = 'f')
)::text as j`;

async function loadMeta(): Promise<Meta> {
  const schema = schemaName();
  const raw = await withSystem(async (tx) => {
    const rows = await tx.$queryRawUnsafe<{ j: string }[]>(CATALOG_SQL, schema);
    return JSON.parse(rows[0].j);
  });
  const columns = new Map<string, Map<string, string>>();
  for (const c of raw.columns) {
    if (!columns.has(c.t)) columns.set(c.t, new Map());
    columns.get(c.t)!.set(c.c, c.type);
  }
  const uniques = new Map<string, string[][]>();
  const primaryKeys = new Map<string, string[]>();
  for (const u of raw.uniques) {
    if (!uniques.has(u.t)) uniques.set(u.t, []);
    uniques.get(u.t)!.push(u.cols);
    if (u.pk) primaryKeys.set(u.t, u.cols);
  }
  const functions = new Map<string, Fn>();
  for (const f of raw.functions) if (!functions.has(f.name)) functions.set(f.name, f);
  const fks: Fk[] = raw.fks.map((f: any) => ({ name: f.name, table: f.t, columns: f.cols, refTable: f.rt, refColumns: f.rcols }));
  return { schema, columns, fks, uniques, primaryKeys, functions };
}

function getMeta(): Promise<Meta> {
  if (!cache.__pmQueryMeta) {
    cache.__pmQueryMeta = loadMeta().catch((e) => {
      cache.__pmQueryMeta = undefined;
      throw e;
    });
  }
  return cache.__pmQueryMeta;
}

// ------------------------------------------------------------------ select parsing

type Field =
  | { kind: 'star' }
  | { kind: 'column'; name: string; alias?: string }
  | { kind: 'embed'; key: string; target: string; hints: string[]; inner: boolean; fields: Field[] };

export function parseSelect(text: string): Field[] {
  let i = 0;
  const s = text;
  const skip = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const token = () => {
    skip();
    const start = i;
    while (i < s.length && /[A-Za-z0-9_!:*]/.test(s[i])) i++;
    return s.slice(start, i);
  };
  const list = (): Field[] => {
    const fields: Field[] = [];
    for (;;) {
      skip();
      if (i >= s.length || s[i] === ')') return fields;
      const t = token();
      if (!t) throw new LayerError('PGRST100', `Could not parse the select "${text}" at "${s.slice(i, i + 20)}"`);
      skip();
      if (s[i] === '(') {
        i++;
        const children = list();
        skip();
        if (s[i] !== ')') throw new LayerError('PGRST100', `Unclosed "(" in the select "${text}"`);
        i++;
        const [aliasPart, rest] = t.includes(':') ? [t.slice(0, t.indexOf(':')), t.slice(t.indexOf(':') + 1)] : [undefined, t];
        const [target, ...hintList] = rest.split('!');
        fields.push({ kind: 'embed', key: aliasPart || target, target, hints: hintList.filter((h) => h !== 'inner' && h !== 'left'), inner: hintList.includes('inner'), fields: children });
      } else if (t === '*') {
        fields.push({ kind: 'star' });
      } else if (t.includes(':')) {
        fields.push({ kind: 'column', alias: t.slice(0, t.indexOf(':')), name: t.slice(t.indexOf(':') + 1) });
      } else {
        fields.push({ kind: 'column', name: t });
      }
      skip();
      if (s[i] === ',') i++;
    }
  };
  const fields = list();
  skip();
  if (i < s.length) throw new LayerError('PGRST100', `Unexpected "${s.slice(i, i + 20)}" in the select "${text}"`);
  return fields;
}

// ------------------------------------------------------------------ SQL building

type OpFilter = { kind: 'op'; path: string[]; column: string; op: string; value: unknown; negate: boolean };
type OrFilter = { kind: 'or'; path: string[]; expr: string };
type Filter = OpFilter | OrFilter;
type Order = { path: string[]; column: string; ascending: boolean; nullsFirst?: boolean };
type Level = { table: string; alias: string; path: string[]; from: string };

const q = (name: string) => {
  if (!IDENT.test(name)) throw new LayerError('PGRST100', `"${name}" is not a valid name`);
  return `"${name}"`;
};
const samePath = (a: string[], b: string[]) => a.length === b.length && a.every((x, k) => x === b[k]);

class Sql {
  params: (string | null)[] = [];
  private n = 0;
  constructor(public meta: Meta, public filters: Filter[], public orders: Order[], public limits: Map<string, { limit?: number; offset?: number }>) {}
  alias() { return `t${this.n++}`; }
  table(name: string) {
    if (!this.meta.columns.has(name)) throw new LayerError('PGRST205', `Could not find the table '${this.meta.schema}.${name}' in the schema cache`);
    return `${q(this.meta.schema)}.${q(name)}`;
  }
  type(table: string, column: string): string {
    const type = this.meta.columns.get(table)?.get(column);
    if (!type) throw new LayerError('42703', `column ${table}.${column} does not exist`);
    return type;
  }
  param(value: unknown, type: string): string {
    this.params.push(toParam(value, type));
    return `$${this.params.length}::${type}`;
  }
}

function toParam(value: unknown, type: string): string | null {
  if (value === null || value === undefined) return null;
  if (type.endsWith('[]') && Array.isArray(value)) {
    return `{${value.map((v) => (v === null || v === undefined ? 'NULL' : `"${String(typeof v === 'object' ? JSON.stringify(v) : v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)).join(',')}}`;
  }
  if (type === 'json' || type === 'jsonb') return JSON.stringify(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

type Relation = { target: string; many: boolean; pairs: [string, string][] }; // pairs: [parent column, child column]

function resolveRelation(meta: Meta, parent: string, embed: Extract<Field, { kind: 'embed' }>): Relation {
  const { target, hints } = embed;
  // `alias:fk_column(...)`: the column of the parent that references another table
  if (meta.columns.get(parent)?.has(target) && !meta.columns.has(target)) {
    const fk = meta.fks.find((f) => f.table === parent && f.columns.length === 1 && f.columns[0] === target);
    if (!fk) throw new LayerError('PGRST200', `Could not find a relationship between '${parent}' and '${target}' in the schema cache`);
    return { target: fk.refTable, many: false, pairs: fk.columns.map((c, k) => [c, fk.refColumns[k]]) };
  }
  // `alias:fk_constraint_name(...)`: the foreign key itself names the relationship
  const named = meta.fks.find((f) => f.name === target && (f.table === parent || f.refTable === parent));
  if (named && !meta.columns.has(target)) {
    if (named.table === parent) return { target: named.refTable, many: false, pairs: named.columns.map((c, k) => [c, named.refColumns[k]]) };
    const unique = (meta.uniques.get(named.table) || []).some((u) => u.length === named.columns.length && u.every((c) => named.columns.includes(c)));
    return { target: named.table, many: !unique, pairs: named.refColumns.map((c, k) => [c, named.columns[k]]) };
  }
  const candidates: (Relation & { fk: Fk })[] = [];
  for (const fk of meta.fks) {
    if (fk.table === parent && fk.refTable === target) {
      candidates.push({ fk, target, many: false, pairs: fk.columns.map((c, k) => [c, fk.refColumns[k]]) });
    }
    if (fk.refTable === parent && fk.table === target) {
      const unique = (meta.uniques.get(target) || []).some((u) => u.length === fk.columns.length && u.every((c) => fk.columns.includes(c)));
      candidates.push({ fk, target, many: !unique, pairs: fk.refColumns.map((c, k) => [c, fk.columns[k]]) });
    }
  }
  const matching = hints.length
    ? candidates.filter((c) => hints.every((h) => c.fk.name === h || c.fk.columns.includes(h)))
    : candidates;
  if (matching.length === 1) return matching[0];
  // A table pointing at itself (roles.reporting_role_id) stays unresolved, as PostgREST leaves it
  if (matching.length === 0 || parent === target) throw new LayerError('PGRST200', `Could not find a relationship between '${parent}' and '${target}' in the schema cache`);
  throw new LayerError('PGRST201', `Could not embed because more than one relationship was found for '${parent}' and '${target}'`);
}

function isCountOnly(embed: Extract<Field, { kind: 'embed' }>, sql: Sql, table: string) {
  return embed.fields.length === 1 && embed.fields[0].kind === 'column' && embed.fields[0].name === 'count' && !sql.meta.columns.get(table)?.has('count');
}

function selectList(sql: Sql, level: Level, fields: Field[]): string {
  const parts: string[] = [];
  for (const f of fields) {
    if (f.kind === 'star') parts.push(`${level.alias}.*`);
    else if (f.kind === 'column') {
      sql.type(level.table, f.name);
      parts.push(`${level.alias}.${q(f.name)} as ${q(f.alias ?? f.name)}`);
    } else parts.push(`${embedSql(sql, level, f)} as ${q(f.key)}`);
  }
  return parts.length ? parts.join(', ') : `${level.alias}.*`;
}

function childLevel(sql: Sql, parent: Level, embed: Extract<Field, { kind: 'embed' }>, rel: Relation): Level {
  return { table: rel.target, alias: sql.alias(), path: [...parent.path, embed.key], from: sql.table(rel.target) };
}

function joinSql(parent: Level, child: Level, rel: Relation) {
  return rel.pairs.map(([p, c]) => `${child.alias}.${q(c)} = ${parent.alias}.${q(p)}`).join(' and ');
}

function embedSql(sql: Sql, parent: Level, embed: Extract<Field, { kind: 'embed' }>): string {
  const rel = resolveRelation(sql.meta, parent.table, embed);
  const child = childLevel(sql, parent, embed, rel);
  const where = [joinSql(parent, child, rel), ...conditions(sql, child, embed.fields)].join(' and ');
  if (isCountOnly(embed, sql, rel.target)) {
    return `(select json_build_array(json_build_object('count', count(*))) from ${child.from} ${child.alias} where ${where})`;
  }
  const body = `select ${selectList(sql, child, embed.fields)} from ${child.from} ${child.alias} where ${where}`;
  if (rel.many) return `(select coalesce(json_agg(_x), '[]'::json) from (${body}${orderSql(sql, child)}${limitSql(sql, child)}) _x)`;
  return `(select row_to_json(_x) from (${body} limit 1) _x)`;
}

/** WHERE conditions for one level: its filters, plus existence checks for its !inner embeds. */
function conditions(sql: Sql, level: Level, fields: Field[]): string[] {
  const out: string[] = [];
  for (const f of sql.filters) {
    if (!samePath(f.path, level.path)) continue;
    out.push(f.kind === 'or' ? orSql(sql, level, f.expr) : opSql(sql, level, f));
  }
  for (const f of fields) {
    if (f.kind !== 'embed' || !f.inner) continue;
    const rel = resolveRelation(sql.meta, level.table, f);
    const child = childLevel(sql, level, f, rel);
    const inner = [joinSql(level, child, rel), ...conditions(sql, child, f.fields)].join(' and ');
    out.push(`exists (select 1 from ${child.from} ${child.alias} where ${inner})`);
  }
  return out;
}

const COMPARE: Record<string, string> = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };

function opSql(sql: Sql, level: Level, f: { column: string; op: string; value: unknown; negate: boolean }): string {
  const col = `${level.alias}.${q(f.column)}`;
  const type = sql.type(level.table, f.column);
  let expr: string;
  if (COMPARE[f.op]) expr = `${col} ${COMPARE[f.op]} ${sql.param(f.value, type)}`;
  else if (f.op === 'like' || f.op === 'ilike') {
    expr = `${col}::text ${f.op} ${sql.param(String(f.value).replace(/\*/g, '%'), 'text')}`;
  } else if (f.op === 'is') {
    const v = f.value === null ? 'null' : String(f.value).toLowerCase();
    if (!['null', 'true', 'false', 'unknown'].includes(v)) throw new LayerError('PGRST100', `"is" only takes null, true, false or unknown`);
    return `${col} is ${f.negate ? 'not ' : ''}${v}`;
  } else if (f.op === 'in') {
    const list = Array.isArray(f.value) ? f.value : parseList(String(f.value));
    expr = list.length ? `${col} in (${list.map((v) => sql.param(v, type)).join(', ')})` : 'false';
  } else throw new LayerError('PGRST100', `The filter "${f.op}" is not supported by the query layer`);
  return f.negate ? `not (${expr})` : expr;
}

/** `(a,b,"c d")` as used by PostgREST's in and not.in */
function parseList(text: string): string[] {
  const inner = text.trim().replace(/^\(/, '').replace(/\)$/, '');
  if (!inner) return [];
  return splitTop(inner).map(unquote);
}

function unquote(v: string) {
  const t = v.trim();
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1).replace(/\\"/g, '"') : t;
}

/** Split at commas that are outside parentheses and double quotes. */
function splitTop(text: string): string[] {
  const parts: string[] = [];
  let depth = 0, quoted = false, start = 0;
  for (let k = 0; k < text.length; k++) {
    const ch = text[k];
    if (ch === '"' && text[k - 1] !== '\\') quoted = !quoted;
    else if (!quoted && ch === '(') depth++;
    else if (!quoted && ch === ')') depth--;
    else if (!quoted && depth === 0 && ch === ',') { parts.push(text.slice(start, k)); start = k + 1; }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** PostgREST logic trees: `a.eq.1,b.ilike.*x*,and(c.is.null,d.gt.2)` */
function orSql(sql: Sql, level: Level, expr: string, joiner = 'or'): string {
  const parts = splitTop(expr).map((item) => {
    const group = item.match(/^(not\.)?(and|or)\(([\s\S]*)\)$/);
    if (group) {
      const inner = orSql(sql, level, group[3], group[2]);
      return group[1] ? `not ${inner}` : inner;
    }
    const pieces = item.split('.');
    const column = pieces[0];
    let k = 1, negate = false;
    if (pieces[k] === 'not') { negate = true; k++; }
    const op = pieces[k];
    let value: unknown = pieces.slice(k + 1).join('.');
    if (op !== 'in') value = unquote(String(value));
    return opSql(sql, level, { column, op, value: op === 'in' ? parseList(String(value)) : value, negate });
  });
  return `(${parts.join(` ${joiner} `)})`;
}

function orderSql(sql: Sql, level: Level): string {
  const parts = sql.orders.filter((o) => samePath(o.path, level.path)).map((o) => {
    sql.type(level.table, o.column);
    const nulls = o.nullsFirst === undefined ? '' : o.nullsFirst ? ' nulls first' : ' nulls last';
    return `${level.alias}.${q(o.column)} ${o.ascending ? 'asc' : 'desc'}${nulls}`;
  });
  return parts.length ? ` order by ${parts.join(', ')}` : '';
}

function limitSql(sql: Sql, level: Level): string {
  const l = sql.limits.get(level.path.join('.'));
  if (!l) return '';
  return `${l.limit !== undefined ? ` limit ${Math.max(0, Math.floor(l.limit))}` : ''}${l.offset ? ` offset ${Math.max(0, Math.floor(l.offset))}` : ''}`;
}

// ------------------------------------------------------------------ execution

async function run<T>(runner: Runner, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (runner.kind === 'system') return withSystem(fn);
  const userId = await runner.userId();
  return userId ? withUser(userId, fn) : withAnon(fn);
}

class SingleViolation extends Error {
  constructor(public rows: number) {
    super('JSON object requested, multiple (or no) rows returned');
  }
}

function toError(e: unknown): PostgrestLikeError {
  if (e instanceof LayerError) return { code: e.code, message: e.message, details: e.details, hint: null };
  if (e instanceof SingleViolation) {
    return { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: `The result contains ${e.rows} rows`, hint: null };
  }
  const err = e as any;
  const cause = err?.meta?.driverAdapterError?.cause;
  if (cause) {
    return { code: String(cause.originalCode || cause.code || 'XX000'), message: String(cause.originalMessage || cause.message), details: cause.detail ?? null, hint: cause.hint ?? null };
  }
  return { code: 'PGRST000', message: err?.message ? String(err.message) : 'Database error', details: null, hint: null };
}

function statusOf(error: PostgrestLikeError): number {
  if (error.code === 'PGRST116') return 406;
  if (['23505', '23503'].includes(error.code)) return 409;
  if (error.code === '42501') return 403;
  if (error.code === '42P01' || error.code === 'PGRST200' || error.code === 'PGRST201') return 400;
  if (error.code.startsWith('PGRST') || error.code.startsWith('22') || error.code.startsWith('23') || error.code === '42703') return 400;
  return 500;
}

type Action = 'select' | 'insert' | 'update' | 'upsert' | 'delete';

export class QueryBuilder<T = any> implements PromiseLike<QueryResult<T>> {
  private action: Action = 'select';
  private selectText: string | null = null;
  private countExact = false;
  private head = false;
  private filters: Filter[] = [];
  private orders: Order[] = [];
  private limits = new Map<string, { limit?: number; offset?: number }>();
  private values: any = null;
  private onConflict?: string;
  private ignoreDuplicates = false;
  private missingAsDefault = false;
  private singleMode: 'single' | 'maybe' | null = null;

  constructor(private table: string, private runner: Runner) {}

  select(columns = '*', options?: { count?: 'exact' | 'planned' | 'estimated'; head?: boolean }) {
    this.selectText = columns;
    if (options?.count) this.countExact = true;
    if (options?.head) this.head = true;
    return this;
  }
  insert(values: any, options?: { defaultToNull?: boolean; count?: string }) {
    this.action = 'insert';
    this.values = values;
    this.missingAsDefault = options?.defaultToNull === false;
    return this;
  }
  upsert(values: any, options?: { onConflict?: string; ignoreDuplicates?: boolean; defaultToNull?: boolean }) {
    this.action = 'upsert';
    this.values = values;
    this.onConflict = options?.onConflict;
    this.ignoreDuplicates = !!options?.ignoreDuplicates;
    this.missingAsDefault = options?.defaultToNull === false;
    return this;
  }
  update(values: any) {
    this.action = 'update';
    this.values = values;
    return this;
  }
  delete() {
    this.action = 'delete';
    return this;
  }

  private add(column: string, op: string, value: unknown, negate = false) {
    const parts = column.split('.');
    this.filters.push({ kind: 'op', path: parts.slice(0, -1), column: parts[parts.length - 1], op, value, negate });
    return this;
  }
  eq(column: string, value: unknown) { return this.add(column, 'eq', value); }
  neq(column: string, value: unknown) { return this.add(column, 'neq', value); }
  gt(column: string, value: unknown) { return this.add(column, 'gt', value); }
  gte(column: string, value: unknown) { return this.add(column, 'gte', value); }
  lt(column: string, value: unknown) { return this.add(column, 'lt', value); }
  lte(column: string, value: unknown) { return this.add(column, 'lte', value); }
  like(column: string, value: string) { return this.add(column, 'like', value); }
  ilike(column: string, value: string) { return this.add(column, 'ilike', value); }
  is(column: string, value: unknown) { return this.add(column, 'is', value); }
  in(column: string, values: readonly unknown[]) { return this.add(column, 'in', [...values]); }
  not(column: string, op: string, value: unknown) { return this.add(column, op, op === 'in' && typeof value === 'string' ? parseList(value) : value, true); }
  filter(column: string, op: string, value: unknown) {
    if (op.startsWith('not.')) return this.not(column, op.slice(4), value);
    return this.add(column, op, op === 'in' && typeof value === 'string' ? parseList(value) : value);
  }
  match(values: Record<string, unknown>) {
    for (const [k, v] of Object.entries(values)) this.eq(k, v);
    return this;
  }
  or(expr: string, options?: { foreignTable?: string; referencedTable?: string }) {
    const path = options?.referencedTable || options?.foreignTable;
    this.filters.push({ kind: 'or', path: path ? path.split('.') : [], expr });
    return this;
  }
  order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean; foreignTable?: string; referencedTable?: string }) {
    const path = options?.referencedTable || options?.foreignTable;
    this.orders.push({ path: path ? path.split('.') : [], column, ascending: options?.ascending !== false, nullsFirst: options?.nullsFirst });
    return this;
  }
  limit(count: number, options?: { foreignTable?: string; referencedTable?: string }) {
    const key = options?.referencedTable || options?.foreignTable || '';
    this.limits.set(key, { ...this.limits.get(key), limit: count });
    return this;
  }
  range(from: number, to: number, options?: { foreignTable?: string; referencedTable?: string }) {
    const key = options?.referencedTable || options?.foreignTable || '';
    this.limits.set(key, { offset: from, limit: to - from + 1 });
    return this;
  }
  single() { this.singleMode = 'single'; return this as unknown as QueryBuilder<any>; }
  maybeSingle() { this.singleMode = 'maybe'; return this as unknown as QueryBuilder<any>; }

  then<R1 = QueryResult<T>, R2 = never>(onfulfilled?: ((value: QueryResult<T>) => R1 | PromiseLike<R1>) | null, onrejected?: ((reason: any) => R2 | PromiseLike<R2>) | null): PromiseLike<R1 | R2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private async execute(): Promise<QueryResult<T>> {
    try {
      const meta = await getMeta();
      const sql = new Sql(meta, this.filters, this.orders, this.limits);
      const fields = parseSelect(this.selectText ?? '*');
      const top: Level = { table: this.table, alias: sql.alias(), path: [], from: sql.table(this.table) };
      if (this.action !== 'select' && this.filters.some((f) => f.path.length)) {
        throw new LayerError('PGRST100', 'Filters on embedded resources are not supported in insert, update or delete');
      }
      const result = await run(this.runner, async (tx) => {
        if (this.action === 'select') return this.runSelect(tx, sql, top, fields);
        return this.runWrite(tx, sql, top, fields);
      });
      return { data: result.data, error: null, count: result.count, status: this.action === 'insert' || this.action === 'upsert' ? 201 : 200, statusText: 'OK' };
    } catch (e) {
      const error = toError(e);
      return { data: null as T, error, count: null, status: statusOf(error), statusText: '' };
    }
  }

  private shape(rows: any[]): any {
    if (!this.singleMode) return rows;
    if (rows.length === 1) return rows[0];
    if (rows.length === 0 && this.singleMode === 'maybe') return null;
    throw new SingleViolation(rows.length);
  }

  private async runSelect(tx: Tx, sql: Sql, top: Level, fields: Field[]) {
    const where = conditions(sql, top, fields);
    const whereSql = where.length ? ` where ${where.join(' and ')}` : '';
    let count: number | null = null;
    if (this.countExact || this.head) {
      const countSql = new Sql(sql.meta, this.filters, [], new Map());
      const countTop: Level = { ...top, alias: countSql.alias() };
      const countWhere = conditions(countSql, countTop, fields);
      const rows = await tx.$queryRawUnsafe<{ n: number }[]>(
        `select count(*)::int as n from ${countTop.from} ${countTop.alias}${countWhere.length ? ` where ${countWhere.join(' and ')}` : ''}`,
        ...countSql.params);
      count = Number(rows[0].n);
    }
    if (this.head) return { data: null, count };
    // `select('count')` on a table without a count column: PostgREST's count aggregate
    const aggregate = fields.length === 1 && fields[0].kind === 'column' && fields[0].name === 'count' && !sql.meta.columns.get(top.table)?.has('count');
    const list = aggregate ? 'count(*)::int as "count"' : selectList(sql, top, fields);
    const body = `select ${list} from ${top.from} ${top.alias}${whereSql}${aggregate ? '' : `${orderSql(sql, top)}${limitSql(sql, top)}`}`;
    const rows = await tx.$queryRawUnsafe<{ j: string }[]>(`select coalesce(json_agg(_r), '[]'::json)::text as j from (${body}) _r`, ...sql.params);
    return { data: this.shape(JSON.parse(rows[0].j)), count };
  }

  private async runWrite(tx: Tx, sql: Sql, top: Level, fields: Field[]) {
    const returning = this.selectText !== null;
    let statement: string;
    const table = top.from;
    if (this.action === 'insert' || this.action === 'upsert') {
      const rows: Record<string, unknown>[] = (Array.isArray(this.values) ? this.values : [this.values]).map((r: any) => r ?? {});
      if (!rows.length) return { data: returning ? this.shape([]) : null, count: null };
      const columns = Array.from(new Set(rows.flatMap((r) => Object.keys(r).filter((k) => r[k] !== undefined))));
      if (!columns.length) {
        statement = `insert into ${table} as ${top.alias} default values`;
      } else {
        const valuesSql = rows.map((r) => `(${columns.map((c) => {
          const type = sql.type(this.table, c);
          if (r[c] === undefined) return this.missingAsDefault ? 'default' : `null::${type}`;
          return sql.param(r[c], type);
        }).join(', ')})`).join(', ');
        statement = `insert into ${table} as ${top.alias} (${columns.map(q).join(', ')}) values ${valuesSql}`;
        if (this.action === 'upsert') {
          const target = this.onConflict ? this.onConflict.split(',').map((c) => c.trim()) : sql.meta.primaryKeys.get(this.table) || ['id'];
          target.forEach((c) => sql.type(this.table, c));
          const updates = columns.filter((c) => !target.includes(c));
          statement += this.ignoreDuplicates || !updates.length
            ? ` on conflict (${target.map(q).join(', ')}) do nothing`
            : ` on conflict (${target.map(q).join(', ')}) do update set ${updates.map((c) => `${q(c)} = excluded.${q(c)}`).join(', ')}`;
        }
      }
    } else if (this.action === 'update') {
      const values = this.values || {};
      const columns = Object.keys(values).filter((k) => values[k] !== undefined);
      if (!columns.length) throw new LayerError('PGRST100', 'Nothing to update');
      const sets = columns.map((c) => `${q(c)} = ${sql.param(values[c], sql.type(this.table, c))}`).join(', ');
      const where = conditions(sql, top, []);
      statement = `update ${table} as ${top.alias} set ${sets}${where.length ? ` where ${where.join(' and ')}` : ''}`;
    } else {
      const where = conditions(sql, top, []);
      statement = `delete from ${table} as ${top.alias}${where.length ? ` where ${where.join(' and ')}` : ''}`;
    }
    if (!returning) {
      await tx.$executeRawUnsafe(statement, ...sql.params);
      return { data: null, count: null };
    }
    const out: Level = { ...top, alias: sql.alias(), from: '_w' };
    const query = `with _w as (${statement} returning ${top.alias}.*) select coalesce(json_agg(_r), '[]'::json)::text as j from (select ${selectList(sql, out, fields)} from _w ${out.alias}${orderSql(sql, { ...out, path: [] })}) _r`;
    const rows = await tx.$queryRawUnsafe<{ j: string }[]>(query, ...sql.params);
    // A single() that does not match exactly one row rolls the write back, as PostgREST does
    return { data: this.shape(JSON.parse(rows[0].j)), count: null };
  }
}

// ------------------------------------------------------------------ rpc

const REFUSED_FUNCTIONS = new Set(['exec_sql']);

async function callFunction(runner: Runner, name: string, args: Record<string, unknown> = {}): Promise<QueryResult> {
  try {
    if (REFUSED_FUNCTIONS.has(name)) throw new LayerError('42501', `Calling ${name} is not allowed`);
    const meta = await getMeta();
    const fn = meta.functions.get(name);
    if (!fn) throw new LayerError('PGRST202', `Could not find the function ${meta.schema}.${name} in the schema cache`);
    const sql = new Sql(meta, [], [], new Map());
    const known = new Map(fn.args.filter((a) => a.name).map((a) => [a.name as string, a.type]));
    const named = Object.entries(args).filter(([, v]) => v !== undefined).map(([k, v]) => {
      const type = known.get(k);
      if (!type) throw new LayerError('PGRST202', `The function ${name} has no argument ${k}`);
      return `${q(k)} => ${sql.param(v, type)}`;
    }).join(', ');
    const call = `${q(meta.schema)}.${q(name)}(${named})`;
    const data = await run(runner, async (tx) => {
      if (fn.set) {
        const rows = await tx.$queryRawUnsafe<{ j: string }[]>(`select coalesce(json_agg(_r), '[]'::json)::text as j from ${call} _r`, ...sql.params);
        return JSON.parse(rows[0].j);
      }
      if (fn.rtype === 'void') {
        // Prisma cannot read a column of type void back, so the call's value is not selected
        await tx.$queryRawUnsafe(`select 1 as ok from ${call} _r`, ...sql.params);
        return null;
      }
      const expr = fn.kind === 'c' ? `(select row_to_json(_r) from ${call} _r)` : `to_json(${call})`;
      const rows = await tx.$queryRawUnsafe<{ j: string | null }[]>(`select ${expr}::text as j`, ...sql.params);
      return rows[0].j === null ? null : JSON.parse(rows[0].j);
    });
    return { data, error: null, count: null, status: 200, statusText: 'OK' };
  } catch (e) {
    const error = toError(e);
    return { data: null, error, count: null, status: statusOf(error), statusText: '' };
  }
}

// ------------------------------------------------------------------ clients

/** A query client with the Data API client's `.from()` and `.rpc()`. */
export function queryClient(runner: Runner) {
  return {
    from: (table: string) => new QueryBuilder(table, runner),
    rpc: (name: string, args?: Record<string, unknown>) => callFunction(runner, name, args),
  };
}

/** Keep a Supabase client for Auth and Storage, and send its `.from()` / `.rpc()` through the query layer. */
export function withQueryLayer<C extends object>(client: C, runner: Runner): C {
  const layer = queryClient(runner);
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'from') return layer.from;
      if (prop === 'rpc') return layer.rpc;
      return Reflect.get(target, prop, receiver);
    },
  });
}

/** On when DATABASE_URL is set, unless DATA_ACCESS=data-api switches back to the Supabase Data API. */
export function queryLayerEnabled(): boolean {
  return !!process.env.DATABASE_URL && process.env.DATA_ACCESS !== 'data-api';
}

/** A user runner that resolves the signed-in user once, through Supabase Auth (not the Data API). */
export function userRunner(auth: { getUser: () => Promise<{ data: { user: { id: string } | null } }> }): Runner {
  let pending: Promise<string | null> | null = null;
  return {
    kind: 'user',
    userId: () => (pending ??= auth.getUser().then((r) => r.data.user?.id ?? null).catch(() => null)),
  };
}
