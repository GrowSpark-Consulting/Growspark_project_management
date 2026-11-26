import { describe, it, expect } from 'vitest';
import {
  readPage, pageInfo, wantsPage, searchTerm, slicePage,
  readCursor, encodeCursor, decodeCursor, afterCursor, cursorPage, PAGE_SIZES, DEFAULT_PAGE_SIZE,
} from '@/lib/pagination';

const q = (s: string) => new URLSearchParams(s);

describe('page requests', () => {
  it('defaults to page 1 of 20', () => {
    expect(readPage(q(''))).toEqual({ page: 1, pageSize: 20, from: 0, to: 19 });
    expect(PAGE_SIZES).toEqual([20, 50, 100]);
    expect(DEFAULT_PAGE_SIZE).toBe(20);
  });

  it('reads page and the three supported sizes', () => {
    expect(readPage(q('page=3&pageSize=50'))).toEqual({ page: 3, pageSize: 50, from: 100, to: 149 });
    expect(readPage(q('page=2&pageSize=100'))).toMatchObject({ from: 100, to: 199 });
  });

  it('falls back for anything unsupported or invalid', () => {
    expect(readPage(q('pageSize=7')).pageSize).toBe(20);
    expect(readPage(q('pageSize=1000')).pageSize).toBe(20);
    expect(readPage(q('page=0')).page).toBe(1);
    expect(readPage(q('page=-4')).page).toBe(1);
    expect(readPage(q('page=abc')).page).toBe(1);
    expect(readPage(q('page=2.9')).page).toBe(2);
  });

  it('only paginates when asked', () => {
    expect(wantsPage(q('page=1'))).toBe(true);
    expect(wantsPage(q('pageSize=20'))).toBe(true);
    expect(wantsPage(q('q=abc'))).toBe(false);
  });
});

describe('page info', () => {
  it('first, middle and last page', () => {
    expect(pageInfo({ page: 1, pageSize: 20 }, 45)).toEqual({ page: 1, pageSize: 20, total: 45, totalPages: 3, hasNextPage: true, hasPreviousPage: false });
    expect(pageInfo({ page: 2, pageSize: 20 }, 45)).toMatchObject({ hasNextPage: true, hasPreviousPage: true });
    expect(pageInfo({ page: 3, pageSize: 20 }, 45)).toMatchObject({ hasNextPage: false, hasPreviousPage: true });
  });

  it('exact multiple, empty, and a page past the end', () => {
    expect(pageInfo({ page: 2, pageSize: 20 }, 40)).toMatchObject({ totalPages: 2, hasNextPage: false });
    expect(pageInfo({ page: 1, pageSize: 20 }, 0)).toMatchObject({ total: 0, totalPages: 1, hasNextPage: false, hasPreviousPage: false });
    expect(pageInfo({ page: 9, pageSize: 20 }, 45)).toMatchObject({ totalPages: 3, hasNextPage: false, hasPreviousPage: true });
  });

  it('slices an in-memory list with the same maths', () => {
    const rows = Array.from({ length: 45 }, (_, i) => i);
    const { rows: page3, pagination } = slicePage(rows, readPage(q('page=3')));
    expect(page3).toEqual([40, 41, 42, 43, 44]);
    expect(pagination.total).toBe(45);
  });
});

describe('search text', () => {
  it('trims, caps the length and removes filter syntax characters', () => {
    expect(searchTerm(q('q=%20%20acme%20%20corp%20'))).toBe('acme corp');
    expect(searchTerm(q('q=a,b(c)"d*e%25f_g'))).toBe('a b c d e f g');
    expect(searchTerm(new URLSearchParams({ q: 'x'.repeat(300) })).length).toBe(100);
    expect(searchTerm(q(''))).toBe('');
  });
});

describe('cursor feeds', () => {
  const row = { created_at: '2026-11-26T10:00:00.123+00:00', id: '3f2b8c0e-1a2b-4c3d-8e4f-5a6b7c8d9e0f' };

  it('a cursor survives encoding and decoding', () => {
    expect(decodeCursor(encodeCursor(row))).toEqual({ createdAt: row.created_at, id: row.id });
  });

  it('refuses malformed cursors (start from the newest instead)', () => {
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor('not-a-cursor')).toBeNull();
    expect(decodeCursor(Buffer.from("2026-01-01T00:00:00Z|1; drop table x").toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from(`not-a-date|${row.id}`).toString('base64url'))).toBeNull();
  });

  it('reads limit with a default and a maximum', () => {
    expect(readCursor(q('')).limit).toBe(20);
    expect(readCursor(q('limit=5')).limit).toBe(5);
    expect(readCursor(q('limit=9999')).limit).toBe(100);
    expect(readCursor(q('limit=0')).limit).toBe(20);
    expect(readCursor(q('limit=500'), 30, 200).limit).toBe(200);
    expect(readCursor(q(`cursor=${encodeURIComponent(encodeCursor(row))}`)).cursor?.id).toBe(row.id);
  });

  it('builds the "after the cursor" filter from validated parts only', () => {
    const f = afterCursor({ createdAt: row.created_at, id: row.id });
    expect(f).toBe(`created_at.lt.${row.created_at},and(created_at.eq.${row.created_at},id.lt.${row.id})`);
  });

  it('one extra row tells whether more exist; the next cursor is the last shown row', () => {
    const mk = (i: number) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, created_at: `2026-01-01T00:00:${String(59 - i).padStart(2, '0')}.000+00:00` });
    const request = { limit: 3, cursor: null };
    const more = cursorPage([mk(0), mk(1), mk(2), mk(3)], request);
    expect(more.rows).toHaveLength(3);
    expect(more.cursor.hasMore).toBe(true);
    expect(decodeCursor(more.cursor.nextCursor)?.id).toBe(mk(2).id);
    const end = cursorPage([mk(0), mk(1)], request);
    expect(end.rows).toHaveLength(2);
    expect(end.cursor).toMatchObject({ hasMore: false, nextCursor: null });
    expect(cursorPage([], request).cursor.hasMore).toBe(false);
  });
});
