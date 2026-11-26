/**
 * Server-side pagination for list endpoints, on top of the query layer (lib/db/query.ts): `.range(from, to)`
 * becomes SQL LIMIT/OFFSET and `select(..., { count: 'exact' })` one count(*), so only one page of rows
 * leaves the database.
 *
 * Page-numbered lists (tables): ?page=1&pageSize=20 (sizes 20, 50, 100). The response keeps its usual list
 * and adds `pagination: { page, pageSize, total, totalPages, hasNextPage, hasPreviousPage }`.
 * Without `page`/`pageSize` an endpoint keeps its previous behaviour (other callers are unaffected).
 *
 * Feeds (notifications, comments, updates, files, audit log): ?limit=20&cursor=<opaque>. Keyset on
 * (created_at, id) newest first: no OFFSET scan and no count, one extra row tells whether more exist.
 */

export const PAGE_SIZES = [20, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 20;

export interface PageRequest {
  page: number;
  pageSize: number;
  /** First and last row index for `.range(from, to)` */
  from: number;
  to: number;
}

export interface PageInfo {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

/** Whether the caller asked for a page (otherwise the endpoint answers as it did before pagination). */
export function wantsPage(params: URLSearchParams): boolean {
  return params.has('page') || params.has('pageSize');
}

/** page/pageSize from the query string: page >= 1, pageSize one of 20/50/100 (anything else: 20). */
export function readPage(params: URLSearchParams): PageRequest {
  const page = Math.max(1, Math.floor(Number(params.get('page')) || 1));
  const asked = Number(params.get('pageSize'));
  const pageSize = (PAGE_SIZES as readonly number[]).includes(asked) ? asked : DEFAULT_PAGE_SIZE;
  const from = (page - 1) * pageSize;
  return { page, pageSize, from, to: from + pageSize - 1 };
}

export function pageInfo(request: Pick<PageRequest, 'page' | 'pageSize'>, total: number): PageInfo {
  const totalPages = Math.max(1, Math.ceil(total / request.pageSize));
  return {
    page: request.page,
    pageSize: request.pageSize,
    total,
    totalPages,
    hasNextPage: request.page < totalPages,
    hasPreviousPage: request.page > 1,
  };
}

/** Rows `from..to` of an in-memory list (only for lists that are already small and bounded). */
export function slicePage<T>(rows: T[], request: PageRequest): { rows: T[]; pagination: PageInfo } {
  return { rows: rows.slice(request.from, request.to + 1), pagination: pageInfo(request, rows.length) };
}

/**
 * Search text for `ilike` inside an `or(...)` filter: trimmed, at most 100 characters, without the
 * characters that structure the filter expression. Values are always sent as query parameters.
 */
export function searchTerm(params: URLSearchParams, name = 'q'): string {
  return (params.get(name) || '').replace(/[,()"*\\%_]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
}

// ------------------------------------------------------------------ cursor (keyset) feeds

export interface CursorRequest {
  limit: number;
  cursor: { createdAt: string; id: string } | null;
}

export interface CursorInfo {
  limit: number;
  nextCursor: string | null;
  hasMore: boolean;
}

const ISO = /^\d{4}-\d{2}-\d{2}[T ][\d:.]+(Z|[+-]\d{2}(:?\d{2})?)?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ?limit (1..100, default 20) and ?cursor; an unreadable cursor starts from the newest row. */
export function readCursor(params: URLSearchParams, defaultLimit = DEFAULT_PAGE_SIZE, maxLimit = 100): CursorRequest {
  const limit = Math.min(maxLimit, Math.max(1, Math.floor(Number(params.get('limit')) || defaultLimit)));
  return { limit, cursor: decodeCursor(params.get('cursor')) };
}

export function encodeCursor(row: { created_at: string; id: string }): string {
  return Buffer.from(`${row.created_at}|${row.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(value: string | null): { createdAt: string; id: string } | null {
  if (!value) return null;
  try {
    const [createdAt, id] = Buffer.from(value, 'base64url').toString('utf8').split('|');
    return ISO.test(createdAt || '') && UUID.test(id || '') ? { createdAt, id } : null;
  } catch {
    return null;
  }
}

/** `or()` filter for the rows after the cursor, newest first: older timestamp, or same timestamp and smaller id. */
export function afterCursor(cursor: { createdAt: string; id: string }, column = 'created_at'): string {
  return `${column}.lt.${cursor.createdAt},and(${column}.eq.${cursor.createdAt},id.lt.${cursor.id})`;
}

/**
 * Apply a cursor feed to a query ordered newest first; fetches one extra row to know whether more exist.
 * Returns the query to await; pass its rows to cursorPage().
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyCursor(query: any, request: CursorRequest, column = 'created_at'): any {
  let q = query;
  if (request.cursor) q = q.or(afterCursor(request.cursor, column));
  return q.order(column, { ascending: false }).order('id', { ascending: false }).limit(request.limit + 1);
}

export function cursorPage<T extends { created_at: string; id: string }>(rows: T[], request: CursorRequest, column = 'created_at'): { rows: T[]; cursor: CursorInfo } {
  const hasMore = rows.length > request.limit;
  const page = hasMore ? rows.slice(0, request.limit) : rows;
  const last = page[page.length - 1] as unknown as Record<string, string> | undefined;
  return {
    rows: page,
    cursor: {
      limit: request.limit,
      hasMore,
      nextCursor: hasMore && last ? encodeCursor({ created_at: last[column], id: last.id }) : null,
    },
  };
}
