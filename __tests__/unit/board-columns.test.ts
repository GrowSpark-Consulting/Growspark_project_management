import { describe, it, expect } from 'vitest';
import { normalizeBoardColumns, boardColumnsSchema, defaultBoardColumns } from '@/lib/board-columns';

describe('board columns', () => {
  it('uses the six default columns when nothing is stored', () => {
    expect(normalizeBoardColumns(null).map((c) => c.status)).toEqual(['todo', 'in_progress', 'on_hold', 'review', 'changes_requested', 'done']);
  });
  it('keeps stored order, names and limits, and never loses a status', () => {
    const cols = normalizeBoardColumns([{ status: 'done', label: 'Shipped' }, { status: 'todo', label: 'Backlog', wip_limit: 5 }, { status: 'bogus', label: 'x' }, { status: 'done', label: 'dup' }]);
    expect(cols.slice(0, 2)).toEqual([{ status: 'done', label: 'Shipped', hidden: false, wip_limit: null }, { status: 'todo', label: 'Backlog', hidden: false, wip_limit: 5 }]);
    expect(cols).toHaveLength(6);
    expect(new Set(cols.map((c) => c.status)).size).toBe(6);
  });
  it('validates what the API accepts', () => {
    expect(boardColumnsSchema.safeParse(defaultBoardColumns()).success).toBe(true);
    expect(boardColumnsSchema.safeParse(defaultBoardColumns().slice(0, 5)).success).toBe(false);
    expect(boardColumnsSchema.safeParse(defaultBoardColumns().map((c) => ({ ...c, hidden: true }))).success).toBe(false);
    const dup = defaultBoardColumns(); dup[1] = { ...dup[0] };
    expect(boardColumnsSchema.safeParse(dup).success).toBe(false);
  });
});
